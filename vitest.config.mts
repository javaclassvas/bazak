import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit and integration tests: no network, no API key. The live-API contract test runs separately.
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/components/**/*.test.tsx'],
  },
});
