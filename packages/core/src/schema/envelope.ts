// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Wire shape of an encrypted record. This is everything the server sees.
 * Binary fields travel as base64url strings. Shared by the web app and API.
 */
import * as v from 'valibot';

export const MAX_CIPHERTEXT_BYTES = 64 * 1024;

export const Id = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));
export const RecordId = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
const B64 = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]*$/));
export const Nonce = v.pipe(B64, v.length(32)); // 24 bytes
export const Ciphertext = v.pipe(
  B64,
  v.minLength(4),
  v.maxLength(Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3)),
);
const PositiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));
const NonNegativeInt = v.pipe(v.number(), v.integer(), v.minValue(0));

export const Scope = v.picklist(['space', 'user']);

/** Fields a client sends when writing a record. */
export const EnvelopeInput = v.pipe(
  v.strictObject({
    id: RecordId,
    space_id: Id,
    scope: Scope,
    owner_user_id: v.nullable(Id),
    key_version: PositiveInt,
    nonce: Nonce,
    ciphertext: Ciphertext,
    deleted: v.boolean(),
  }),
  v.check(
    (e) => (e.scope === 'user') === (e.owner_user_id !== null),
    'owner_user_id is required for user scope and forbidden for space scope',
  ),
);
export type EnvelopeInput = v.InferOutput<typeof EnvelopeInput>;

/** A stored record as returned by the server. */
export const Envelope = v.strictObject({
  id: RecordId,
  space_id: Id,
  scope: Scope,
  owner_user_id: v.nullable(Id),
  key_version: PositiveInt,
  nonce: Nonce,
  ciphertext: Ciphertext,
  deleted: v.boolean(),
  rev: PositiveInt,
  updated_at: NonNegativeInt,
  updated_by: Id,
});
export type Envelope = v.InferOutput<typeof Envelope>;
