// SPDX-License-Identifier: AGPL-3.0-or-later

import { env } from 'cloudflare:test';
import { openNotification, sealNotification } from '@ours/core/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromB64Url, toB64Url } from '../src/lib/crypto';
import { encryptPush, messageKeys } from '../src/push/encrypt';
import { quietUntil, sendDue } from '../src/push/send';
import { isPushEndpoint, vapidAuthorization } from '../src/push/vapid';
import { call, couple, signIn, uniqueEmail } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------- a fake browser: push subscription keys and RFC 8291 decryption ---------- */

async function browser() {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = `https://fcm.googleapis.com/fcm/send/${toB64Url(crypto.getRandomValues(new Uint8Array(12)))}`;
  return {
    endpoint,
    subscription: { endpoint, p256dh: toB64Url(pub), auth: toB64Url(auth) },
    /** What the browser does with an aes128gcm push body. */
    async decrypt(body: Uint8Array): Promise<Uint8Array> {
      const salt = body.slice(0, 16);
      const idlen = body[20] ?? 0;
      const asPublic = body.slice(21, 21 + idlen);
      const sender = await crypto.subtle.importKey(
        'raw',
        asPublic,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
      const ecdh = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'ECDH', public: sender } as SubtleCryptoDeriveKeyAlgorithm,
          keys.privateKey,
          256,
        ),
      );
      const { cek, nonce } = await messageKeys(ecdh, auth, pub, asPublic, salt);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)),
      );
      expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
      return plain.slice(0, -1);
    },
  };
}

interface Captured {
  url: string;
  headers: Headers;
  body: Uint8Array;
}

/** Intercepts the Worker's outgoing push requests. */
function capturePushes(status = 201) {
  const sent: Captured[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push({
      url: req.url,
      headers: req.headers,
      body: new Uint8Array(await req.arrayBuffer()),
    });
    return new Response(null, { status });
  });
  return sent;
}

