import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCatalogClient } from '../../src/lib/catalog/client';
import { createFixtureFetch } from '../../src/lib/catalog/fixture';
import { CATEGORIES, productSchema, type Product } from '../../src/lib/catalog/types';

/**
 * Contract with the LIVE DummyJSON API. Everything else in the suite runs against a pinned copy and an
 * emulation of the API; this file is what tells us when either has drifted from the real thing.
 * Needs network, so it is not part of `npm test`.
 */
const BASE = 'https://dummyjson.com';
const live = createCatalogClient({ baseUrl: BASE });
const fixtureProducts: Product[] = JSON.parse(readFileSync('evals/fixture/catalog.json', 'utf8')).products;
const emulated = createCatalogClient({ baseUrl: 'http://fixture.local', fetch: createFixtureFetch(fixtureProducts) });
const ids = (list: Product[]) => list.map((p) => p.id).sort((a, b) => a - b);

describe('live DummyJSON matches what the code assumes', { timeout: 20_000 }, () => {
  it('has the categories we hardcode', async () => {
    const res = await fetch(`${BASE}/products/category-list`);
    expect([...(await res.json())].sort()).toEqual([...CATEGORIES].sort());
  });

  it('returns products that satisfy our schema, and `limit=0` returns all of them', async () => {
    const all = await live.all();
    expect(all.length).toBeGreaterThan(100);
    for (const p of all) expect(productSchema.safeParse(p).success).toBe(true);
    const { total } = await (await fetch(`${BASE}/products?limit=1`)).json();
    expect(all).toHaveLength(total);
  });

  it('searches by literal substring over title and description', async () => {
    expect(await live.search('cheap phone')).toEqual([]); // no phrase match, although phones exist
    const phones = await live.search('phone');
    expect(phones.length).toBeGreaterThan(0);
    for (const p of phones) expect(`${p.title} ${p.description}`.toLowerCase()).toContain('phone');
    // Does not look at the category field: searching a slug is not a category query.
    const bySlug = await live.search('smartphones');
    const inCategory = await live.byCategory('smartphones');
    expect(bySlug.length).toBeLessThan(inCategory.length);
  });

  it('answers an unknown category with an empty list and an unknown id with 404', async () => {
    expect(await live.byCategory('flights')).toEqual([]);
    expect(await live.byId(999_999)).toBeNull();
  });
});

describe('the pinned fixture and the emulated API still mirror the live catalog', { timeout: 20_000 }, () => {
  it('has the same products, prices and titles', async () => {
    const all = await live.all();
    expect(ids(all)).toEqual(ids(fixtureProducts));
    const byId = new Map(fixtureProducts.map((p) => [p.id, p]));
    const drifted = all.filter((p) => byId.get(p.id)?.price !== p.price || byId.get(p.id)?.title !== p.title).map((p) => p.id);
    expect(drifted).toEqual([]);
  });

  it.each(['phone', 'apple', 'wireless', 'red lipstick', 'zeppelin'])('emulated search for "%s" returns what the live API returns', async (q) => {
    expect(ids(await emulated.search(q))).toEqual(ids(await live.search(q)));
  });

  it.each(['laptops', 'womens-dresses', 'flights'])('emulated category "%s" returns what the live API returns', async (slug) => {
    expect(ids(await emulated.byCategory(slug))).toEqual(ids(await live.byCategory(slug)));
  });
});
