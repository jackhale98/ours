// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context } from 'hono';
import * as v from 'valibot';

/** An error with a coarse, stable code for the client. Never includes request data. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 501 | 503,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const MAX_BODY_BYTES = 1024 * 1024;

/** Reads and validates a JSON body. Rejects oversized or malformed input. */
export async function body<S extends v.GenericSchema>(
  c: Context,
  schema: S,
): Promise<v.InferOutput<S>> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'too_large');
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too_large');
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
