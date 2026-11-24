import { describe, expect, it, vi } from 'vitest';
import { CatalogError, createCatalogClient } from '../../src/lib/catalog/client';
import { fixtureCatalog } from '../helpers/fixture';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('catalog client', () => {
  it('returns null for an unknown product id', async () => {
    const { catalog } = fixtureCatalog();
    expect(await catalog.byId(999_999)).toBeNull();
    expect((await catalog.byId(1))?.id).toBe(1);
  });

  it('returns an empty list for an unknown category', async () => {
    const { catalog } = fixtureCatalog();
    expect(await catalog.byCategory('flights')).toEqual([]);
  });

  it('retries once on a 5xx and then succeeds', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok({}, 503)).mockResolvedValueOnce(ok({ products: [] }));
    const catalog = createCatalogClient({ baseUrl: 'http://x', fetch });
    expect(await catalog.all()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up with a typed error after the retry', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({}, 500));
    const catalog = createCatalogClient({ baseUrl: 'http://x', fetch });
    await expect(catalog.all()).rejects.toMatchObject({ name: 'CatalogError', kind: 'http', status: 500 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('maps a network failure and a timeout to typed errors', async () => {
    const down = createCatalogClient({ baseUrl: 'http://x', retries: 0, fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')) });
    await expect(down.all()).rejects.toMatchObject({ kind: 'network' });

    const slow = createCatalogClient({
      baseUrl: 'http://x',
      retries: 0,
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))),
    });
    await expect(slow.all()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('rejects a payload that is not a product list', async () => {
    const catalog = createCatalogClient({ baseUrl: 'http://x', fetch: vi.fn().mockResolvedValue(ok({ oops: true })) });
    await expect(catalog.all()).rejects.toBeInstanceOf(CatalogError);
    await expect(catalog.all()).rejects.toMatchObject({ kind: 'invalid' });
  });
});
