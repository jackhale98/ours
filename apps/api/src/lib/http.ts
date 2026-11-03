// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context } from 'hono';
import * as v from 'valibot';

/** An error with a coarse, stable code for the client. Never includes request data. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 501 | 502 | 503,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const MAX_BODY_BYTES = 1024 * 1024;

/** Reads the body as text, stopping as soon as it passes MAX_BODY_BYTES (no full buffering). */
async function readLimited(c: Context): Promise<string> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'too_large');
  const stream = c.req.raw.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, 'too_large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Reads and validates a JSON body. Rejects oversized or malformed input. */
export async function body<S extends v.GenericSchema>(
  c: Context,
  schema: S,
): Promise<v.InferOutput<S>> {
  const text = await readLimited(c);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json');
  }
  const result = v.safeParse(schema, json);
  if (!result.success)
    throw new HttpError(422, 'invalid', 'Request did not match the expected shape');
  return result.output;
}

export function query<S extends v.GenericSchema>(c: Context, schema: S): v.InferOutput<S> {
  const result = v.safeParse(schema, c.req.query());
  if (!result.success) throw new HttpError(422, 'invalid');
  return result.output;
}
