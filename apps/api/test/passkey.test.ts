// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Passkey registration and sign-in against a software authenticator: a real
 * P-256 key, real 'none' attestation and real assertions, verified by
 * @simplewebauthn/server inside the Workers runtime.
 */
import { describe, expect, it } from 'vitest';
import { b64, call, ORIGIN, signIn, uniqueEmail } from './helpers';

/* ---- minimal CBOR encoder (maps, ints, byte and text strings) ---- */
function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(v: Cbor): number[] {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    return [...head(3, b.length), ...b];
  }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  const out = head(5, v.size);
  for (const [k, val] of v) out.push(...cbor(k), ...cbor(val));
  return out;
}

const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', data));
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

/** IEEE P1363 (r||s) → ASN.1 DER, as WebAuthn expects. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if ((v[0] ?? 0) & 0x80) v = cat(new Uint8Array([0]), v);
    return cat(new Uint8Array([0x02, v.length]), v);
  };
  const body = cat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

class SoftAuthenticator {
  credId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  keys!: CryptoKeyPair;
  userHandle: Uint8Array | null = null;
  constructor(readonly rpId = new URL(ORIGIN).hostname) {}

  async create(options: { challenge: string; user: { id: string } }) {
    this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
    const fromB64Url = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    this.userHandle = fromB64Url(options.user.id);
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, fromB64Url(jwk.x ?? '')],
      [-3, fromB64Url(jwk.y ?? '')],
    ]);
    const authData = cat(
      await sha256(utf8(this.rpId)),
      new Uint8Array([0x45, 0, 0, 0, 0]), // UP | UV | AT, counter 0
      new Uint8Array(16), // aaguid
      new Uint8Array([0, this.credId.length]),
      this.credId,
      new Uint8Array(cbor(cose)),
    );
    const clientData = utf8(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin: ORIGIN,
        crossOrigin: false,
      }),
    );
    const attestation = new Uint8Array(
      cbor(
        new Map<Cbor, Cbor>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      ),
    );
    return {
      id: b64(this.credId),
      rawId: b64(this.credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientData),
        attestationObject: b64(attestation),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  async get(options: { challenge: string }, origin = ORIGIN) {
    this.counter++;
    const authData = cat(
      await sha256(utf8(this.rpId)),
      new Uint8Array([0x05, 0, 0, 0, this.counter]), // UP | UV
    );
    const clientData = utf8(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const signed = cat(authData, await sha256(clientData));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed),
    );
    return {
      id: b64(this.credId),
      rawId: b64(this.credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(derSignature(raw)),
        userHandle: this.userHandle ? b64(this.userHandle) : undefined,
      },
      clientExtensionResults: {},
    };
  }
}

async function register(token: string, device = new SoftAuthenticator()) {
  const opts = await call('/auth/passkey/register/options', { token, body: {} });
  expect(opts.status).toBe(200);
  const response = await device.create(opts.json.options);
  const verify = await call('/auth/passkey/register/verify', {
    token,
    body: { challenge_id: opts.json.challenge_id, response },
  });
  return { verify, device };
}

describe('passkeys', () => {
  it('registers, then signs in to the same account with a new session', async () => {
    const s = await signIn(uniqueEmail());
    const { verify, device } = await register(s.token);
    expect(verify.status).toBe(200);
    expect((await call('/me', { token: s.token })).json.passkeys).toBe(1);

    const opts = await call('/auth/passkey/login/options', { body: {} });
    const response = await device.get(opts.json.options);
    const login = await call('/auth/passkey/login/verify', {
      body: { challenge_id: opts.json.challenge_id, response, device_label: 'Laptop' },
    });
    expect(login.status).toBe(200);
    expect(login.json.user.id).toBe(s.userId);
    expect((await call('/me', { token: login.json.token })).status).toBe(200);
  });

  it('challenges are single use', async () => {
    const s = await signIn(uniqueEmail());
    const { device } = await register(s.token);
    const opts = await call('/auth/passkey/login/options', { body: {} });
    const response = await device.get(opts.json.options);
    expect(
      (
        await call('/auth/passkey/login/verify', {
          body: { challenge_id: opts.json.challenge_id, response },
        })
      ).status,
    ).toBe(200);
    const replay = await call('/auth/passkey/login/verify', {
      body: { challenge_id: opts.json.challenge_id, response },
    });
    expect(replay.json.error).toBe('challenge_invalid');
  });

  it('rejects a wrong origin, a wrong challenge or an unknown key', async () => {
    const s = await signIn(uniqueEmail());
    const { device } = await register(s.token);
    const o1 = await call('/auth/passkey/login/options', { body: {} });
    const evil = await device.get(o1.json.options, 'https://evil.example');
    expect(
      (
        await call('/auth/passkey/login/verify', {
          body: { challenge_id: o1.json.challenge_id, response: evil },
        })
      ).json.error,
    ).toBe('passkey_invalid');

    const o2 = await call('/auth/passkey/login/options', { body: {} });
    const o3 = await call('/auth/passkey/login/options', { body: {} });
    const wrong = await device.get(o3.json.options);
    expect(
      (
        await call('/auth/passkey/login/verify', {
          body: { challenge_id: o2.json.challenge_id, response: wrong },
        })
      ).json.error,
    ).toBe('passkey_invalid');

    const o4 = await call('/auth/passkey/login/options', { body: {} });
    const stranger = new SoftAuthenticator();
    stranger.keys = device.keys;
    const unknown = await stranger.get(o4.json.options);
    expect(
      (
        await call('/auth/passkey/login/verify', {
          body: { challenge_id: o4.json.challenge_id, response: unknown },
        })
      ).json.error,
    ).toBe('passkey_invalid');
  });

  it('registration requires a session and its own challenge', async () => {
    expect((await call('/auth/passkey/register/options', { body: {} })).status).toBe(401);
    const a = await signIn(uniqueEmail());
    const b = await signIn(uniqueEmail());
    const opts = await call('/auth/passkey/register/options', { token: a.token, body: {} });
    const response = await new SoftAuthenticator().create(opts.json.options);
    // B can't use A's challenge.
    const stolen = await call('/auth/passkey/register/verify', {
      token: b.token,
      body: { challenge_id: opts.json.challenge_id, response },
    });
    expect(stolen.json.error).toBe('challenge_invalid');
  });
});
