import { PRODUCT_FIELDS, productListSchema, productSchema, type Product } from './types';

export type CatalogErrorKind = 'timeout' | 'network' | 'http' | 'invalid';

/** Every way the catalog can fail, as one typed error the tools can turn into a message for the model. */
export class CatalogError extends Error {
  constructor(
    readonly kind: CatalogErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** The only four things we ask of the catalog. Tests and evals swap the transport, not this interface. */
export interface CatalogClient {
  /** `/products/search?q=` — literal, case-insensitive substring match on title + description. */
  search(q: string): Promise<Product[]>;
  /** `/products/category/{slug}` — an unknown slug yields an empty list, not an error. */
  byCategory(slug: string): Promise<Product[]>;
  /** `/products` — the whole catalog. */
  all(): Promise<Product[]>;
  /** `/products/{id}` — `null` when the product does not exist. */
  byId(id: number): Promise<Product | null>;
}

export type CatalogClientOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts after a timeout, network error or 5xx. 4xx is never retried. */
  retries?: number;
};

// `limit=0` returns every match: price filtering happens on our side, so the API must not truncate first.
const LIST_QUERY = `limit=0&select=${PRODUCT_FIELDS.join(',')}`;

export function createCatalogClient(options: CatalogClientOptions = {}): CatalogClient {
  const baseUrl = (options.baseUrl ?? process.env.CATALOG_BASE_URL ?? 'https://dummyjson.com').replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const retries = options.retries ?? 1;

  async function attempt(path: string): Promise<Response> {
    try {
      return await doFetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new CatalogError('timeout', `catalog did not answer within ${timeoutMs} ms`);
      }
      throw new CatalogError('network', `catalog unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function get(path: string): Promise<Response> {
    let lastError: CatalogError | undefined;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await attempt(path);
        if (res.status < 500) return res;
        lastError = new CatalogError('http', `catalog responded ${res.status}`, res.status);
      } catch (err) {
        lastError = err as CatalogError;
      }
    }
    throw lastError!;
  }

  async function list(path: string): Promise<Product[]> {
    const res = await get(path);
    if (!res.ok) throw new CatalogError('http', `catalog responded ${res.status}`, res.status);
    const parsed = productListSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new CatalogError('invalid', 'catalog returned an unexpected payload');
    return parsed.data.products;
  }

  return {
    search: (q) => list(`/products/search?q=${encodeURIComponent(q)}&${LIST_QUERY}`),
    byCategory: (slug) => list(`/products/category/${encodeURIComponent(slug)}?${LIST_QUERY}`),
    all: () => list(`/products?${LIST_QUERY}`),
    async byId(id) {
      const res = await get(`/products/${id}?select=${PRODUCT_FIELDS.join(',')}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new CatalogError('http', `catalog responded ${res.status}`, res.status);
      const parsed = productSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new CatalogError('invalid', 'catalog returned an unexpected payload');
      return parsed.data;
    },
  };
}
