// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Add to my calendar": puts one plan into the phone's or computer's own
 * calendar app, with as much detail as the person chooses (time and title by
 * default). Everything happens on this device; nothing goes through our
 * server.
 *
 * - iPhone and iPad: the calendar file is handed to our own service worker,
 *   which serves it once at a same-site address; opening that address shows
 *   iOS's "Add to Calendar" sheet.
 * - Android: an intent link opens the calendar app's new-event screen with
 *   the details filled in. A series with skipped or moved days can't be
 *   described that way, so it falls back to a file.
 * - Computers: a .ics file to open.
 *
 * The copy is outside Ours' encryption and doesn't follow later changes; the
 * panel says so.
 */
import { type IcsExportEvent, writeIcs } from '@ours/core/ics';
import type { EventData } from '@ours/core/schema';
import { isValidRRule, toInstant } from '@ours/core/time';
import { useState } from 'preact/hooks';
import { APP_NAME } from '../config';
import { dayTimes } from './thisday';
import { Icon, toast } from './ui';

export type Detail = 'title' | 'full' | 'busy';

const DETAIL_KEY = 'ours-addcal-detail';

function savedDetail(): Detail {
  try {
    const v = localStorage.getItem(DETAIL_KEY);
    return v === 'full' || v === 'busy' ? v : 'title';
  } catch {
    return 'title';
  }
}

/** The event to write: one day of a series (`day`), or the whole plan. */
export function eventFor(
  id: string,
  e: EventData,
  opts: { detail: Detail; day: string | null; now?: number },
): IcsExportEvent {
  const one = opts.day ? dayTimes(e, opts.day) : null;
  const full = opts.detail === 'full';
  const rrule = !one && e.rrule && isValidRRule(e.rrule) ? e.rrule : null;
  return {
    // A single day gets its own id, so it never replaces the whole series.
    uid: one && opts.day ? `${id}-${opts.day.replace(/[^0-9]/g, '')}` : id,
    title: opts.detail === 'busy' ? 'Busy' : e.title,
    start: one ? one.start : e.start,
    end: one ? one.end : e.end,
    allDay: e.all_day,
    tz: e.all_day ? null : e.tz,
    rrule,
    except: rrule ? (e.except ?? []) : [],
    location: full ? e.location : null,
    description: full ? e.notes : null,
    status: e.status === 'proposed' ? 'tentative' : 'confirmed',
    updatedAt: opts.now ?? Date.now(),
  };
}

export function icsFor(ev: IcsExportEvent): string {
  return writeIcs([ev], { name: APP_NAME });
}

/** Milliseconds for the calendar app: all-day dates at UTC midnight, as Android expects. */
const instant = (wall: string, allDay: boolean, tz: string | null) =>
  allDay ? Date.parse(`${wall.slice(0, 10)}T00:00:00Z`) : toInstant(wall, tz ?? 'UTC');

/**
 * Android's "new event" screen, filled in (CalendarContract extras). Null when
 * the plan can't be described this way (a series with changed days).
 */
export function androidIntent(ev: IcsExportEvent): string | null {
  if (ev.rrule && ev.except?.length) return null;
  const enc = encodeURIComponent;
  const extras = [
    `S.title=${enc(ev.title)}`,
    `l.beginTime=${instant(ev.start, ev.allDay, ev.tz)}`,
    `l.endTime=${instant(ev.end, ev.allDay, ev.tz)}`,
    `B.allDay=${ev.allDay}`,
    ev.location ? `S.eventLocation=${enc(ev.location)}` : '',
    ev.description ? `S.description=${enc(ev.description)}` : '',
    ev.rrule ? `S.rrule=${enc(ev.rrule)}` : '',
    ev.tz ? `S.eventTimezone=${enc(ev.tz)}` : '',
  ].filter(Boolean);
  return `intent:#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.item/event;${extras.join(';')};end`;
}

export type Platform = 'ios' | 'android' | 'other';

