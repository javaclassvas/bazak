import { readFileSync } from 'node:fs';
import { createCatalogClient, type CatalogClient } from '../../src/lib/catalog/client';
import { createFixtureFetch } from '../../src/lib/catalog/fixture';
import type { Product } from '../../src/lib/catalog/types';

// Resolved from the project root (where the test runner starts), so it also works in the jsdom
// environment, where `import.meta.url` is not a file URL.
export const fixtureProducts: Product[] = JSON.parse(readFileSync('evals/fixture/catalog.json', 'utf8')).products;

/** A real client over the pinned catalog, recording every URL it requests. */
export function fixtureCatalog(): { catalog: CatalogClient; urls: string[] } {
  const urls: string[] = [];
  const inner = createFixtureFetch(fixtureProducts);
  const fetch: typeof globalThis.fetch = (input, init) => {
    urls.push(String(input).replace('http://catalog.test', ''));
    return inner(input, init);
  };
  return { catalog: createCatalogClient({ baseUrl: 'http://catalog.test', fetch }), urls };
}
