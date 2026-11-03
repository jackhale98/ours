// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Export and import (phase 6; privacy policy "your choices and rights").
 *
 * - Readable export: everything this person can see, decrypted on this
 *   device, as JSON. For moving elsewhere or keeping a copy you can read.
 * - Encrypted export: the same JSON sealed with a key from the recovery
 *   phrase (core sealExport), safe to keep in cloud storage.
 * - Calendar export: plans as an .ics file for other calendar apps.
 * - Import: either kind of export file. Records are validated with the same
 *   schemas as sync; a record already here is kept unless the file's copy is
 *   newer. Busy markers derived from the partner's private plans are skipped
 *   (their device owns them).
 */
import { isEncryptedExport, openExport, sealExport } from '@ours/core/crypto';
import { type IcsExportEvent, writeIcs } from '@ours/core/ics';
import { KIND_SCHEMAS, type Kind } from '@ours/core/schema';
import * as v from 'valibot';
import { APP_NAME } from '../config';
import { type Entry, findEntry, nameOf, partner, put, type Slot, viewer, visible } from './model';

export const EXPORT_FORMAT = 'ours-export';

interface ExportedEntry {
  id: string;
  kind: Kind;
  scope: 'space' | 'user';
  owner: Slot | null;
  updated_at: number;
  data: unknown;
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  v: 1;
  app: string;
  exported_at: number;
  viewer: Slot;
  entries: ExportedEntry[];
}

export function buildExport(now = Date.now()): ExportFile {
  return {
    format: EXPORT_FORMAT,
    v: 1,
    app: APP_NAME,
    exported_at: now,
    viewer: viewer.value,
    entries: visible.value.map((e: Entry) => ({
      id: e.id,
      kind: e.rec.kind,
      scope: e.scope,
      owner: e.owner,
      updated_at: e.rec.updated_at,
      data: e.rec.data,
    })),
  };
}

export const readableExport = () => JSON.stringify(buildExport(), null, 2);

export function encryptedExport(words: readonly (string | null)[]): string {
  return JSON.stringify(sealExport(words, JSON.stringify(buildExport())));
}

/** Plans as iCalendar. Private plans of the partner appear as "Busy". */
export function calendarExport(): string {
  const events: IcsExportEvent[] = [];
  for (const e of visible.value) {
    const r = e.rec;
    if (r.kind === 'event') {
      const d = r.data;
      if (d.status === 'declined') continue;
      events.push({
        uid: e.id,
        title: d.title,
        start: d.start,
        end: d.end,
        allDay: d.all_day,
        tz: d.tz,
        rrule: d.rrule,
        location: d.location,
        description: d.notes,
        status: d.status === 'proposed' ? 'tentative' : 'confirmed',
        updatedAt: r.updated_at,
      });
    } else if (r.kind === 'busy_stub' && r.data.owner === partner.value) {
      const d = r.data;
      events.push({
        uid: e.id,
        title: `${nameOf(d.owner)}: Busy`,
        start: d.start,
        end: d.end,
        allDay: d.all_day,
        tz: d.tz,
        rrule: d.rrule,
        updatedAt: r.updated_at,
      });
    }
  }
  return writeIcs(events, { name: APP_NAME });
}

export type ImportOutcome =
  | { status: 'needs-phrase' }
  | { status: 'done'; added: number; updated: number; skipped: number };

export class ImportError extends Error {}

const Exported = v.object({
  format: v.literal(EXPORT_FORMAT),
  v: v.literal(1),
  entries: v.array(
    v.object({
      id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
      kind: v.picklist(Object.keys(KIND_SCHEMAS) as Kind[]),
      scope: v.picklist(['space', 'user']),
      owner: v.nullable(v.picklist(['a', 'b'])),
      updated_at: v.number(),
      data: v.unknown(),
    }),
  ),
});

/**
 * Imports an export file's text. For an encrypted file, pass the recovery
 * phrase words; without them the result asks for the phrase.
 */
export function importExport(text: string, words?: readonly (string | null)[]): ImportOutcome {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ImportError('That file isn’t an Ours export.');
  }
  if (isEncryptedExport(json)) {
    if (!words) return { status: 'needs-phrase' };
    try {
      json = JSON.parse(openExport(words, json));
    } catch {
      throw new ImportError('Those words don’t open this file. Check the recovery phrase.');
    }
  }
  const parsed = v.safeParse(Exported, json);
  if (!parsed.success) throw new ImportError('That file isn’t an Ours export.');
  const me = viewer.value;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const item of parsed.output.entries) {
    const data = v.safeParse(KIND_SCHEMAS[item.kind], item.data);
    // Busy markers mirror the partner's private plans; their device owns them.
    const partnersMarker =
      data.success && item.kind === 'busy_stub' && (data.output as { owner: Slot }).owner !== me;
    if (!data.success || partnersMarker) {
      skipped++;
      continue;
    }
    const here = findEntry(item.id);
    if (here && here.rec.updated_at >= item.updated_at) {
      skipped++;
      continue;
    }
    try {
      put(item.kind, data.output as never, {
        id: item.id,
        scope: item.scope,
        ...(item.scope === 'user' ? { owner: me } : {}),
      });
    } catch {
      skipped++;
      continue;
    }
    if (here) updated++;
    else added++;
  }
  return { status: 'done', added, updated, skipped };
}
