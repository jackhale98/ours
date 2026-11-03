// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sync wire protocol, shared by the web app and the API.
 *
 * Push: up to MAX_PUSH envelopes, each with the rev it was based on
 * (0 for a new record). The server accepts a record only if its stored rev
 * still equals base_rev; otherwise it returns the current envelope as a
 * conflict and the client merges and retries.
 *
 * Pull: envelopes with rev > since, ordered by rev, at most `limit`.
 */
import * as v from 'valibot';
import { Envelope, EnvelopeInput, Id, RecordId } from '../schema/envelope';

export const MAX_PUSH = 100;
export const MAX_PULL = 500;

export const PushItem = v.strictObject({
  envelope: EnvelopeInput,
  base_rev: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type PushItem = v.InferOutput<typeof PushItem>;

export const PushRequest = v.pipe(
  v.strictObject({
    space_id: Id,
    items: v.pipe(
      v.array(PushItem),
      v.minLength(1),
      v.maxLength(MAX_PUSH),
      v.check(
        (items) => new Set(items.map((i) => i.envelope.id)).size === items.length,
        'Duplicate record ids in one push',
      ),
    ),
  }),
  v.check(
    (req) => req.items.every((i) => i.envelope.space_id === req.space_id),
    'Every envelope must belong to the request space',
  ),
);
export type PushRequest = v.InferOutput<typeof PushRequest>;

export const PushResult = v.variant('status', [
  v.strictObject({ status: v.literal('ok'), id: RecordId, rev: v.number() }),
  /** Stored rev differed from base_rev. `current` is what the server holds now. */
  v.strictObject({ status: v.literal('conflict'), id: RecordId, current: Envelope }),
  /** Not allowed (wrong space, someone else's user record, quota). Do not retry unchanged. */
  v.strictObject({ status: v.literal('rejected'), id: RecordId, reason: v.string() }),
]);
export type PushResult = v.InferOutput<typeof PushResult>;

export const PushResponse = v.strictObject({
  results: v.array(PushResult),
  seq: v.number(),
});
export type PushResponse = v.InferOutput<typeof PushResponse>;

export const PullQuery = v.strictObject({
  space_id: Id,
  since: v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(0)),
  limit: v.optional(
    v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1), v.maxValue(MAX_PULL)),
    String(MAX_PULL),
  ),
});

export const PullResponse = v.strictObject({
  envelopes: v.array(Envelope),
  /** Highest rev in this page, or `since` when empty. Store it as the new cursor. */
  cursor: v.number(),
  more: v.boolean(),
});
export type PullResponse = v.InferOutput<typeof PullResponse>;
