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
