// SPDX-License-Identifier: AGPL-3.0-or-later
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('../src/index');
  }
  interface Env {
    DB: D1Database;
    ALLOWED_ORIGINS: string;
    ALLOW_SIGNUPS: 'open' | 'invite_only' | 'closed';
    TEST_MIGRATIONS: import('@cloudflare/vitest-plugin').D1Migration[];
  }
}
