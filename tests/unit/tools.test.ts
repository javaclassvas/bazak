import { describe, expect, it, vi } from 'vitest';
import { createCatalogClient } from '../../src/lib/catalog/client';
import {
  collectAllowedIds,
  createTools,
  createToolState,
  MAX_SHOWN,
  sanitizeReason,
  type ShowProductsOutput,
} from '../../src/lib/agent/tools';
import { fixtureCatalog, fixtureProducts } from '../helpers/fixture';

const ctx = { toolCallId: 'call-1', messages: [] } as never;

function setup(allowed: number[] = []) {
  const { catalog, urls } = fixtureCatalog();
  const state = createToolState(allowed);
  const tools = createTools(catalog, state);
  const search = (input: Parameters<NonNullable<typeof tools.search_products.execute>>[0]) =>
    tools.search_products.execute!(input, ctx) as unknown as Promise<Record<string, unknown> & { ok: boolean }>;
  const show = (items: { id: number; reason?: string }[], title?: string) =>
    tools.show_products.execute!({ items, title }, ctx) as unknown as Promise<ShowProductsOutput>;
  return { tools, state, urls, search, show };
}

describe('show_products allowlist', () => {
  it('refuses ids that no search returned', async () => {
    const { show, urls } = setup();
    const out = await show([{ id: 1 }, { id: 2 }]);
    expect(out.products).toEqual([]);
    expect(out.dropped).toEqual([1, 2]);
    expect(urls).toEqual([]); // not even looked up
  });

  it('shows ids returned by a search in this request, without another API call', async () => {
    const { search, show, urls } = setup();
    await search({ category: 'laptops' });
    const laptop = fixtureProducts.find((p) => p.category === 'laptops')!;
    const out = await show([{ id: laptop.id, reason: 'Light and fast' }], 'Laptops');
    expect(urls).toHaveLength(1);
    expect(out.title).toBe('Laptops');
    expect(out.products[0]).toMatchObject({
      id: laptop.id,
      title: laptop.title,
      price: laptop.price,
      thumbnail: laptop.thumbnail,
      reason: 'Light and fast',
    });
  });

  it('fetches by id for products allowed by an earlier turn', async () => {
    const { show, urls } = setup([5]);
    const out = await show([{ id: 5 }]);
    expect(urls[0]).toMatch(/^\/products\/5\?select=/);
    expect(out.products[0].title).toBe(fixtureProducts.find((p) => p.id === 5)!.title);
  });

  it('drops an allowed id that no longer exists', async () => {
    const { show } = setup([999_999]);
    expect(await show([{ id: 999_999 }])).toMatchObject({ products: [], dropped: [999_999] });
  });

  it('removes duplicates and caps the number of cards', async () => {
    const ids = fixtureProducts.slice(0, 30).map((p) => p.id);
    const { show } = setup(ids);
    const out = await show([{ id: ids[0] }, ...ids.map((id) => ({ id }))]);
    expect(out.products.map((p) => p.id)).toEqual(ids.slice(0, MAX_SHOWN));
    expect(out.dropped).toEqual(ids.slice(MAX_SHOWN));
  });

  it('sends the model a compact acknowledgement, not the cards', async () => {
    const { tools, show } = setup([1]);
    const output = await show([{ id: 1 }, { id: 2 }]);
    const forModel = await tools.show_products.toModelOutput!({ toolCallId: 'c', input: { items: [] }, output });
    expect(forModel).toMatchObject({ type: 'json', value: { shown: [1], dropped: [2] } });
    expect(JSON.stringify(forModel)).not.toContain('thumbnail');
  });
});

describe('search_products', () => {
  it('adds returned ids to the allowlist and returns compact candidates', async () => {
    const { search, state } = setup();
    const out = (await search({ category: 'tablets' })) as { ok: true; products: { id: number }[]; total: number };
    expect(out.ok).toBe(true);
    expect(out.total).toBe(out.products.length);
    expect(out.products.every((p) => state.allowedIds.has(p.id))).toBe(true);
    expect(out.products[0]).not.toHaveProperty('thumbnail');
  });

  it('explains an empty result so the model can retry differently', async () => {
    const { search } = setup();
    expect(await search({ query: 'zeppelin' })).toMatchObject({ ok: true, total: 0, match: 'none', note: expect.stringContaining('literal') });
  });

  it('turns a catalog outage into a result the model can read, not an exception', async () => {
    const catalog = createCatalogClient({ baseUrl: 'http://x', retries: 0, fetch: vi.fn().mockRejectedValue(new TypeError('down')) });
    const tools = createTools(catalog);
    expect(await tools.search_products.execute!({ query: 'phone' }, ctx)).toMatchObject({ ok: false, error: 'catalog_unavailable' });
  });
});

describe('reason text', () => {
  it('drops reasons that mention money or discounts', () => {
    expect(sanitizeReason('Only $9.99')).toBeNull();
    expect(sanitizeReason('20% off this week')).toBeNull();
    expect(sanitizeReason('costs 15 dollars')).toBeNull();
  });

  it('keeps ordinary reasons, including ones with numbers', () => {
    expect(sanitizeReason('  14-inch screen, light  ')).toBe('14-inch screen, light');
    expect(sanitizeReason('')).toBeNull();
    expect(sanitizeReason('x'.repeat(300))!.length).toBe(120);
  });
});

describe('collectAllowedIds', () => {
  it('collects ids from stored search and show outputs only', () => {
    const ids = collectAllowedIds([
      { parts: [{ type: 'text', text: 'product 77' }] },
      {
        parts: [
          { type: 'tool-search_products', state: 'output-available', output: { ok: true, products: [{ id: 3 }, { id: 4 }] } },
          { type: 'tool-show_products', state: 'output-available', output: { products: [{ id: 4 }] } },
          { type: 'tool-search_products', state: 'input-available', output: { products: [{ id: 9 }] } },
          { type: 'tool-other', state: 'output-available', output: { products: [{ id: 10 }] } },
        ],
      },
    ]);
    expect([...ids].sort()).toEqual([3, 4]);
  });
});
