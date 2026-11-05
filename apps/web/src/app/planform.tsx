// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The full plan form: every field a plan has, for a new plan ("More options",
 * "Add a milestone") or an existing one ("Edit"). Quick add stays the fast
 * path; this is where repeats, trips spanning days, away days, countdowns,
 * places and notes are set or changed.
 */
import { addDays, addWallMinutes, isValidRRule, wallMinutes } from '@ours/core/time';
import { useState } from 'preact/hooks';
import {
  createEvent,
  type EventData,
  exceptionsLost,
  findEntry,
  nameOf,
  partner,
  type Slot,
  setEventPrivacy,
  updateEvent,
  viewer,
} from './model';
import { noticeChange, noticeMove, noticeProposal } from './notices';
import { ReminderPicker } from './reminderpicker';
import { defaultReminders, remindersOf, withReminders } from './reminders';
import { repeatText, today, weekStartsOn, zone } from './select';
import { afterAdd, sheet } from './sheets';
import { CloseButton, Marker, Sheet, Switch, toast, typeFirst } from './ui';

export type Draft = Partial<EventData>;

export const REPEAT_CHOICES: [string, string][] = [
  ['', 'Doesn’t repeat'],
  ['FREQ=DAILY', 'Every day'],
  ['FREQ=WEEKLY', 'Every week'],
  ['FREQ=WEEKLY;INTERVAL=2', 'Every 2 weeks'],
  ['FREQ=MONTHLY', 'Every month'],
  ['FREQ=YEARLY', 'Every year'],
];

type Who = 'me' | 'ours' | 'partner';

/** Every zone the browser knows, with this device's and the plan's first. */
function zoneChoices(current: string): string[] {
  let all: string[] = [];
  try {
    all =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        'timeZone',
      ) ?? [];
  } catch {
    all = [];
  }
  return [...new Set([zone, current, ...all])];
}

