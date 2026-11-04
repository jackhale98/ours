// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineProject } from 'vitest/config';

export default defineProject({
  // Unit tests run as a demo-only build (no API).
  define: {
    __API_URL__: JSON.stringify(''),
    __TURNSTILE_SITE_KEY__: JSON.stringify(''),
    __BUILD__: JSON.stringify({ commit: 'test', date: '2026-01-01' }),
  },
  test: {
    name: 'web',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
});
