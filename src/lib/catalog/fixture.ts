import type { Product } from './types';

/**
 * A `fetch` that answers DummyJSON product routes from an in-memory list.
 *
 * It reproduces the API behaviour we rely on — substring search over title + description, empty list
 * for an unknown category, 404 for an unknown id — so unit tests, evals and the e2e stub run against a
 * pinned catalog. `tests/contract` checks these same behaviours against the live API.
 */
export function createFixtureFetch(products: Product[]): typeof fetch {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const page = (list: Product[]) => json({ products: list, total: list.length, skip: 0, limit: list.length });

  return async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/\/$/, '');

    if (path === '/products') return page(products);

    if (path === '/products/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return page(products.filter((p) => `${p.title} ${p.description}`.toLowerCase().includes(q)));
    }

    const category = path.match(/^\/products\/category\/([^/]+)$/);
    if (category) return page(products.filter((p) => p.category === decodeURIComponent(category[1])));

    const byId = path.match(/^\/products\/(\d+)$/);
    if (byId) {
      const product = products.find((p) => p.id === Number(byId[1]));
      return product ? json(product) : json({ message: `Product with id '${byId[1]}' not found` }, 404);
    }

    return json({ message: 'not found' }, 404);
  };
}
