// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * End-to-end tests against a real local API (wrangler dev, local D1) and a
 * web build pointed at it. Magic links are read from the API's dev-only outbox.
 */
import { defineConfig, devices } from '@playwright/test';

const API = 'http://localhost:8788';
const WEB = 'http://localhost:4174';
const STATE = '.wrangler/state/e2e';
// Test-only VAPID key pair (same as the Worker unit tests; never used elsewhere).
const VAPID_PUBLIC =
  'BGeytqcryzLQx3zBK5A7_loabsm6Ix96hNmpqoGtFaiLEweHpaAbiP4axcF84pAgikzuk8jCvr74j3Mn-j0jM1k';
const VAPID_PRIVATE = 'ongJxsqwXoRhxS8gJTJ8L8GXL0d6On19rO70dERTb0I';

export default defineConfig({
  testDir: 'e2e-sync',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-sync' }]]
    : 'list',
  use: { baseURL: WEB, trace: 'retain-on-failure' },
  webServer: [
    {
      cwd: '../api',
      command: [
        `rm -rf ${STATE}`,
        `npx wrangler d1 migrations apply ours --local --persist-to ${STATE}`,
        `npx wrangler dev --port 8788 --local --persist-to ${STATE} --var EMAIL_PROVIDER:dev-outbox --var EMAIL_START_PER_IP:50 --var ALLOWED_ORIGINS:${WEB} --var APP_URL:${WEB}/ --var RP_ID:localhost --var VAPID_PUBLIC_KEY:${VAPID_PUBLIC} --var VAPID_PRIVATE_KEY:${VAPID_PRIVATE}`,
      ].join(' && '),
      url: `${API}/health`,
      env: { WRANGLER_SEND_METRICS: 'false', CI: '1' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        'npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 4174 --strictPort',
      env: { VITE_API_URL: API },
      url: WEB,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  // Full Chromium (new headless): the headless shell blocks notifications.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
});
