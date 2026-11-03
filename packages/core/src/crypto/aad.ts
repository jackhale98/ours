// SPDX-License-Identifier: AGPL-3.0-or-later
import { CryptoError, utf8 } from './bytes';

/**
 * Builds associated data from labelled fields.
 * Each field is length-prefixed (u32 big-endian) so that no two distinct
 * field lists can serialise to the same bytes, whatever characters they contain.
 */
export function buildAad(fields: readonly (string | number)[]): Uint8Array {
  const parts = fields.map((f) => {
    if (typeof f === 'number') {
      if (!Number.isSafeInteger(f) || f < 0) throw new CryptoError('format', 'Invalid AAD number');
      return utf8(String(f));
    }
    return utf8(f);
  });
  const total = parts.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const p of parts) {
    view.setUint32(offset, p.length);
    out.set(p, offset + 4);
    offset += 4 + p.length;
  }
  return out;
}
