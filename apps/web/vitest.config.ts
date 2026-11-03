// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'web',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
});
