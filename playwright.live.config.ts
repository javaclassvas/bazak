import { defineConfig, devices } from '@playwright/test';

const APP_PORT = 3200;

/**
 * The one run where nothing is replaced: a real browser, the real server and database code,
 * the real model and the live catalog API.
 *
 * It costs API calls and is not deterministic, so it is run by hand (`npm run e2e:live`) and is not
 * part of `npm run check`. Its assertions are properties that must hold whatever the model says.
 */
export default defineConfig({
  testDir: 'e2e/live',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 45_000 },
  use: { baseURL: `http://localhost:${APP_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The key comes from .env.local, which Next.js loads itself. MOCK_LLM is cleared explicitly.
    command: `rm -f data/e2e-live.db data/e2e-live.db-wal data/e2e-live.db-shm && npx next dev -p ${APP_PORT}`,
    url: `http://localhost:${APP_PORT}/api/conversations`,
    env: { MOCK_LLM: '', DATABASE_PATH: 'data/e2e-live.db', NEXT_DIST_DIR: '.next-e2e-live' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
