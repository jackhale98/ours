// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../crypto/bytes';
import { Envelope, EnvelopeInput } from './envelope';
import { uuidv7 } from './ids';

const input = {
  id: uuidv7(),
  space_id: 'space_1',
  scope: 'space' as const,
  owner_user_id: null,
  key_version: 1,
  nonce: toBase64Url(new Uint8Array(24)),
  ciphertext: toBase64Url(new Uint8Array(80)),
  deleted: false,
};

describe('envelope wire schema', () => {
  it('accepts a valid input and stored envelope', () => {
    expect(v.is(EnvelopeInput, input)).toBe(true);
    expect(v.is(Envelope, { ...input, rev: 3, updated_at: 10, updated_by: 'u1' })).toBe(true);
    expect(v.is(EnvelopeInput, { ...input, scope: 'user', owner_user_id: 'u1' })).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['non-v7 id', { id: 'not-a-uuid' }],
    ['user scope without owner', { scope: 'user' }],
    ['space scope with owner', { owner_user_id: 'u1' }],
    ['bad nonce length', { nonce: 'AAAA' }],
    ['non base64url ciphertext', { ciphertext: 'a+b/' }],
    ['huge ciphertext', { ciphertext: 'A'.repeat(100_000) }],
    ['zero key version', { key_version: 0 }],
    ['unknown field', { plaintext: 'oops' }],
    ['bad space id', { space_id: 'has space' }],
  ])('rejects %s', (_name, patch) => {
    expect(v.is(EnvelopeInput, { ...input, ...patch })).toBe(false);
  });
});
