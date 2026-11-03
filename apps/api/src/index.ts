// SPDX-License-Identifier: AGPL-3.0-or-later
import { cleanup, createApp } from './app';
import type { Env } from './env';
import { sendDue } from './push/send';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Every minute: reminders and notifications held for quiet hours. Hourly: housekeeping.
    ctx.waitUntil(sendDue(env, controller.scheduledTime));
    if (new Date(controller.scheduledTime).getUTCMinutes() === 0) ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