export function platform(ua = navigator.userAgent, touch = navigator.maxTouchPoints): Platform {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

const fileName = (ev: IcsExportEvent) =>
  `${
    ev.title
      .replace(/[^\p{L}\p{N} _-]+/gu, '')
      .trim()
      .slice(0, 40) || 'plan'
  }.ics`;

function download(ev: IcsExportEvent): void {
  const url = URL.createObjectURL(new Blob([icsFor(ev)], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(ev);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** iOS: serve the file from our own service worker, once, and open it. */
async function openViaWorker(ev: IcsExportEvent): Promise<boolean> {
  if (!navigator.serviceWorker?.controller || typeof caches === 'undefined') return false;
  const id = crypto.getRandomValues(new Uint32Array(2)).join('');
  const url = new URL(`add-event/${id}.ics`, location.href.split('#')[0]).href;
  const cache = await caches.open('ours-add-event');
  await cache.put(
    url,
    new Response(icsFor(ev), {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' },
    }),
  );
  // Gone in a minute even if it's never opened.
  setTimeout(() => void cache.delete(url), 60_000);
  location.assign(url);
  return true;
}

/** Puts the event into this device's calendar app the most direct way it allows. */
export async function addToCalendar(ev: IcsExportEvent, how: Platform = platform()) {
  if (how === 'android') {
    const intent = androidIntent(ev);
    if (intent) {
      location.assign(intent);
      return;
    }
  }
  if (how === 'ios' && (await openViaWorker(ev).catch(() => false))) return;
  download(ev);
}

const CHOICES: [Detail, string, string][] = [
  ['title', 'Time and title', ''],
  ['full', 'Full details', 'With the place and notes.'],
  ['busy', 'Just “Busy”', 'For a calendar others can see.'],
];

/** The plan sheet's "Add to my calendar" button and its small choice panel. */
export function AddToCalendar({ id, e, day }: { id: string; e: EventData; day: string | null }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail>(savedDetail);
  const [which, setWhich] = useState<'day' | 'all'>(day ? 'day' : 'all');
  const ev = () => eventFor(id, e, { detail, day: which === 'day' ? day : null });
  const add = async (how?: Platform) => {
    try {
      localStorage.setItem(DETAIL_KEY, detail);
    } catch {
      // Private mode: the choice just isn't remembered.
    }
    try {
      await addToCalendar(ev(), how);
      setOpen(false);
    } catch {
      toast('Couldn’t open your calendar. Try “Download a file”.');
    }
  };

  if (!open)
    return (
      <button type="button" class="btn sm addcal-btn" onClick={() => setOpen(true)}>
        <Icon name="cal" size={16} />
        Add to my calendar
      </button>
    );
  return (
    <fieldset class="addcal">
      <legend class="eyebrow">Add to my calendar</legend>
      {day && (
        <div class="chips" role="radiogroup" aria-label="Which days">
          {(
            [
              ['day', 'This day'],
              ['all', 'Every time'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} class="chip">
              <input
                type="radio"
                name="addcal-which"
                checked={which === k}
                onChange={() => setWhich(k)}
              />
              {label}
            </label>
          ))}
        </div>
      )}
      {CHOICES.map(([k, label, hint]) => (
        <label key={k} class="addcal-opt">
          <input
            type="radio"
            name="addcal-detail"
            checked={detail === k}
            onChange={() => setDetail(k)}
          />
          <span>
            {label}
            {hint && <span class="small muted"> {hint}</span>}
          </span>
        </label>
      ))}
      <p class="small muted">
        The copy in your calendar isn’t protected by Ours’ encryption, and won’t change if this plan
        does.
      </p>
      <div class="btnrow">
        <button type="button" class="btn sm primary" onClick={() => void add()}>
          Add
        </button>
        {platform() !== 'other' && (
          <button type="button" class="linkbtn" onClick={() => void add('other')}>
            Download a file
          </button>
        )}
        <button type="button" class="btn sm ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}
