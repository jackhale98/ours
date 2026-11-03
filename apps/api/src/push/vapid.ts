// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Push-service allowlist and VAPID signing (RFC 8292).
 *
 * Adapted from mycelium-web (worker/src/push.ts, GPL-3.0-or-later, same
 * author; see ADR 0010).
 */
import { fromB64Url, toB64Url } from '../lib/crypto';

/** Browser push services; any other address is refused (no relaying elsewhere). */
const PUSH_SERVICES = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
];

export function isPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  try {
    const u = new URL(endpoint);
    return (
      u.protocol === 'https:' &&
      !u.port &&
      !u.username &&
      !u.password &&
      PUSH_SERVICES.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
    );
  } catch {
    return false;
  }
}

export interface VapidKeys {
  /** Base64url P-256 public key (uncompressed point), shared with browsers. */
  publicKey: string;
  /** Base64url private scalar `d` (a secret). */
  privateKey: string;
  /** Contact for push services: `mailto:…` or an https URL. */
  subject: string;
}

/** `Authorization: vapid t=<JWT>, k=<public key>` for a push to `endpoint`. */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  now: number,
): Promise<string> {
  const pub = fromB64Url(keys.publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: toB64Url(pub.slice(1, 33)),
      y: toB64Url(pub.slice(33, 65)),
      d: keys.privateKey,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const json = (o: object) => toB64Url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${json({ typ: 'JWT', alg: 'ES256' })}.${json({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: keys.subject,
  })}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(unsigned),
    ),
  );
  return `vapid t=${unsigned}.${toB64Url(signature)}, k=${keys.publicKey}`;
}
