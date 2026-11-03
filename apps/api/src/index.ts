// SPDX-License-Identifier: AGPL-3.0-or-later
import { createApp } from './app';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Reminder delivery arrives in phase 5.
  },
} satisfies ExportedHandler<Env>;
