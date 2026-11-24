import { describe, expect, it } from 'vitest';
import { refine, searchProducts, significantWords } from '../../src/lib/catalog/search';
import { fixtureCatalog, fixtureProducts } from '../helpers/fixture';

describe('fetchCandidates: which endpoint a search hits', () => {
  it('uses the category path when a category is given', async () => {
    const { catalog, urls } = fixtureCatalog();
    const result = await searchProducts(catalog, { category: 'laptops' });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^\/products\/category\/laptops\?limit=0&select=/);
    expect(result.products.every((p) => p.category === 'laptops')).toBe(true);
    expect(result.match).toBe('exact');
  });

  it('uses the search endpoint for a text query', async () => {
    const { catalog, urls } = fixtureCatalog();
    const result = await searchProducts(catalog, { query: 'lipstick' });
    expect(urls[0]).toMatch(/^\/products\/search\?q=lipstick&limit=0/);
    expect(result.products.map((p) => p.title)).toContain('Red Lipstick');
  });

  it('lists the whole catalog when neither is given', async () => {
    const { catalog, urls } = fixtureCatalog();
    const result = await searchProducts(catalog, { sortBy: 'price', order: 'asc', limit: 3 });
    expect(urls[0]).toMatch(/^\/products\?limit=0/);
    expect(result.total).toBe(fixtureProducts.length);
    expect(result.products).toHaveLength(3);
  });

  it('intersects category and query locally, with one API call', async () => {
    const { catalog, urls } = fixtureCatalog();
    const result = await searchProducts(catalog, { category: 'smartphones', query: 'iphone' });
    expect(urls).toHaveLength(1);
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products.every((p) => p.category === 'smartphones' && /iphone/i.test(p.title + p.description))).toBe(true);
  });
});

describe('multi-word queries against a literal search', () => {
  it('falls back to single words when the phrase matches nothing', async () => {
    const { catalog, urls } = fixtureCatalog();
    const result = await searchProducts(catalog, { query: 'cheap phone' });
    // phrase first, then one request per significant word ("cheap" is a stopword)
    expect(urls.map((u) => u.split('&')[0])).toEqual(['/products/search?q=cheap%20phone', '/products/search?q=phone']);
    expect(result.match).toBe('any-word');
    expect(result.matchedWords).toEqual(['phone']);
    expect(result.total).toBeGreaterThan(0);
  });

  it('ranks products matching more words first', async () => {
    const { catalog } = fixtureCatalog();
    const result = await searchProducts(catalog, { query: 'wireless charger apple pencil', limit: 20 });
    expect(result.match).toBe('any-word');
    const hits = (title: string, description: string) =>
      ['wireless', 'charger', 'apple', 'pencil'].filter((w) => `${title} ${description}`.toLowerCase().includes(w)).length;
    const counts = result.products.map((p) => hits(p.title, p.description));
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('reports no match without extra requests for a single unknown word', async () => {
    const { catalog, urls } = fixtureCatalog();
    const result = await searchProducts(catalog, { query: 'zeppelin' });
    expect(result).toMatchObject({ total: 0, match: 'none', products: [] });
    expect(urls).toHaveLength(1);
  });

  it('keeps only significant words', () => {
    expect(significantWords('The best cheap phone for my mom')).toEqual(['phone', 'mom']);
  });
});

describe('refine: what the API cannot do', () => {
  it('filters by price range before slicing', async () => {
    const { catalog } = fixtureCatalog();
    const result = await searchProducts(catalog, { category: 'smartphones', maxPrice: 300, limit: 3 });
    const expected = fixtureProducts.filter((p) => p.category === 'smartphones' && p.price <= 300);
    expect(result.total).toBe(expected.length);
    expect(result.products).toHaveLength(3);
    expect(result.products.every((p) => p.price <= 300)).toBe(true);
  });

  it('returns nothing when the budget excludes the whole category', async () => {
    const { catalog } = fixtureCatalog();
    const result = await searchProducts(catalog, { category: 'laptops', maxPrice: 1000 });
    expect(result).toMatchObject({ total: 0, match: 'none' });
  });

  it('sorts by price ascending and rating descending by default', () => {
    const byPrice = refine(fixtureProducts, { sortBy: 'price', limit: 20 }).products.map((p) => p.price);
    expect(byPrice).toEqual([...byPrice].sort((a, b) => a - b));
    const byRating = refine(fixtureProducts, { sortBy: 'rating', limit: 20 }).products.map((p) => p.rating ?? 0);
    expect(byRating).toEqual([...byRating].sort((a, b) => b - a));
  });

  it('clamps the limit', () => {
    expect(refine(fixtureProducts, { limit: 500 }).products).toHaveLength(20);
    expect(refine(fixtureProducts, {}).products).toHaveLength(10);
  });
});
