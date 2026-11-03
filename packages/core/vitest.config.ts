// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'core',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
