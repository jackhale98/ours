// SPDX-License-Identifier: AGPL-3.0-or-later
import { cleanup, createApp } from './app';
import type { Env } from './env';
import { inactiveAccounts } from './lib/accounts';
import { sendDue } from './push/send';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Every minute: reminders and notifications held for quiet hours. Hourly: housekeeping.
    ctx.waitUntil(sendDue(env, controller.scheduledTime));
    const at = new Date(controller.scheduledTime);
    if (at.getUTCMinutes() === 0) ctx.waitUntil(cleanup(env));
    // Daily, 03:17 UTC: the inactive-account policy.
    if (at.getUTCHours() === 3 && at.getUTCMinutes() === 17)
      ctx.waitUntil(inactiveAccounts(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
