import { tool, type InferUITools, type UIDataTypes, type UIMessage } from 'ai';
import { z } from 'zod';
import { CatalogError, type CatalogClient } from '../catalog/client';
import { MAX_LIMIT, searchProducts } from '../catalog/search';
import { CATEGORIES, type Product } from '../catalog/types';

export const MAX_SHOWN = 8;
const MAX_REASON_LENGTH = 120;
/** A `reason` must not carry prices or discounts: those come from the catalog, never from the model. */
const MONEY_PATTERN = /[$€£¥₽]|\d\s*%|\b(usd|eur|dollars?|bucks)\b/i;

/** What the model sees for each search hit. Deliberately small: enough to choose, not enough to render. */
const candidateSchema = z.object({
  id: z.number(),
  title: z.string(),
  price: z.number(),
  rating: z.number().nullable(),
  category: z.string(),
  brand: z.string().nullable(),
  availability: z.string().nullable(),
  description: z.string(),
});

const searchOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    total: z.number(),
    match: z.enum(['exact', 'any-word', 'none']),
    products: z.array(candidateSchema),
    note: z.string().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.literal('catalog_unavailable'), message: z.string() }),
]);

/** What the UI renders. Every field except `reason` is copied from the catalog. */
export const cardSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  price: z.number(),
  discountPercentage: z.number().nullable(),
  rating: z.number().nullable(),
  brand: z.string().nullable(),
  availability: z.string().nullable(),
  thumbnail: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ProductCard = z.infer<typeof cardSchema>;

export const showOutputSchema = z.object({
  title: z.string().nullable(),
  products: z.array(cardSchema),
  /** Ids the model asked for that were refused: never returned by a search here, or gone from the catalog. */
  dropped: z.array(z.number()),
  error: z.string().optional(),
});
export type ShowProductsOutput = z.infer<typeof showOutputSchema>;

function toCard(p: Product, reason: string | null): ProductCard {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category,
    price: p.price,
    discountPercentage: p.discountPercentage ?? null,
    rating: p.rating ?? null,
    brand: p.brand ?? null,
    availability: p.availabilityStatus ?? null,
    thumbnail: p.thumbnail ?? null,
    reason,
  };
}

export function sanitizeReason(reason: string | undefined): string | null {
  const text = reason?.trim();
  if (!text || MONEY_PATTERN.test(text)) return null;
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}

export type ToolState = {
  /** Ids a search has returned in this conversation. `show_products` refuses anything else. */
  allowedIds: Set<number>;
  /** Full products seen during this request, so showing them costs no extra API call. */
  seen: Map<number, Product>;
};

export function createToolState(allowedIds: Iterable<number> = []): ToolState {
  return { allowedIds: new Set(allowedIds), seen: new Map() };
}

