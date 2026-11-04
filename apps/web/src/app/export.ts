// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Export and import (phase 6; privacy policy "your choices and rights").
 *
 * - Readable export: everything this person can see, decrypted on this
 *   device, as JSON. For moving elsewhere or keeping a copy you can read.
 * - Encrypted export: the same JSON sealed with a key from the recovery
 *   phrase (core sealExport), safe to keep in cloud storage.
 * - Calendar export: plans as an .ics file for other calendar apps.
 * - Import restores what is missing, and nothing else (security review 0004):
 *   every record gets a new id (references remapped); anything this device
 *   has ever seen, live or deleted, is skipped, so nothing made private or
 *   deleted since the export comes back; shared records only go back into
 *   the space they came from, so an old export never moves a former
 *   partner's plans into a new space; privacy comes from the records
 *   themselves (a comment or item follows its plan or list), never from the
 *   file; busy markers are rebuilt, not imported. A summary is shown first.
 */
import { isEncryptedExport, openExport, sealExport } from '@ours/core/crypto';
import { type IcsExportEvent, writeIcs } from '@ours/core/ics';
import { KIND_SCHEMAS, type Kind } from '@ours/core/schema';
import { isValidRRule } from '@ours/core/time';
import * as v from 'valibot';
import { APP_NAME } from '../config';
import { rederiveCalendar } from './calendars';
import {
  bulk,
  createEvent,
  type Data,
  type Entry,
  findEntry,
  importContext,
  nameOf,
  partner,
  put,
  type Slot,
  viewer,
  visible,
} from './model';

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
  space_id: string;
  viewer: Slot;
  entries: ExportedEntry[];
}

export function buildExport(spaceId: string, now = Date.now()): ExportFile {
  return {
    format: EXPORT_FORMAT,
    v: 1,
    app: APP_NAME,
    exported_at: now,
    space_id: spaceId,
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

export async function readableExport(): Promise<string> {
  return JSON.stringify(buildExport((await importContext()).spaceId), null, 2);
}

export async function encryptedExport(words: readonly (string | null)[]): Promise<string> {
  const file = JSON.stringify(buildExport((await importContext()).spaceId));
  return JSON.stringify(sealExport(words, file));
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
        rrule: d.rrule && isValidRRule(d.rrule) ? d.rrule : null,
        except: d.except ?? [],
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
        rrule: d.rrule && isValidRRule(d.rrule) ? d.rrule : null,
        except: d.except ?? [],
        updatedAt: r.updated_at,
      });
    }
  }
  return writeIcs(events, { name: APP_NAME });
}

export interface ImportSummary {
  plans: number;
  lists: number;
  items: number;
  notes: number;
  calendars: number;
  other: number;
  /** Already here (or deleted here since), from another space, or invalid. */
  skipped: number;
}

export type ImportPlan =
  | { status: 'needs-phrase' }
  | { status: 'ready'; summary: ImportSummary; apply: () => Promise<number> };

export class ImportError extends Error {}

