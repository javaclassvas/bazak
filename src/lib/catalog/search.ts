import type { CatalogClient } from './client';
import type { Category, Product } from './types';

export type SearchInput = {
  query?: string;
  category?: Category;
  minPrice?: number;
  maxPrice?: number;
  sortBy?: 'price' | 'rating' | 'title';
  order?: 'asc' | 'desc';
  limit?: number;
};

export type SearchResult = {
  products: Product[];
  /** Matches after filtering, before the `limit` slice. */
  total: number;
  /**
   * `exact`    — the query (or no query) matched as given.
   * `any-word` — the phrase matched nothing, so we fell back to its individual words.
   * `none`     — nothing matched at all.
   */
  match: 'exact' | 'any-word' | 'none';
  matchedWords?: string[];
};

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 20;
const MAX_WORDS = 4;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'some', 'any', 'under', 'over',
  'cheap', 'best', 'good', 'nice', 'cool', 'new', 'top', 'buy', 'want', 'need', 'show',
]);

/** Words worth searching for on their own when the whole phrase matched nothing. */
export function significantWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, MAX_WORDS);
}

const haystack = (p: Product) => `${p.title} ${p.description}`.toLowerCase();

type Candidates = Pick<SearchResult, 'match' | 'matchedWords'> & { products: Product[] };

/** Rank products by how many of the words they contain; drop those containing none. */
function rankByWords(products: Product[], words: string[]): Candidates {
  const scored = products
    .map((p) => ({ p, hits: words.filter((w) => haystack(p).includes(w)) }))
    .filter((s) => s.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length);
  if (scored.length === 0) return { products: [], match: 'none' };
  return {
    products: scored.map((s) => s.p),
    match: 'any-word',
    matchedWords: [...new Set(scored.flatMap((s) => s.hits))],
  };
}

/**
 * Step 1: ask the API for a candidate set.
 *
 * The API decides candidates by category path or by its substring search. Its search is literal
 * ("cheap phone" matches nothing), so a multi-word query that finds nothing is retried word by word.
 */
export async function fetchCandidates(client: CatalogClient, input: SearchInput): Promise<Candidates> {
  const query = input.query?.trim();

  if (input.category) {
    const inCategory = await client.byCategory(input.category);
    if (!query) return { products: inCategory, match: inCategory.length ? 'exact' : 'none' };
    // The API cannot combine a category with a text query, so the intersection is ours.
    const phrase = inCategory.filter((p) => haystack(p).includes(query.toLowerCase()));
    if (phrase.length) return { products: phrase, match: 'exact' };
    return rankByWords(inCategory, significantWords(query));
  }

  if (query) {
    const phrase = await client.search(query);
    if (phrase.length) return { products: phrase, match: 'exact' };
    const words = significantWords(query);
    if (words.length < 2 && words[0] === query.toLowerCase()) return { products: [], match: 'none' };
    const perWord = await Promise.all(words.map((w) => client.search(w)));
    const merged = new Map<number, Product>();
    for (const list of perWord) for (const p of list) merged.set(p.id, p);
    return rankByWords([...merged.values()], words);
  }

  const all = await client.all();
  return { products: all, match: all.length ? 'exact' : 'none' };
}

/** Step 2: everything the API cannot do — price range, ordering, slicing. Pure function. */
export function refine(candidates: Product[], input: SearchInput): { products: Product[]; total: number } {
  let products = candidates;
  if (input.minPrice != null) products = products.filter((p) => p.price >= input.minPrice!);
  if (input.maxPrice != null) products = products.filter((p) => p.price <= input.maxPrice!);

  if (input.sortBy) {
    const dir = (input.order ?? (input.sortBy === 'rating' ? 'desc' : 'asc')) === 'asc' ? 1 : -1;
    const key = input.sortBy;
    products = [...products].sort((a, b) =>
      key === 'title' ? dir * a.title.localeCompare(b.title) : dir * ((a[key] ?? 0) - (b[key] ?? 0)),
    );
  }

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return { products: products.slice(0, limit), total: products.length };
}

export async function searchProducts(client: CatalogClient, input: SearchInput): Promise<SearchResult> {
  const candidates = await fetchCandidates(client, input);
  const refined = refine(candidates.products, input);
  return {
    ...refined,
    match: refined.total === 0 ? 'none' : candidates.match,
    matchedWords: refined.total === 0 ? undefined : candidates.matchedWords,
  };
}