export function createTools(catalog: CatalogClient, state: ToolState = createToolState()) {
  return {
    search_products: tool({
      description:
        'Find candidate products in the catalog. The user does NOT see these results. ' +
        '`query` is a literal substring match on title and description: use one or two concrete words ("lipstick", "running shoes"), never adjectives like "cheap" or "cool". ' +
        'Prefer `category` whenever the request maps to a catalog category, and use the price and sort fields for budgets and rankings. ' +
        'Call it several times in parallel when the user asks for several different things.',
      inputSchema: z.object({
        query: z.string().optional().describe('Concrete keyword(s) to look for in title/description'),
        category: z.enum(CATEGORIES).optional(),
        minPrice: z.number().optional().describe('Lower price bound, USD'),
        maxPrice: z.number().optional().describe('Upper price bound, USD'),
        sortBy: z.enum(['price', 'rating', 'title']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      }),
      outputSchema: searchOutputSchema,
      execute: async (input) => {
        try {
          const result = await searchProducts(catalog, input);
          for (const p of result.products) {
            state.allowedIds.add(p.id);
            state.seen.set(p.id, p);
          }
          const note =
            result.match === 'none'
              ? 'No match. The text search is literal: retry with a single concrete keyword, a category, or a wider price range.'
              : result.match === 'any-word'
                ? `No product contains the whole phrase. These contain at least one of: ${result.matchedWords?.join(', ')}. Check relevance before showing.`
                : undefined;
          return {
            ok: true as const,
            total: result.total,
            match: result.match,
            products: result.products.map((p) => ({
              id: p.id,
              title: p.title,
              price: p.price,
              rating: p.rating ?? null,
              category: p.category,
              brand: p.brand ?? null,
              availability: p.availabilityStatus ?? null,
              description: p.description.slice(0, 140),
            })),
            ...(note ? { note } : {}),
          };
        } catch (err) {
          if (!(err instanceof CatalogError)) throw err;
          return {
            ok: false as const,
            error: 'catalog_unavailable' as const,
            message: 'The product catalog cannot be reached right now. Tell the user and do not name any products.',
          };
        }
      },
    }),

    show_products: tool({
      description:
        `Display product cards to the user. This is the only way the user sees products. Pass ids returned by search_products in this conversation, best match first, at most ${MAX_SHOWN}. ` +
        'Use one call per distinct thing the user asked for, each with its own short `title`. ' +
        '`reason` is an optional few words on why the item fits; never put prices or discounts in it.',
      inputSchema: z.object({
        title: z.string().max(80).optional().describe('Short heading for this group of cards'),
        items: z
          .array(z.object({ id: z.number().int(), reason: z.string().optional() }))
          .min(1),
      }),
      outputSchema: showOutputSchema,
      execute: async ({ title, items }): Promise<ShowProductsOutput> => {
        const products: ProductCard[] = [];
        const dropped: number[] = [];
        const taken = new Set<number>();

        for (const item of items) {
          if (taken.has(item.id)) continue; // duplicate
          taken.add(item.id);
          if (!state.allowedIds.has(item.id) || products.length >= MAX_SHOWN) {
            dropped.push(item.id);
            continue;
          }
          try {
            // Ids from earlier turns are allowed but not in this request's cache: fetch those by id.
            const product = state.seen.get(item.id) ?? (await catalog.byId(item.id));
            if (!product) {
              dropped.push(item.id);
              continue;
            }
            state.seen.set(product.id, product);
            products.push(toCard(product, sanitizeReason(item.reason)));
          } catch (err) {
            if (!(err instanceof CatalogError)) throw err;
            return { title: title ?? null, products, dropped, error: 'catalog_unavailable' };
          }
        }
        return { title: title ?? null, products, dropped };
      },
      // The UI needs the full cards; the model only needs to know what was accepted.
      toModelOutput: ({ output }) => ({
        type: 'json',
        value: {
          shown: output.products.map((p) => p.id),
          dropped: output.dropped,
          ...(output.dropped.length
            ? { note: 'Dropped ids were not returned by a search in this conversation, exceeded the limit, or no longer exist.' }
            : {}),
          ...(output.error ? { error: output.error } : {}),
        },
      }),
    }),
  };
}

export type CopilotTools = ReturnType<typeof createTools>;
export type CopilotUIMessage = UIMessage<never, UIDataTypes, InferUITools<CopilotTools>>;

/**
 * Rebuild the allowlist from stored history: every id a search returned, or that was already shown.
 * Reads loosely on purpose — it runs before validation, on whatever the database holds.
 */
export function collectAllowedIds(messages: readonly { parts?: readonly unknown[] }[]): Set<number> {
  const ids = new Set<number>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const p = part as { type?: string; state?: string; output?: { products?: { id?: unknown }[] } };
      if (p.state !== 'output-available') continue;
      if (p.type !== 'tool-search_products' && p.type !== 'tool-show_products') continue;
      for (const product of p.output?.products ?? []) {
        if (typeof product?.id === 'number') ids.add(product.id);
      }
    }
  }
  return ids;
}
