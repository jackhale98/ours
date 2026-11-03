// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineProject } from 'vitest/config';

export default defineProject({
  // Unit tests run as a demo-only build (no API).
  define: { __API_URL__: JSON.stringify(''), __TURNSTILE_SITE_KEY__: JSON.stringify('') },
  test: {
    name: 'web',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
});
