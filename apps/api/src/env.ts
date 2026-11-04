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
  /** Key rotation (ADR 0013): allowed only when 'on'. */
  ROTATION?: string;
  /** Passkey unlock (ADR 0015): allowed only when 'on'. */
  PASSKEY_UNLOCK?: string;
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
  /** Sign-in emails per client network an hour (default 10; raised only for local tests). */
  EMAIL_START_PER_IP?: string;
  MAX_DEVICES_PER_USER?: string;
  MAX_SPACE_BYTES?: string;
  MAX_PUSHES_PER_MINUTE?: string;
  /** Notifications a user may send per hour (default 60). */
  MAX_PUSHES_PER_HOUR?: string;
  /** Inactive accounts: warn after this many days without activity, delete this many days later. */
  INACTIVE_WARN_DAYS?: string;
  INACTIVE_GRACE_DAYS?: string;
  /** Web Push (VAPID, RFC 8292). Without both keys, notifications are off. */
  VAPID_PUBLIC_KEY?: string;
  /** Secret: `wrangler secret put VAPID_PRIVATE_KEY`. */
  VAPID_PRIVATE_KEY?: string;
  /** Contact for push services, `mailto:` or https URL (defaults to APP_URL). */
  VAPID_SUBJECT?: string;
}

export const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
