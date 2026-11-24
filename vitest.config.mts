import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `npm test` runs everything that needs neither network nor API key.
// `npm run test:contract` runs only the checks against the live catalog API.
const contract = process.env.CONTRACT === '1';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: contract
      ? ['tests/contract/**/*.test.ts']
      : ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/components/**/*.test.tsx'],
  },
});
