// SPDX-License-Identifier: AGPL-3.0-or-later
import { cleanup, createApp } from './app';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Every minute: reminders (phase 5). Hourly: housekeeping.
    if (new Date(controller.scheduledTime).getUTCMinutes() === 0) ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
