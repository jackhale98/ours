// SPDX-License-Identifier: AGPL-3.0-or-later
export interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
  ALLOW_SIGNUPS: 'open' | 'invite_only' | 'closed';
}