const Exported = v.object({
  format: v.literal(EXPORT_FORMAT),
  v: v.literal(1),
  space_id: v.optional(v.string()),
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

type Parsed = { id: string; kind: Kind; scope: 'space' | 'user'; data: Record<string, unknown> };

const NOT_SYNCED = 'Finish syncing first: import works once this device is up to date.';

/** importContext, but only once this device has caught up with the server (condition A). */
async function syncedContext() {
  const ctx = await importContext();
  if (!ctx.caughtUp) throw new ImportError(NOT_SYNCED);
  return ctx;
}

/** The record a child belongs to: an item's list, a note's plan, item or note, a calendar copy's calendar. */
function parentOf(e: { kind: Kind; data: Record<string, unknown> }): string | null {
  return e.kind === 'item'
    ? String(e.data.list_id)
    : e.kind === 'comment'
      ? String(e.data.parent_id)
      : e.kind === 'cal_snapshot'
        ? String(e.data.calendar_id)
        : null;
}

/**
 * Reads an export file and works out what importing it would add. Nothing is
 * written until `apply()` is called. For an encrypted file, pass the
 * recovery phrase words.
 */
export async function planImport(
  text: string,
  words?: readonly (string | null)[],
): Promise<ImportPlan> {
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
  const { spaceId, known } = await syncedContext();
  const sameSpace = parsed.output.space_id === spaceId;
  const me = viewer.value;

  // Shared or not is decided by where a record will be written, never by
  // the file's own label (review 0004, R3): plans by their privacy, lists by
  // `private`, items and notes by their parent, calendars always personal.
  const entries = parsed.output.entries.map((item) => {
    const data = v.safeParse(KIND_SCHEMAS[item.kind], item.data);
    return { item, data: data.success ? (data.output as Record<string, unknown>) : null };
  });
  const byId = new Map(entries.map((e) => [e.item.id, e]));
  const destShared = (id: string, depth = 0): boolean | null => {
    const e = byId.get(id);
    if (!e) {
      const here = findEntry(id);
      return here ? here.scope === 'space' : null;
    }
    const { item, data } = e;
    if (!data || depth > 32) return null;
    switch (item.kind) {
      case 'event':
        return data.privacy !== 'busy';
      case 'list':
        return !data.private;
      case 'calendar':
      case 'cal_snapshot':
        return false;
      case 'item':
      case 'comment': {
        const parent = parentOf({ kind: item.kind, data });
        return parent === null ? null : destShared(parent, depth + 1);
      }
      default:
        return item.scope === 'space';
    }
  };

  const ok: Parsed[] = [];
  let skipped = 0;
  for (const { item, data } of entries) {
    const shared = data ? destShared(item.id) : null;
    if (
      !data ||
      known.has(item.id) ||
      // Children of something neither here nor in the file go nowhere.
      shared === null ||
      (shared && !sameSpace) ||
      // Rebuilt from their plans; settings stay as they are here.
      item.kind === 'busy_stub' ||
      item.kind === 'settings' ||
      // The shared copy of a calendar is re-derived from the private one.
      (item.kind === 'cal_snapshot' && item.scope === 'space')
    ) {
      skipped++;
      continue;
    }
    ok.push({ id: item.id, kind: item.kind, scope: shared ? 'space' : 'user', data });
  }

  // Children need their parent: in the file (being imported) or already here.
  const importing = new Set(ok.map((e) => e.id));
  const plan = ok.filter((e) => {
    const p = parentOf(e);
    if (p === null || importing.has(p) || findEntry(p)) return true;
    skipped++;
    return false;
  });

  const count = (k: Kind) => plan.filter((e) => e.kind === k).length;
  const summary: ImportSummary = {
    plans: count('event'),
    lists: count('list'),
    items: count('item'),
    notes: count('comment'),
    calendars: count('calendar'),
    other: count('checkin'),
    skipped,
  };

  const apply = async (): Promise<number> => {
    // Checked again now, not when the summary was made: sync may have
    // stopped, or brought in deletions, in between (condition A).
    const now = await syncedContext();
    if (now.spaceId !== spaceId) throw new ImportError(NOT_SYNCED);
    const ids = new Map<string, string>();
    const mapped = (id: string) => ids.get(id) ?? id;
    /** Where a child goes: after its parent, written now or already here; else nowhere (R4). */
    const parentScope = (id: string): 'space' | 'user' | null => {
      const written = ids.get(id);
      if (written) return findEntry(written)?.scope ?? null;
      if (importing.has(id)) return null; // in the file but not written
      return findEntry(id)?.scope ?? null;
    };
    let written = 0;
    const order: Kind[] = [
      'list',
      'calendar',
      'event',
      'checkin',
      'item',
      'comment',
      'cal_snapshot',
    ];
    const write = (e: Parsed): boolean => {
      const kind = e.kind;
      let id: string;
      if (kind === 'event') {
        // createEvent writes private plans under the personal key with a fresh busy marker.
        id = createEvent({ ...(e.data as Data<'event'>), stub_id: null });
      } else if (kind === 'item' || kind === 'comment' || kind === 'cal_snapshot') {
        const raw = String(parentOf(e));
        const scope = parentScope(raw);
        if (scope === null) return false;
        const parent = mapped(raw);
        id =
          kind === 'item'
            ? put('item', { ...(e.data as Data<'item'>), list_id: parent }, { scope })
            : kind === 'comment'
              ? put('comment', { ...(e.data as Data<'comment'>), parent_id: parent }, { scope })
              : put(
                  'cal_snapshot',
                  { ...(e.data as Data<'cal_snapshot'>), calendar_id: parent, importer: me },
                  { scope: 'user' },
                );
      } else if (kind === 'list') {
        const d = e.data as Data<'list'>;
        id = put('list', d, { scope: d.private ? 'user' : 'space' });
      } else if (kind === 'calendar') {
        id = put(
          'calendar',
          { ...(e.data as Data<'calendar'>), fetched_at: null },
          { scope: 'user' },
        );
      } else {
        id = put(kind, e.data as never, { scope: e.scope });
      }
      ids.set(e.id, id);
      written++;
      return true;
    };
    bulk(() => {
      for (const kind of order) {
        // Notes can answer notes, so go round until a pass writes nothing new.
        let todo = plan.filter((x) => x.kind === kind && !now.known.has(x.id));
        for (let progress = true; todo.length && progress; ) {
          progress = false;
          const left: Parsed[] = [];
          for (const e of todo) {
            let done = false;
            try {
              done = write(e);
            } catch {
              // Refused by the scope policy or the schema: skipped.
              done = true;
            }
            if (done) progress = true;
            else left.push(e);
          }
          todo = left;
        }
      }
    });
    // Rebuild the shared copy of each restored calendar from its private one.
    for (const e of plan)
      if (e.kind === 'calendar' && ids.has(e.id)) rederiveCalendar(mapped(e.id));
    return written;
  };
  return { status: 'ready', summary, apply };
}
