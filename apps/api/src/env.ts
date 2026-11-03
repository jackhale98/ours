// SPDX-License-Identifier: AGPL-3.0-or-later
/** Worker bindings and configuration (wrangler.jsonc vars + secrets). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  /** Comma-separated web origins allowed by CORS (and accepted for passkeys). */
  ALLOWED_ORIGINS: string;
  /** open | invite_only | closed. Partners with an invite can always join. */
  ALLOW_SIGNUPS: 'open' | 'invite_only' | 'closed';
  /** Public URL of the web app, used in magic links, e.g. https://you.github.io/ours/ */
  APP_URL?: string;
  /** WebAuthn relying party id (the web app's hostname) and display name. */
  RP_ID?: string;
  RP_NAME?: string;
  /** Cloudflare Turnstile secret. When unset, bot checks are skipped (local dev, tests). */
  TURNSTILE_SECRET?: string;
  /** Email: 'log' (dev; nothing sent) or 'resend'. */
  /** 'dev-outbox' is for local end-to-end tests only. */
  EMAIL_PROVIDER?: 'log' | 'resend' | 'dev-outbox';
  EMAIL_FROM?: string;
  EMAIL_API_KEY?: string;
  /** Secret salt for hashing rate-limit keys (IPs, addresses) before storage. */
  RATE_LIMIT_SALT?: string;
  /** Optional Workers Rate Limiting bindings; a D1 counter is used when absent. */
  RL_AUTH?: RateLimitBinding;
  /** Quotas (strings because they come from vars). */
  MAX_SPACES_PER_USER?: string;
  MAX_DEVICES_PER_USER?: string;
  MAX_SPACE_BYTES?: string;
  MAX_PUSHES_PER_MINUTE?: string;
}

export const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
