import { defineConfig, devices } from '@playwright/test';

const APP_PORT = 3100;
const STUB_PORT = 4010;

/**
 * End-to-end: a real browser against the real Next.js server, real SQLite and the real tool loop.
 * Two things are replaced so the run is deterministic and needs neither key nor network:
 * the model (MOCK_LLM=1, a scripted stand-in) and the catalog (a local stub over the pinned fixture).
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${APP_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx e2e/stub-catalog.ts',
      url: `http://localhost:${STUB_PORT}/health`,
      env: { STUB_PORT: String(STUB_PORT) },
      reuseExistingServer: false,
    },
    {
      // A separate build directory and database, so this never collides with `npm run dev`.
      command: `rm -f data/e2e.db data/e2e.db-wal data/e2e.db-shm && npx next dev -p ${APP_PORT}`,
      url: `http://localhost:${APP_PORT}/api/conversations`,
      env: {
        MOCK_LLM: '1',
        CATALOG_BASE_URL: `http://localhost:${STUB_PORT}`,
        DATABASE_PATH: 'data/e2e.db',
        NEXT_DIST_DIR: '.next-e2e',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