async function until(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const SPACE_KEY = crypto.getRandomValues(new Uint8Array(32));

function sealed(
  spaceId: string,
  title: string,
  opts: { not_before?: number; recipient?: string; scope?: 'space' | 'user' } = {},
) {
  const to = { space_id: spaceId, scope: opts.scope ?? 'space', recipient: opts.recipient ?? 'u' };
  const s = sealNotification(SPACE_KEY, to, 1, {
    title,
    body: 'Friday 7 PM',
    ...(opts.not_before ? { not_before: opts.not_before } : {}),
  });
  return { nonce: toB64Url(s.nonce), ciphertext: toB64Url(s.ciphertext) };
}

/* ---------- vendored primitives ---------- */

describe('Web Push primitives (vendored from mycelium-web)', () => {
  it('encryptPush matches the RFC 8291 example', async () => {
    const V = {
      plaintext: 'When I grow up, I want to be a watermelon',
      asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      asPublic:
        'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      uaPublic:
        'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      salt: 'DGv6ra1nlYgDCS1FRnbzlw',
      result:
        'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    };
    const p = fromB64Url(V.asPublic);
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: toB64Url(p.slice(1, 33)),
      y: toB64Url(p.slice(33, 65)),
      d: V.asPrivate,
    };
    const alg = { name: 'ECDH', namedCurve: 'P-256' };
    const keys = {
      privateKey: await crypto.subtle.importKey('jwk', jwk, alg, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('raw', p, alg, true, []),
    };
    const out = await encryptPush(
      new TextEncoder().encode(V.plaintext),
      fromB64Url(V.uaPublic),
      fromB64Url(V.auth),
      { keys, salt: fromB64Url(V.salt) },
    );
    expect(toB64Url(out)).toBe(V.result);
  });

  it('accepts only browser push services over HTTPS', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isPushEndpoint('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(isPushEndpoint('https://user@fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint(42)).toBe(false);
  });

  it('signs a VAPID JWT that the public key verifies', async () => {
    const header = await vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/x',
      {
        publicKey: env.VAPID_PUBLIC_KEY as string,
        privateKey: env.VAPID_PRIVATE_KEY as string,
        subject: 'mailto:ops@example.com',
      },
      Date.now(),
    );
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m as RegExpExecArray;
    const claims = JSON.parse(new TextDecoder().decode(fromB64Url(c as string)));
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:ops@example.com');
    const pub = await crypto.subtle.importKey(
      'raw',
      fromB64Url(k as string),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      fromB64Url(sig as string),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });
});

describe('quiet hours', () => {
  const at = (iso: string) => Date.parse(iso);
  it('holds notifications inside the window, including across midnight', () => {
    const q = { start: 22 * 60, end: 7 * 60, tz: 'UTC' };
    expect(quietUntil(at('2026-11-03T23:30:00Z'), q)).toBe(at('2026-11-04T07:00:00Z'));
    expect(quietUntil(at('2026-11-04T06:59:00Z'), q)).toBe(at('2026-11-04T07:00:00Z'));
    expect(quietUntil(at('2026-11-04T07:00:00Z'), q)).toBeNull();
    expect(quietUntil(at('2026-11-03T21:59:00Z'), q)).toBeNull();
  });
  it('reads the window in the user’s zone', () => {
    const q = { start: 22 * 60, end: 7 * 60, tz: 'America/New_York' };
    // 03:30 UTC is 22:30 in New York (EST).
    expect(quietUntil(at('2026-11-04T03:30:00Z'), q)).toBe(at('2026-11-04T12:00:00Z'));
    expect(quietUntil(at('2026-11-04T13:00:00Z'), q)).toBeNull();
  });
  it('is off when unset or empty', () => {
    expect(quietUntil(Date.now(), { start: null, end: null, tz: null })).toBeNull();
    expect(quietUntil(Date.now(), { start: 60, end: 60, tz: 'UTC' })).toBeNull();
  });
});

/* ---------- routes ---------- */

describe('push routes', () => {
  it('hands out the VAPID public key and refuses non-push addresses', async () => {
    const u = await signIn(uniqueEmail());
    const cfg = await call('/push/config', { token: u.token });
    expect(cfg.json).toMatchObject({ key: env.VAPID_PUBLIC_KEY, subscribed: false, quiet: null });
    const b = await browser();
    const bad = await call('/push/subscription', {
      token: u.token,
      method: 'PUT',
      body: { ...b.subscription, endpoint: 'https://attacker.example/collect' },
    });
    expect(bad.status).toBe(422);
    const ok = await call('/push/subscription', {
      token: u.token,
      method: 'PUT',
      body: b.subscription,
    });
    expect(ok.status).toBe(200);
    expect((await call('/push/config', { token: u.token })).json.subscribed).toBe(true);
    await call('/push/subscription', { token: u.token, method: 'DELETE' });
    expect((await call('/push/config', { token: u.token })).json.subscribed).toBe(false);
  });

  it('delivers to the partner only opaque ciphertext that their device can open', async () => {
    const { sam, alex, spaceId } = await couple();
    const alexPhone = await browser();
    await call('/push/subscription', {
      token: alex.token,
      method: 'PUT',
      body: alexPhone.subscription,
    });
    const sent = capturePushes();
    const title = 'Sam asked: Dinner at Rosa’s';
    const res = await call('/push/notify', {
      token: sam.token,
      body: {
        space_id: spaceId,
        key_version: 1,
        to: 'partner',
        payload: sealed(spaceId, title, { recipient: alex.userId }),
      },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ queued: 1, deferred: 0 });
    await until(() => sent.length === 1);
    const push = sent[0] as Captured;
    expect(push.url).toBe(alexPhone.endpoint);
    expect(push.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(push.headers.get('Authorization')).toMatch(/^vapid t=.+, k=/);
    expect(push.headers.get('TTL')).toBe('86400');

    // The push service sees only RFC 8291 ciphertext.
    expect(new TextDecoder().decode(push.body)).not.toContain('Dinner');
    // After the browser removes that layer, the Worker's wrapper still holds
    // only the end-to-end ciphertext: no text, no record id.
    const wrapper = new TextDecoder().decode(await alexPhone.decrypt(push.body));
    expect(wrapper).not.toContain('Dinner');
    expect(wrapper).not.toContain('Friday');
    const w = JSON.parse(wrapper);
    expect(Object.keys(w).sort()).toEqual(['c', 'k', 'p', 's', 'v']);
    expect(w.c).toBe('s');
    expect(w.s).toBe(spaceId);
    // Alex's device, holding the space key, can read it.
    const bytes = fromB64Url(w.p);
    const opened = openNotification(
      SPACE_KEY,
      { space_id: spaceId, scope: 'space', recipient: alex.userId },
      w.k,
      { nonce: bytes.slice(0, 24), ciphertext: bytes.slice(24) },
      Date.now(),
      () => false,
    );
    expect(opened.status).toBe('show');
    if (opened.status === 'show') expect(opened.body.title).toBe(title);
  });

  it('refuses outsiders and malformed payloads', async () => {
    const { spaceId } = await couple();
    const stranger = await signIn(uniqueEmail());
    const res = await call('/push/notify', {
      token: stranger.token,
      body: { space_id: spaceId, key_version: 1, to: 'partner', payload: sealed(spaceId, 'x') },
    });
    expect(res.status).toBe(404);
    const { sam, spaceId: s2 } = await couple();
    const tooBig = await call('/push/notify', {
      token: sam.token,
      body: {
        space_id: s2,
        key_version: 1,
        to: 'partner',
        payload: { nonce: toB64Url(new Uint8Array(24)), ciphertext: 'A'.repeat(5000) },
      },
    });
    expect(tooBig.status).toBe(422);
  });

  it('holds notifications during quiet hours and sends them when they end', async () => {
    const { sam, alex, spaceId } = await couple();
    const phone = await browser();
    await call('/push/subscription', {
      token: alex.token,
      method: 'PUT',
      body: phone.subscription,
    });
    const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    await call('/push/quiet', {
      token: alex.token,
      method: 'PUT',
      body: { start: (nowMin + 1440 - 60) % 1440, end: (nowMin + 60) % 1440, tz: 'UTC' },
    });
    expect((await call('/push/config', { token: alex.token })).json.quiet).toMatchObject({
      tz: 'UTC',
    });
    const sent = capturePushes();
    const res = await call('/push/notify', {
      token: sam.token,
      body: { space_id: spaceId, key_version: 1, to: 'partner', payload: sealed(spaceId, 'Hi') },
    });
    expect(res.json).toEqual({ queued: 0, deferred: 1 });
    await sendDue(env, Date.now());
    expect(sent).toHaveLength(0);
    await sendDue(env, Date.now() + 61 * 60_000);
    expect(sent.filter((s) => s.url === phone.endpoint)).toHaveLength(1);
    // Sent once only.
    await sendDue(env, Date.now() + 62 * 60_000);
    expect(sent.filter((s) => s.url === phone.endpoint)).toHaveLength(1);
  });

  it('stores my reminders, replaces them, and sends each at its time to me only', async () => {
    const { sam, alex, spaceId } = await couple();
    const samPhone = await browser();
    const alexPhone = await browser();
    await call('/push/subscription', {
      token: sam.token,
      method: 'PUT',
      body: samPhone.subscription,
    });
    await call('/push/subscription', {
      token: alex.token,
      method: 'PUT',
      body: alexPhone.subscription,
    });
    const now = Date.now();
    const item = (min: number) => ({
      fire_at: now + min * 60_000,
      key_version: 1,
      payload: sealed(spaceId, 'Dinner in 15 minutes', { not_before: now + min * 60_000 }),
    });
    const tooFar = await call('/push/reminders', {
      token: sam.token,
      method: 'PUT',
      body: { space_id: spaceId, items: [item(9 * 24 * 60)] },
    });
    expect(tooFar.status).toBe(422);
    const tooMany = await call('/push/reminders', {
      token: sam.token,
      method: 'PUT',
      body: { space_id: spaceId, items: Array.from({ length: 65 }, (_, i) => item(i + 1)) },
    });
    expect(tooMany.status).toBe(422);
    await call('/push/reminders', {
      token: sam.token,
      method: 'PUT',
      body: { space_id: spaceId, items: [item(10), item(20)] },
    });
    // Replacing the list drops the old entries.
    const put = await call('/push/reminders', {
      token: sam.token,
      method: 'PUT',
      body: { space_id: spaceId, items: [item(30)] },
    });
    expect(put.json).toMatchObject({ stored: 1 });
    const sent = capturePushes();
    await sendDue(env, now + 25 * 60_000);
    expect(sent.filter((s) => s.url === samPhone.endpoint)).toHaveLength(0);
    await sendDue(env, now + 31 * 60_000);
    expect(sent.filter((s) => s.url === samPhone.endpoint)).toHaveLength(1);
    expect(sent.filter((s) => s.url === alexPhone.endpoint)).toHaveLength(0);
    expect(sent[0]?.headers.get('Urgency')).toBe('high');
  });

  it('forgets a subscription the push service says is gone', async () => {
    const { sam, alex, spaceId } = await couple();
    const phone = await browser();
    await call('/push/subscription', {
      token: alex.token,
      method: 'PUT',
      body: phone.subscription,
    });
    const sent = capturePushes(410);
    await call('/push/notify', {
      token: sam.token,
      body: { space_id: spaceId, key_version: 1, to: 'partner', payload: sealed(spaceId, 'x') },
    });
    await until(() => sent.length === 1);
    await until(() => false, 50).catch(() => {});
    const row = await env.DB.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?')
      .bind(phone.endpoint)
      .first();
    expect(row).toBeNull();
  });

  it('deleting an account removes its subscriptions and reminders', async () => {
    const { sam, spaceId } = await couple();
    const phone = await browser();
    await call('/push/subscription', { token: sam.token, method: 'PUT', body: phone.subscription });
    await call('/push/reminders', {
      token: sam.token,
      method: 'PUT',
      body: {
        space_id: spaceId,
        items: [{ fire_at: Date.now() + 60_000, key_version: 1, payload: sealed(spaceId, 'x') }],
      },
    });
    const del = await call('/me', { token: sam.token, method: 'DELETE' });
    expect(del.status).toBe(200);
    const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?')
      .bind(phone.endpoint)
      .first<{ n: number }>();
    expect(subs?.n).toBe(0);
    const rem = await env.DB.prepare('SELECT COUNT(*) AS n FROM reminders WHERE space_id = ?')
      .bind(spaceId)
      .first<{ n: number }>();
    expect(rem?.n).toBe(0);
  });

  it('decodes payloads defensively (review I1)', async () => {
    const { sam, spaceId } = await couple();
    const res = await call('/push/notify', {
      token: sam.token,
      body: {
        space_id: spaceId,
        key_version: 1,
        to: 'partner',
        payload: { nonce: 'A'.repeat(32), ciphertext: 'A'.repeat(41) },
      },
    });
    expect(res.status).toBe(422);
  });

  it('a leaked endpoint cannot take over someone else’s subscription (review L1)', async () => {
    const a = await signIn(uniqueEmail());
    const b = await signIn(uniqueEmail());
    const phone = await browser();
    await call('/push/subscription', { token: a.token, method: 'PUT', body: phone.subscription });
    const other = await browser();
    const hijack = await call('/push/subscription', {
      token: b.token,
      method: 'PUT',
      body: { ...other.subscription, endpoint: phone.endpoint },
    });
    expect(hijack.status).toBe(409);
    expect((await call('/push/config', { token: a.token })).json.subscribed).toBe(true);
    // The same browser (same keys) may move to another account.
    const move = await call('/push/subscription', {
      token: b.token,
      method: 'PUT',
      body: phone.subscription,
    });
    expect(move.status).toBe(200);
  });

  it('reminders are personal-key payloads, future only (review H1, M1)', async () => {
    const { sam, spaceId } = await couple();
    const phone = await browser();
    await call('/push/subscription', { token: sam.token, method: 'PUT', body: phone.subscription });
    const now = Date.now();
    const put = await call('/push/reminders', {
      token: sam.token,
      method: 'PUT',
      body: {
        space_id: spaceId,
        items: [
          { fire_at: now - 30_000, key_version: 1, payload: sealed(spaceId, 'past') },
          {
            fire_at: now + 60_000,
            key_version: 1,
            payload: sealed(spaceId, 'soon', { scope: 'user', recipient: sam.userId }),
          },
        ],
      },
    });
    expect(put.json.stored).toBe(1);
    const sent = capturePushes();
    await sendDue(env, now + 61_000);
    const mine = sent.filter((x) => x.url === phone.endpoint);
    expect(mine).toHaveLength(1);
    const w = JSON.parse(
      new TextDecoder().decode(await phone.decrypt(mine[0]?.body as Uint8Array)),
    );
    expect(w.c).toBe('u');
  });

  it('is fair across people and bounded per run (review M1)', async () => {
    const busy = await couple();
    const quiet = await couple();
    const busyPhone = await browser();
    const quietPhone = await browser();
    await call('/push/subscription', {
      token: busy.sam.token,
      method: 'PUT',
      body: busyPhone.subscription,
    });
    await call('/push/subscription', {
      token: quiet.sam.token,
      method: 'PUT',
      body: quietPhone.subscription,
    });
    const now = Date.now();
    const many = Array.from({ length: 60 }, (_, i) => ({
      fire_at: now + 1000 + i,
      key_version: 1,
      payload: sealed(busy.spaceId, `r${i}`),
    }));
    await call('/push/reminders', {
      token: busy.sam.token,
      method: 'PUT',
      body: { space_id: busy.spaceId, items: many },
    });
    await call('/push/reminders', {
      token: quiet.sam.token,
      method: 'PUT',
      body: {
        space_id: quiet.spaceId,
        items: [{ fire_at: now + 5000, key_version: 1, payload: sealed(quiet.spaceId, 'q') }],
      },
    });
    const sent = capturePushes();
    await sendDue(env, now + 10_000);
    expect(sent.filter((x) => x.url === quietPhone.endpoint)).toHaveLength(1);
    expect(sent.filter((x) => x.url === busyPhone.endpoint).length).toBeLessThanOrEqual(5);
    expect(sent.length).toBeLessThanOrEqual(40);
  });

  it('retries after a failed run and keeps working subscriptions (review M2)', async () => {
    const { sam, spaceId } = await couple();
    const phone = await browser();
    await call('/push/subscription', { token: sam.token, method: 'PUT', body: phone.subscription });
    const now = Date.now();
    await call('/push/reminders', {
      token: sam.token,
      method: 'PUT',
      body: {
        space_id: spaceId,
        items: [{ fire_at: now + 1000, key_version: 1, payload: sealed(spaceId, 'x') }],
      },
    });
    // The push service is down for a while: many failures, subscription kept.
    capturePushes(503);
    for (let i = 0; i < 12; i++) await sendDue(env, now + 2000 + i * 6 * 60_000);
    const sub = await env.DB.prepare('SELECT failures FROM push_subs WHERE endpoint = ?')
      .bind(phone.endpoint)
      .first<{ failures: number }>();
    expect(sub?.failures).toBe(0);
    // A reminder that failed once is retried by a later run.
    await call('/push/reminders', {
      token: sam.token,
      method: 'PUT',
      body: {
        space_id: spaceId,
        items: [{ fire_at: now + 120_000, key_version: 1, payload: sealed(spaceId, 'y') }],
      },
    });
    capturePushes(503);
    await sendDue(env, now + 121_000);
    const sent = capturePushes(201);
    await sendDue(env, now + 121_000 + 6 * 60_000);
    expect(sent.filter((x) => x.url === phone.endpoint)).toHaveLength(1);
  });

  it('caps held notifications per sender and drops them when the sender leaves (L2, L6)', async () => {
    const { sam, alex, spaceId } = await couple();
    const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    await call('/push/quiet', {
      token: alex.token,
      method: 'PUT',
      body: { start: (nowMin + 1440 - 60) % 1440, end: (nowMin + 60) % 1440, tz: 'UTC' },
    });
    for (let i = 0; i < 25; i++) {
      const r = await call('/push/notify', {
        token: sam.token,
        body: {
          space_id: spaceId,
          key_version: 1,
          to: 'partner',
          payload: sealed(spaceId, `${i}`),
        },
      });
      expect(r.json.deferred).toBe(1);
    }
    const count = async () =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM reminders WHERE target_user_id = ? AND kind = 'deferred'",
        )
          .bind(alex.userId)
          .first<{ n: number }>()
      )?.n;
    expect(await count()).toBe(20);
    await call(`/spaces/${spaceId}/membership`, { token: sam.token, method: 'DELETE' });
    expect(await count()).toBe(0);
  });
});