/* A repeat rule as the form edits it (review 0009, P-6): how often, which weekdays, when it ends. */
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
interface RuleParts {
  base: string;
  byday: string[];
  until: string | null;
  count: number | null;
}
/** Null when the rule has parts the form doesn't edit (it stays as typed). */
export function readRule(rule: string): RuleParts | null {
  if (!rule) return null;
  const m = new Map(rule.split(';').map((p) => p.split('=') as [string, string]));
  if ([...m.keys()].some((k) => !['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT'].includes(k)))
    return null;
  const byday = m.get('BYDAY')?.split(',') ?? [];
  if (byday.some((d) => !DAY_CODES.includes(d))) return null;
  const interval = m.get('INTERVAL');
  const until = m.get('UNTIL');
  return {
    base: `FREQ=${m.get('FREQ')}${interval && interval !== '1' ? `;INTERVAL=${interval}` : ''}`,
    byday,
    until: until ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` : null,
    count: m.has('COUNT') ? Number(m.get('COUNT')) : null,
  };
}
export function writeRule(r: RuleParts): string {
  const days = DAY_CODES.filter((d) => r.byday.includes(d));
  return [
    r.base,
    days.length && r.base.startsWith('FREQ=WEEKLY') ? `BYDAY=${days.join(',')}` : '',
    r.until ? `UNTIL=${r.until.replace(/-/g, '')}T235959Z` : '',
    !r.until && r.count ? `COUNT=${r.count}` : '',
  ]
    .filter(Boolean)
    .join(';');
}

const close = () => {
  sheet.value = null;
};

export function PlanForm({ id, draft }: { id: string | null; draft?: Draft }) {
  const me = viewer.value;
  const p = partner.value;
  const existing = id ? findEntry(id) : undefined;
  const base: Draft =
    existing?.rec.kind === 'event' ? existing.rec.data : { owner: 'both', ...draft };
  const editing = !!existing;

  const startDate0 = (base.start ?? today.value).slice(0, 10);
  const allDay0 = base.all_day ?? !base.start?.includes('T');
  const startTime0 = base.start?.includes('T') ? base.start.slice(11, 16) : '19:00';
  const endDate0 = base.end
    ? allDay0
      ? addDays(base.end.slice(0, 10), -1) // stored end is exclusive for all-day plans
      : base.end.slice(0, 10)
    : startDate0;
  const endTime0 = base.end?.includes('T')
    ? base.end.slice(11, 16)
    : addWallMinutes(`${startDate0}T${startTime0}`, 60).slice(11, 16);

  const [title, setTitle] = useState(base.title ?? '');
  const [who, setWho] = useState<Who>(
    base.owner === 'both' || !base.owner ? 'ours' : base.owner === me ? 'me' : 'partner',
  );
  const [allDay, setAllDay] = useState(allDay0);
  const [startDate, setStartDate] = useState(startDate0);
  const [startTime, setStartTime] = useState(startTime0);
  const [endDate, setEndDate] = useState(endDate0);
  const [endTime, setEndTime] = useState(endTime0);
  const [repeat, setRepeat] = useState(base.rrule ?? '');
  // The zone its times are in: this device's unless the plan says otherwise (P-13).
  const [tz, setTz] = useState(base.tz ?? zone);
  const [location, setLocation] = useState(base.location ?? '');
  const [notes, setNotes] = useState(base.notes ?? '');
  const [away, setAway] = useState(base.away ?? false);
  const [countdown, setCountdown] = useState(base.countdown ?? false);
  const [priv, setPriv] = useState(base.privacy === 'busy');
  const [ask, setAsk] = useState(!editing);
  // Moving a shared plan asks the partner about the new time (review 0009, P-4).
  const [askMove, setAskMove] = useState(true);
  // My reminders: what the plan has, or my defaults for a new plan.
  const [reminders, setReminders] = useState<number[]>(() => {
    if (editing) return remindersOf(base, me);
    const defs = defaultReminders(me);
    return allDay0 ? defs.all_day : defs.timed;
  });
  const [error, setError] = useState<string | null>(null);
  /** Saving would bring back skipped or moved days: asked once (review 0009, P-6). */
  const [lostOk, setLostOk] = useState(false);

  const custom = !!repeat && !REPEAT_CHOICES.some(([v]) => v === repeat);
  const parts = readRule(repeat);
  // The plan's own weekday, ticked when no days are chosen.
  const firstDay = DAY_CODES[new Date(`${startDate || today.value}T12:00`).getDay()] as string;
  const ws = weekStartsOn.value;
  const weekdays = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = (ws + i) % 7;
    const date = new Date(2026, 10, 1 + d); // 1 Nov 2026 is a Sunday
    return [
      DAY_CODES[d] as string,
      date.toLocaleDateString(undefined, { weekday: 'narrow' }),
      date.toLocaleDateString(undefined, { weekday: 'long' }),
    ] as const;
  });

  const save = (e: Event) => {
    e.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give the plan a name.');
    if (!startDate) return setError('Choose a day.');
    const start = allDay ? startDate : `${startDate}T${startTime}`;
    let end: string;
    if (allDay) {
      if (endDate < startDate) return setError('The last day can’t be before the first.');
      end = addDays(endDate, 1);
    } else {
      end = `${endDate || startDate}T${endTime}`;
      if (wallMinutes(start, end) <= 0) {
        // "9 PM to 1 AM" on the same day means the next morning.
        if (endDate === startDate || !endDate) end = `${addDays(startDate, 1)}T${endTime}`;
        else return setError('The end must be after the start.');
      }
    }
    if (repeat && !isValidRRule(repeat)) return setError('That repeat rule isn’t supported.');
    const owner: Slot | 'both' = who === 'me' ? me : who === 'partner' ? p : 'both';
    const fields = {
      title: name.slice(0, 200),
      start,
      end,
      all_day: allDay,
      tz: allDay ? null : tz,
      rrule: repeat || null,
      away: allDay && away,
      owner,
      location: location.trim() ? location.trim().slice(0, 200) : null,
      notes: notes.trim() ? notes.trim().slice(0, 4000) : null,
      countdown,
      remind: withReminders(base, me, reminders),
    };
    const isPrivate = who === 'me' && priv;
    try {
      if (existing?.rec.kind === 'event') {
        const lost = exceptionsLost(existing.rec.data, fields);
        if (lost && !lostOk) {
          setLostOk(true);
          return setError(
            `This changes which days the plan repeats on, so ${lost} skipped or moved ${
              lost === 1 ? 'day comes' : 'days come'
            } back. Save again to go ahead.`,
          );
        }
        let target = existing.id;
        if ((existing.rec.data.privacy === 'busy') !== isPrivate) {
          target = setEventPrivacy(existing.id, isPrivate);
        }
        const before = existing.rec.data;
        // A plan you both have, or theirs: they hear about changes to it.
        const shared = !isPrivate && before.privacy === 'full' && (owner === 'both' || owner === p);
        const moved = fields.start !== before.start || fields.end !== before.end;
        const renamed = fields.title !== before.title;
        const placed = fields.location !== before.location;
        const was =
          shared && (moved || renamed || placed)
            ? {
                by: me,
                ...(moved ? { start: before.start, end: before.end } : {}),
                ...(renamed ? { title: before.title } : {}),
                ...(placed ? { location: before.location } : {}),
              }
            : null;
        const asking = !!was && moved && askMove && before.status === 'confirmed';
        updateEvent(target, {
          ...fields,
          ...(was ? { was: asking ? { ...was, confirmed: true } : was } : {}),
          ...(asking ? { status: 'proposed' as const, proposed_by: me } : {}),
        });
        if (asking) noticeMove(target);
        else if (was) noticeChange(target);
        sheet.value = { type: 'event', id: target };
        toast(asking ? `Asked ${nameOf(p)} about the new time.` : 'Plan updated.');
      } else {
        const proposing = who !== 'me' && ask;
        const newId = createEvent({
          ...fields,
          status: proposing ? 'proposed' : 'confirmed',
          proposed_by: proposing ? me : null,
          privacy: isPrivate ? 'busy' : 'full',
          stub_id: null,
          ...(base.from_item ? { from_item: base.from_item } : {}),
        });
        if (proposing) noticeProposal(newId);
        close();
        afterAdd.value?.();
        toast(
          proposing
            ? `Sent to ${nameOf(p)}. It’s tentative until they say yes.`
            : countdown
              ? 'Added. It’s counting down on your Plan screen.'
              : 'Plan added.',
        );
      }
    } catch {
      setError('That plan couldn’t be saved. Check the dates and times.');
    }
  };

  // Editing a confirmed plan you share and changing its time.
  const startNow = allDay ? startDate : `${startDate}T${startTime}`;
  const endNow = allDay ? addDays(endDate || startDate, 1) : `${endDate || startDate}T${endTime}`;
  const movingShared =
    existing?.rec.kind === 'event' &&
    existing.rec.data.status === 'confirmed' &&
    existing.rec.data.privacy === 'full' &&
    who !== 'me' &&
    (startNow !== existing.rec.data.start || endNow !== existing.rec.data.end);

  const options: [Who, string][] = [
    ['me', 'Mine'],
    ['ours', 'Ours'],
    ['partner', `${nameOf(p)}’s`],
  ];

  return (
    <Sheet labelledBy="pf-title" onClose={close}>
      <div class="sh-head">
        <span class="owner">{editing ? 'Edit plan' : 'New plan'}</span>
        <CloseButton onClose={close} />
      </div>
      <h2 id="pf-title" class="sr">
        {editing ? 'Edit plan' : 'New plan'}
      </h2>
      {editing && base.rrule && (
        <p class="note small">
          This changes every day of this repeating plan. To change one day, use Move this day on
          that day.
        </p>
      )}
      <form class="stack gap planform" onSubmit={save} noValidate>
        <div class="field">
          <label for="pf-name">What</label>
          <input
            id="pf-name"
            class="txt"
            value={title}
            maxLength={200}
            required
            data-autofocus={!editing || typeFirst() || undefined}
            onInput={(e) => setTitle(e.currentTarget.value)}
            autocomplete="off"
          />
        </div>

        <div class="field">
          <span class="lbl" id="pf-who">
            Whose plan
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
          <div class="seg" role="group" aria-labelledby="pf-who">
            {options.map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-pressed={who === key}
                onClick={() => setWho(key)}
              >
                {key === 'ours' ? (
                  <Marker owner="both" />
                ) : (
                  <Marker owner={key === 'me' ? me : p} />
                )}
                {label}
              </button>
            ))}
          </div>
        </div>

        <Switch
          checked={allDay}
          onChange={setAllDay}
          label="All day"
          hint="Birthdays, trips, days off."
        />

        <div class="row2">
          <div class="field">
            <label for="pf-sd">{allDay ? 'First day' : 'Starts'}</label>
            <input
              id="pf-sd"
              class="txt"
              type="date"
              value={startDate}
              onInput={(e) => {
                const v = e.currentTarget.value;
                // Keep the length when the start moves.
                if (v && endDate) {
                  const len = Math.round(wallMinutes(startDate, endDate) / 1440);
                  setEndDate(addDays(v, Math.max(0, len)));
                }
                setStartDate(v);
              }}
            />
          </div>
          {!allDay && (
            <div class="field">
              <label for="pf-st">Start time</label>
              <input
                id="pf-st"
                class="txt"
                type="time"
                value={startTime}
                onInput={(e) => setStartTime(e.currentTarget.value)}
              />
            </div>
          )}
        </div>
        <div class="row2">
          <div class="field">
            <label for="pf-ed">{allDay ? 'Last day' : 'Ends'}</label>
            <input
              id="pf-ed"
              class="txt"
              type="date"
              value={endDate}
              min={startDate}
              onInput={(e) => setEndDate(e.currentTarget.value)}
            />
          </div>
          {!allDay && (
            <div class="field">
              <label for="pf-et">End time</label>
              <input
                id="pf-et"
                class="txt"
                type="time"
                value={endTime}
                onInput={(e) => setEndTime(e.currentTarget.value)}
              />
            </div>
          )}
        </div>

        {!allDay && (
          <details class="tzpick" open={tz !== zone}>
            <summary class="small muted">
              Time zone: {tz.replace(/_/g, ' ')}
              {tz === zone ? ' (here)' : ''}
            </summary>
            <div class="field">
              <label for="pf-tz">Times are in</label>
              <select
                id="pf-tz"
                class="txt"
                value={tz}
                onChange={(e) => setTz(e.currentTarget.value)}
              >
                {zoneChoices(tz).map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                    {z === zone ? ' (here)' : ''}
                  </option>
                ))}
              </select>
              <p class="small muted">
                For a plan somewhere else, like a flight or a call abroad: it shows at the right
                time here.
              </p>
            </div>
          </details>
        )}
        <div class="field">
          <label for="pf-rep">Repeats</label>
          <select
            id="pf-rep"
            class="txt"
            value={parts ? parts.base : repeat}
            onChange={(e) => {
              const v = e.currentTarget.value;
              // A new "how often" keeps the end, and the weekdays if still weekly.
              setRepeat(
                v && parts && REPEAT_CHOICES.some(([c]) => c === v)
                  ? writeRule({ ...parts, base: v })
                  : v,
              );
            }}
          >
            {REPEAT_CHOICES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
            {custom && !parts && <option value={repeat}>{repeatText(repeat) || 'Custom'}</option>}
            {parts && !REPEAT_CHOICES.some(([c]) => c === parts.base) && (
              <option value={parts.base}>{repeatText(parts.base) || 'Custom'}</option>
            )}
          </select>
        </div>
        {parts?.base.startsWith('FREQ=WEEKLY') && (
          <div class="field">
            <span class="lbl" id="pf-days">
              On
            </span>
            {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled */}
            <div class="chips daypick" role="group" aria-labelledby="pf-days">
              {weekdays.map(([code, label, long]) => {
                const on = parts.byday.includes(code) || (!parts.byday.length && code === firstDay);
                return (
                  <button
                    type="button"
                    key={code}
                    class="chip"
                    aria-pressed={on}
                    aria-label={long}
                    onClick={() => {
                      const cur = parts.byday.length ? parts.byday : [firstDay];
                      const next = on ? cur.filter((d) => d !== code) : [...cur, code];
                      if (next.length) setRepeat(writeRule({ ...parts, byday: next }));
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {parts && (
          <div class="row2">
            <div class="field">
              <label for="pf-ends">Ends</label>
              <select
                id="pf-ends"
                class="txt"
                value={parts.until ? 'on' : parts.count ? 'after' : 'never'}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setRepeat(
                    writeRule({
                      ...parts,
                      until: v === 'on' ? addDays(startDate || today.value, 70) : null,
                      count: v === 'after' ? 10 : null,
                    }),
                  );
                }}
              >
                <option value="never">Never</option>
                <option value="on">On a date</option>
                <option value="after">After a number of times</option>
              </select>
            </div>
            {parts.until && (
              <div class="field">
                <label for="pf-until">Last day</label>
                <input
                  id="pf-until"
                  class="txt"
                  type="date"
                  value={parts.until}
                  min={startDate}
                  onInput={(e) =>
                    e.currentTarget.value &&
                    setRepeat(writeRule({ ...parts, until: e.currentTarget.value }))
                  }
                />
              </div>
            )}
            {!parts.until && parts.count !== null && (
              <div class="field">
                <label for="pf-count">Times</label>
                <input
                  id="pf-count"
                  class="txt"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={500}
                  value={parts.count}
                  onInput={(e) => {
                    const n = Math.round(Number(e.currentTarget.value));
                    if (n >= 1 && n <= 500) setRepeat(writeRule({ ...parts, count: n }));
                  }}
                />
              </div>
            )}
          </div>
        )}

        <div class="field">
          <label for="pf-loc">
            Where <span class="opt">optional</span>
          </label>
          <input
            id="pf-loc"
            class="txt"
            value={location}
            maxLength={200}
            onInput={(e) => setLocation(e.currentTarget.value)}
            autocomplete="off"
          />
        </div>
        <div class="field">
          <label for="pf-notes">
            Notes <span class="opt">optional</span>
          </label>
          <textarea
            id="pf-notes"
            class="txt"
            value={notes}
            maxLength={4000}
            onInput={(e) => setNotes(e.currentTarget.value)}
          />
        </div>

        {who !== 'partner' && (
          <ReminderPicker value={reminders} allDay={allDay} onChange={setReminders} hint={false} />
        )}

        <Switch
          checked={countdown}
          onChange={setCountdown}
          label="Count down to this"
          hint="Shows how many days are left at the top of your Plan screen."
        />
        {allDay && (
          <Switch
            checked={away}
            onChange={setAway}
            label="Away"
            hint="Out of town or unavailable: these days aren’t suggested as free."
          />
        )}
        {who === 'me' ? (
          <Switch
            checked={priv}
            onChange={setPriv}
            label="Keep the details private"
            hint={`${nameOf(p)} sees “Busy” and nothing else.`}
          />
        ) : !editing ? (
          <Switch
            checked={ask}
            onChange={setAsk}
            label={`Ask ${nameOf(p)} first`}
            hint="It stays tentative until they say yes."
          />
        ) : (
          movingShared && (
            <Switch
              checked={askMove}
              onChange={setAskMove}
              label={`Ask ${nameOf(p)} about the new time`}
              hint="Tentative at the new time until they say yes. If they can’t make it, it goes back."
            />
          )
        )}

        {error && (
          <p class="formerr" role="alert">
            {error}
          </p>
        )}
        <button class="btn primary big" type="submit">
          {editing ? 'Save changes' : who !== 'me' && ask ? `Send to ${nameOf(p)}` : 'Add plan'}
        </button>
      </form>
    </Sheet>
  );
}
