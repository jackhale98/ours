// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          ALLOWED_ORIGINS: 'https://app.example',
          ALLOW_SIGNUPS: 'open',
          RP_ID: 'app.example',
          MAX_SPACE_BYTES: '200000',
          // Test-only VAPID key pair (never used outside tests).
          VAPID_PUBLIC_KEY:
            'BGeytqcryzLQx3zBK5A7_loabsm6Ix96hNmpqoGtFaiLEweHpaAbiP4axcF84pAgikzuk8jCvr74j3Mn-j0jM1k',
          VAPID_PRIVATE_KEY: 'ongJxsqwXoRhxS8gJTJ8L8GXL0d6On19rO70dERTb0I',
        },
      },
    })),
  ],
  test: {
    name: 'api',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
