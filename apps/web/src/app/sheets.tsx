// SPDX-License-Identifier: AGPL-3.0-or-later
/** Quick add and event details sheets. */

import { parseQuickAdd, type Weekday } from '@ours/core/parse';
import { addDays, addWallMinutes, toInstant, wallMinutes } from '@ours/core/time';
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { AddToCalendar } from './addtocal';
import { FreeTimeSheet } from './freetime';
import {
  copyList,
  countOf,
  createList,
  currentList,
  type ListEntry,
  listsForPlan,
  pastChecklists,
  STARTING_POINTS,
  type StartingPoint,
  savedStartingPoints,
} from './lists';
import {
  addComment,
  commentsFor,
  createEvent,
  deleteEvent,
  type EventData,
  findEntry,
  nameOf,
  partner,
  type Slot,
  setEventPrivacy,
  update,
  updateEvent,
  viewer,
} from './model';
import { noticeAnswer, noticeMove, noticeNote, noticeProposal, noticeRemoved } from './notices';
import { PlaceLink } from './place';
import { type Draft, PlanForm, REPEAT_CHOICES } from './planform';
import { ReminderPicker } from './reminderpicker';
import { remindersOf, withDefaultReminders, withReminders } from './reminders';
import {
  clashText,
  conflictsFor,
  DATE_ORDER,
  fmtTime,
  ownerLabel,
  planWhen,
  type Row,
  relDay,
  repeatText,
  today,
  weekStartsOn,
  whenText,
  zone,
} from './select';
import { routinesDuring, skipRoutines } from './series';
import { dayTimes, ThisDay } from './thisday';
import { Avatar, CloseButton, Icon, Marker, Sheet, Switch, toast } from './ui';

export interface QuickPreset {
  text?: string;
  date?: string;
  time?: string;
  who?: 'me' | 'ours' | 'partner';
  placeholder?: string;
  /** How long, when it's known (a date idea's rough length); otherwise an hour. */
  minutes?: number;
  /** The idea (a list item) it's planned from, so the idea shows it's planned (L-10). */
  fromItem?: string;
}

export type SheetState =
  | { type: 'quick'; preset: QuickPreset }
  | { type: 'event'; id: string; occ?: string | null }
  | { type: 'edit'; id: string | null; draft?: Draft }
  | { type: 'import'; row: Row; date: string }
  | { type: 'free'; date: string }
  | null;
export const sheet = signal<SheetState>(null);
export const openQuick = (preset: QuickPreset = {}) => {
  sheet.value = { type: 'quick', preset };
};
/** A plan's sheet. `occ` names the day it was opened from, for a repeating plan. */
export const openEvent = (id: string, occ?: string | null) => {
  sheet.value = { type: 'event', id, occ: occ ?? null };
};
/** Time you're both free on a day, and date ideas that fit it. */
export const openFreeTime = (date: string) => {
  sheet.value = { type: 'free', date };
};
/** The full form: edit a plan, or make one with every option. */
export const openPlanForm = (id: string | null, draft?: Draft) => {
  sheet.value = { type: 'edit', id, ...(draft ? { draft } : {}) };
};
export const openImport = (row: Row, date: string) => {
  sheet.value = { type: 'import', row, date };
};
const close = () => {
  sheet.value = null;
};

/** Called after a write that should show on the Plan tab. */
export const afterAdd = signal<(() => void) | null>(null);

export function SheetHost() {
  const s = sheet.value;
  if (!s) return null;
  if (s.type === 'quick') return <QuickAdd key="quick" preset={s.preset} />;
  if (s.type === 'import') return <ImportSheet key={s.row.key} row={s.row} date={s.date} />;
  if (s.type === 'free') return <FreeTimeSheet key={s.date} date={s.date} />;
  if (s.type === 'edit')
    return <PlanForm key={s.id ?? 'new'} id={s.id} {...(s.draft ? { draft: s.draft } : {})} />;
  return <EventSheet key={`${s.id}:${s.occ ?? ''}`} id={s.id} occ={s.occ ?? null} />;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Whose = 'me' | 'ours' | 'partner';
const WHO_KEY = 'ours-qa-who';
const lastWho = (): Whose | null => {
  try {
    const v = localStorage.getItem(WHO_KEY);
    return v === 'me' || v === 'ours' || v === 'partner' ? v : null;
  } catch {
    return null;
  }
};
const rememberWho = (w: Whose) => {
  try {
    localStorage.setItem(WHO_KEY, w);
  } catch {
    // private mode: nothing to remember
  }
};

/**
 * "Overlaps Book club (yours)" or "Alex is busy then" for a plan's time
 * (review 0009, P-3): from the plans, Busy markers and imported calendars
 * already on this device. Nothing for all-day plans.
 */
export function ClashNote({
  start,
  end,
  allDay,
  tz,
  owner,
  except,
}: {
  start: string;
  end: string;
  allDay: boolean;
  tz: string | null;
  owner: Slot | 'both';
  except?: string;
}) {
  if (allDay || !start.includes('T') || !end.includes('T')) return null;
  let rows: Row[] = [];
  try {
    rows = conflictsFor(toInstant(start, tz ?? zone), toInstant(end, tz ?? zone), owner, except);
  } catch {
    return null;
  }
  const text = clashText(rows, { me: viewer.value, partner: nameOf(partner.value) });
  return text ? (
    <p class="clash">
      <Icon name="flag" size={14} />
      {text}
    </p>
  ) : null;
}

/** On a trip: the routines it clashes with, skipped in one go (review 0009, P-6). */
function SkipWhileAway({ id, e }: { id: string; e: EventData }) {
  const from = e.start.slice(0, 10);
  const to = addDays(e.end.slice(0, 10), -1);
  const ids = routinesDuring(e.owner, from, to).filter((x) => x !== id);
  if (!ids.length || to < today.value) return null;
  const names = ids
    .map((x) => findEntry(x))
    .map((x) => (x?.rec.kind === 'event' ? x.rec.data.title : ''))
    .filter(Boolean);
  return (
    <p class="small">
      {names.slice(0, 3).join(', ')}
      {names.length > 3 ? ` and ${names.length - 3} more` : ''} still repeat on these days.{' '}
      <button
        type="button"
        class="linkbtn"
        onClick={() => {
          const r = skipRoutines(ids, from, to);
          toast(
            `Skipped ${r.n} ${r.n === 1 ? 'day' : 'days'} of routines while you’re away.`,
            r.undo,
          );
        }}
      >
        Skip them while away
      </button>
    </p>
  );
}

/* ---------- quick add ---------- */

function QuickAdd({ preset }: { preset: QuickPreset }) {
  const me = viewer.value;
  const p = partner.value;
  const [text, setText] = useState(preset.text ?? '');
  // Whose: picked by hand, else "#private" makes it Mine, else the last choice (review 0009, P-9).
  const [whoPick, setWho] = useState<Whose | null>(preset.who ?? null);
  const [remembered] = useState<Whose>(() => lastWho() ?? 'ours');
  const [askPick, setAsk] = useState<boolean | null>(null);
  const [priv, setPriv] = useState(false);
  const [dateOverride, setDate] = useState<string | null>(null);
  const [timeOverride, setTime] = useState<string | null>(null);
  const [repeatOverride, setRepeat] = useState<string | null>(null);

  const parsed = parseQuickAdd(text, {
    today: today.value,
    dateOrder: DATE_ORDER,
    weekStart: weekStartsOn.value as Weekday,
  });
  const who: Whose = whoPick ?? (parsed.private ? 'me' : remembered);
  // A trailing "?" ("dinner fri?") always asks; otherwise asking is the default.
  const ask = askPick ?? true;
  const date = dateOverride ?? parsed.date ?? preset.date ?? today.value;
  // "sat-sun", "dec 3-10": the last day, unless the day was picked by hand.
  const lastDay = !dateOverride && parsed.endDate && parsed.endDate > date ? parsed.endDate : null;
  const time = timeOverride ?? parsed.time ?? preset.time ?? '';
  // What was typed ("every saturday") sets the repeat until it is chosen by hand.
  const repeat = repeatOverride ?? parsed.rrule ?? '';
  const title = parsed.title
    ? capitalise(parsed.title)
    : !text.trim() && preset.placeholder
      ? preset.placeholder
      : '';
  const proposing = who !== 'me' && (ask || parsed.ask);
  const startAt = time ? `${date}T${time}` : date;
  const owner: Slot | 'both' = who === 'me' ? me : who === 'partner' ? p : 'both';
  const endAt = (minutes: number): string => {
    if (!time) return addDays(lastDay ?? date, 1);
    const typed = parsed.endTime && !timeOverride ? parsed.endTime : null;
    if (lastDay) return `${lastDay}T${typed ?? time}`;
    if (!typed) return addWallMinutes(startAt, minutes);
    const end = `${date}T${typed}`;
    return end > startAt ? end : `${addDays(date, 1)}T${typed}`;
  };
  // Typed a time: say if it overlaps something (P-3).
  let clash: string | null = null;
  if (time && text.trim()) {
    try {
      const at = toInstant(startAt, zone);
      clash = clashText(conflictsFor(at, toInstant(endAt(preset.minutes ?? 60), zone), owner), {
        me,
        partner: nameOf(p),
      });
    } catch {
      clash = null;
    }
  }
  const isPrivate = who === 'me' && (priv || parsed.private);

  const submit = (e: Event) => {
    e.preventDefault();
    if (!title) return;
    const owner: Slot | 'both' = who === 'me' ? me : who === 'partner' ? p : 'both';
    const start = startAt;
    const end = endAt(preset.minutes ?? 60);
    rememberWho(who);
    try {
      const draft: EventData = {
        title,
        start,
        end,
        all_day: !time,
        tz: time ? zone : null,
        rrule: repeat || null,
        away: false,
        owner,
        status: proposing ? 'proposed' : 'confirmed',
        proposed_by: proposing ? me : null,
        privacy: isPrivate ? 'busy' : 'full',
        location: parsed.place,
        notes: null,
        countdown: false,
        stub_id: null,
        ...(preset.fromItem ? { from_item: preset.fromItem } : {}),
      };
      const id = createEvent(owner === p ? draft : withDefaultReminders(draft, me));
      if (proposing) noticeProposal(id);
    } catch {
      toast('That plan couldn’t be saved. Check the title and time.');
      return;
    }
    close();
    afterAdd.value?.();
    toast(
      proposing
        ? `Sent to ${nameOf(p)}. It’s tentative until they say yes.`
        : `Added to ${relDay(date)}.`,
    );
  };

  const options: [typeof who, string][] = [
    ['me', 'Mine'],
    ['ours', 'Ours'],
    ['partner', `${nameOf(p)}’s`],
  ];

  return (
    <Sheet labelledBy="sh-title" onClose={close}>
      <form class="sheet-form" onSubmit={submit}>
        <div class="sh-head">
          <h2 id="sh-title">New plan</h2>
          <CloseButton onClose={close} />
        </div>
        <input
          data-autofocus
          class="txt qa-main"
          type="text"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          placeholder={preset.placeholder ?? 'Dinner with Jordan fri 7:30pm @ Vic’s'}
          autocomplete="off"
          aria-label="What’s the plan?"
          aria-describedby="qa-prev"
        />
        <p class="qa-hint" id="qa-prev" aria-live="polite">
          {text.trim() ? (
            <>
              <span class="pchip">
                <Icon name="cal" size={13} />
                {relDay(date)}
                {lastDay && ` – ${relDay(lastDay)}`}
              </span>
              <span class="pchip">
                <Icon name="clock" size={13} />
                {time
                  ? fmtTime(time) +
                    (parsed.endTime && !timeOverride ? ` – ${fmtTime(parsed.endTime)}` : '')
                  : 'All day'}
              </span>
              {repeat && (
                <span class="pchip">
                  <Icon name="repeat" size={13} />
                  {repeatText(repeat)}
                </span>
              )}
              {parsed.place && (
                <span class="pchip">
                  <Icon name="pin" size={13} />
                  {parsed.place}
                </span>
              )}
              {clash && (
                <span class="pchip warn">
                  <Icon name="flag" size={13} />
                  {clash}
                </span>
              )}
              {parsed.private && who === 'me' && (
                <span class="pchip">
                  <Icon name="lock" size={13} />
                  Private
                </span>
              )}
            </>
          ) : (
            'Type it the way you’d say it. Try “tomorrow 8am” or “sat @ the park”.'
          )}
        </p>
        <div class="row2">
          <div class="field">
            <label for="qa-date">Day</label>
            <input
              id="qa-date"
              class="txt"
              type="date"
              value={date}
              onInput={(e) => setDate(e.currentTarget.value || null)}
            />
          </div>
          <div class="field">
            <label for="qa-time">
              Time <span class="opt">optional</span>
            </label>
            <input
              id="qa-time"
              class="txt"
              type="time"
              value={time}
              onInput={(e) => setTime(e.currentTarget.value)}
            />
          </div>
        </div>
        <div class="field">
          <label for="qa-rep">Repeats</label>
          <select
            id="qa-rep"
            class="txt"
            value={repeat}
            onChange={(e) => setRepeat(e.currentTarget.value)}
          >
            {REPEAT_CHOICES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
            {repeat && !REPEAT_CHOICES.some(([v]) => v === repeat) && (
              <option value={repeat}>{repeatText(repeat)}</option>
            )}
          </select>
        </div>
        <div class="field">
          <span class="lbl" id="who-l">
            Whose plan
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
          <div class="seg" role="group" aria-labelledby="who-l">
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
        {who === 'me' ? (
          <Switch
            checked={priv || parsed.private}
            onChange={setPriv}
            label="Keep the details private"
            hint={`${nameOf(p)} sees “Busy” and nothing else.`}
          />
        ) : (
          <Switch
            checked={ask || parsed.ask}
            onChange={setAsk}
            label={`Ask ${nameOf(p)} first`}
            hint="It stays tentative until they say yes."
          />
        )}
        <button class="btn primary big" type="submit" disabled={!title}>
          {proposing ? `Send to ${nameOf(p)}` : 'Add plan'}
        </button>
        <button
          type="button"
          class="linkbtn"
          onClick={() => {
            const owner: Slot | 'both' = who === 'me' ? me : who === 'partner' ? p : 'both';
            openPlanForm(null, {
              title,
              owner,
              all_day: !time,
              start: startAt,
              end: endAt(60),
              location: parsed.place,
              rrule: repeat || null,
              privacy: isPrivate ? 'busy' : 'full',
              ...(preset.fromItem ? { from_item: preset.fromItem } : {}),
            });
          }}
        >
          More options: several days, notes, countdown, away
        </button>
      </form>
    </Sheet>
  );
}

/* ---------- event details ---------- */

export function accept(id: string): void {
  const e = findEntry(id);
  if (e?.rec.kind !== 'event') return;
  update<'event'>(id, { status: 'confirmed' });
  // Saying yes adds my default reminders, as for a plan I made.
  const withMine = withDefaultReminders(e.rec.data, viewer.value);
  if (withMine.remind !== e.rec.data.remind) update<'event'>(id, { remind: withMine.remind });
  noticeAnswer(id, true);
  toast(`Added. ${nameOf(e.rec.data.proposed_by ?? partner.value)} will see your yes.`);
}

/**
 * Answers a request with another time (review 0009, P-4): the plan moves
 * there, tentative, and it's now their turn to say yes. Keeps its length.
 */
export function SuggestTime({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const e = findEntry(id);
  const d = e?.rec.kind === 'event' ? e.rec.data : null;
  const [date, setDate] = useState(d?.start.slice(0, 10) ?? today.value);
  const [time, setTime] = useState(d && !d.all_day ? d.start.slice(11, 16) : '19:00');
  if (d?.status !== 'proposed' || d.proposed_by === viewer.value || d.rrule) return null;
  if (!open)
    return (
      <button type="button" class="btn ghost" onClick={() => setOpen(true)}>
        Suggest another time
      </button>
    );
  const send = (ev: Event) => {
    ev.preventDefault();
    if (!date) return;
    const me = viewer.value;
    const start = d.all_day ? date : `${date}T${time}`;
    const end = d.all_day
      ? addDays(date, Math.max(1, Math.round(wallMinutes(d.start, d.end) / 1440)))
      : addWallMinutes(start, wallMinutes(d.start, d.end));
    updateEvent(id, {
      start,
      end,
      status: 'proposed',
      proposed_by: me,
      was: { by: me, start: d.start, end: d.end },
    });
    noticeMove(id);
    toast(`Suggested. ${nameOf(partner.value)} can say yes to the new time.`);
  };
  return (
    <form class="suggest" onSubmit={send}>
      <div class="row2">
        <div class="field">
          <label for={`sg-d-${id}`}>Day</label>
          <input
            id={`sg-d-${id}`}
            class="txt"
            type="date"
            value={date}
            min={today.value}
            onInput={(ev) => setDate(ev.currentTarget.value)}
          />
        </div>
        {!d.all_day && (
          <div class="field">
            <label for={`sg-t-${id}`}>Time</label>
            <input
              id={`sg-t-${id}`}
              class="txt"
              type="time"
              value={time}
              onInput={(ev) => setTime(ev.currentTarget.value)}
            />
          </div>
        )}
      </div>
      <ClashNote
        start={d.all_day ? date : `${date}T${time}`}
        end={d.all_day ? date : addWallMinutes(`${date}T${time}`, wallMinutes(d.start, d.end))}
        allDay={d.all_day}
        tz={d.tz}
        owner={d.owner}
        except={id}
      />
      <div class="btnrow">
        <button class="btn primary" type="submit">
          Suggest it
        </button>
        <button type="button" class="btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Says no to a proposal. It disappears for me; my partner sees the answer. */
export function decline(id: string): void {
  const e = findEntry(id);
  if (e?.rec.kind !== 'event') return;
  const d = e.rec.data;
  // A move asked about: "can't make it" keeps the plan at its old time (P-4).
  if (d.was?.start && d.was.end && d.was.by === d.proposed_by && d.was.confirmed) {
    const before = {
      start: d.start,
      end: d.end,
      status: d.status,
      proposed_by: d.proposed_by,
      was: d.was,
    };
    updateEvent(id, {
      start: d.was.start,
      end: d.was.end,
      status: 'confirmed',
      proposed_by: null,
      was: null,
    });
    noticeAnswer(id, false);
    toast(
      `Kept at the old time. ${nameOf(partner.value)} will see you can’t make the new one.`,
      () => updateEvent(id, before),
    );
    return;
  }
  update<'event'>(id, { status: 'declined' });
  noticeAnswer(id, false);
  toast(`Declined. ${nameOf(partner.value)} will see you can’t make it.`, () =>
    update<'event'>(id, { status: 'proposed' }),
  );
}

function EventSheet({ id, occ }: { id: string; occ: string | null }) {
  const entry = findEntry(id);
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState('');
  const me = viewer.value;
  const p = partner.value;
  if (!entry || (entry.rec.kind !== 'event' && entry.rec.kind !== 'busy_stub')) return null;
  const r = entry.rec;
  const when = planWhen(r.data);

  if (r.kind === 'busy_stub') {
    return (
      <Sheet labelledBy="sh-title" onClose={close}>
        <div class="sh-head">
          <span class="owner">
            <Marker owner={r.data.owner} mode="busy" />
            {nameOf(r.data.owner)}
          </span>
          <CloseButton onClose={close} />
        </div>
        <h2 id="sh-title">Busy</h2>
        <p class="when">{when}</p>
        <p class="note">
          <Icon name="lock" size={15} />
          <span>
            {nameOf(r.data.owner)} keeps the details of this one private. Your device never receives
            them.
          </span>
        </p>
      </Sheet>
    );
  }

  const e = r.data;
  const comments = commentsFor(id);
  const proposed = e.status === 'proposed';
  const canDelete = e.owner === 'both' || e.owner === me || e.proposed_by === me;
  // The day this sheet was opened from, if the plan repeats.
  const day = e.rrule && occ ? occ : null;
  const del = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    close();
    // A plan you share: they hear it's gone (P-4). Not for a request withdrawn.
    if (!(proposed && e.proposed_by === me) && (e.owner === 'both' || e.owner === p))
      noticeRemoved(id);
    const undo = deleteEvent(id);
    toast(proposed && e.proposed_by === me ? 'Request withdrawn.' : 'Plan deleted.', undo);
  };
  const send = (ev: Event) => {
    ev.preventDefault();
    const text = note.trim();
    if (!text) return;
    addComment(id, text);
    noticeNote(id, text);
    setNote('');
  };

  return (
    <Sheet labelledBy="sh-title" onClose={close}>
      <div class="sh-head">
        <span class="owner">
          <Marker owner={e.owner} {...(proposed ? { mode: 'dash' as const } : {})} />
          {ownerLabel(e.owner, { a: nameOf('a'), b: nameOf('b') })}
          {proposed ? ' · tentative' : ''}
          {e.privacy === 'busy' ? ' · private' : ''}
        </span>
        <CloseButton onClose={close} />
      </div>
      <h2 id="sh-title">{e.title}</h2>
      <p class="when">{day ? planWhen({ ...dayTimes(e, day), all_day: e.all_day }) : when}</p>
      {e.status !== 'declined' && (
        <ClashNote
          {...(day ? dayTimes(e, day) : e)}
          allDay={e.all_day}
          tz={e.tz}
          owner={e.owner}
          except={id}
        />
      )}
      {e.location && <PlaceLink place={e.location} />}
      {e.rrule && (
        <p class="loc">
          <Icon name="repeat" size={15} />
          {repeatText(e.rrule)}
        </p>
      )}
      {day && canDelete && (
        <ThisDay
          id={id}
          e={e}
          occ={day}
          onDone={close}
          onSplit={(copy) => {
            openPlanForm(copy);
            toast('Days before stay as they were. Changes here apply from this day on.');
          }}
        />
      )}
      {e.away && e.all_day && !e.rrule && e.status === 'confirmed' && (
        <SkipWhileAway id={id} e={e} />
      )}
      {(e.countdown || e.away) && (
        <p class="loc">
          <Icon name="flag" size={15} />
          {[e.countdown ? 'Counting down on the Plan screen' : '', e.away ? 'Away' : '']
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {e.notes && <p class="notes">{e.notes}</p>}
      {proposed && e.proposed_by !== me && (
        <div class="ask-actions">
          <button
            type="button"
            class="btn primary"
            onClick={() => {
              close();
              accept(id);
            }}
          >
            <Icon name="check" size={16} />
            Yes, add it
          </button>
          <button
            type="button"
            class="btn ghost"
            onClick={() => {
              close();
              decline(id);
            }}
          >
            Can’t make it
          </button>
        </div>
      )}
      <SuggestTime id={id} />
      {proposed && e.proposed_by === me && (
        <p class="note">
          <Icon name="clock" size={15} />
          <span>Waiting on {nameOf(p)}. It stays tentative until they say yes.</span>
        </p>
      )}
      {e.status === 'declined' && e.proposed_by === me && (
        <>
          <p class="note">
            <Icon name="x" size={15} />
            <span>{nameOf(p)} can’t make it. Ask again, or remove it from your plan.</span>
          </p>
          <div class="ask-actions">
            <button
              type="button"
              class="btn"
              onClick={() => {
                update<'event'>(id, { status: 'proposed' });
                noticeProposal(id);
                toast(`Asked ${nameOf(p)} again.`);
              }}
            >
              Ask again
            </button>
            <button
              type="button"
              class="btn ghost"
              onClick={() => {
                close();
                toast('Removed.', deleteEvent(id));
              }}
            >
              Remove
            </button>
          </div>
        </>
      )}
      {e.owner === me && (
        <Switch
          checked={e.privacy === 'busy'}
          onChange={(busy) => {
            const newId = setEventPrivacy(id, busy);
            sheet.value = { type: 'event', id: newId };
            toast(
              busy ? `${nameOf(p)} now sees “Busy”.` : `${nameOf(p)} can see the details again.`,
            );
          }}
          label="Keep the details private"
          hint={`${nameOf(p)} sees “Busy” and nothing else.`}
        />
      )}
      {e.status !== 'declined' &&
        (e.owner === me || e.owner === 'both' || e.proposed_by === me) && (
          <ReminderPicker
            value={remindersOf(e, me)}
            allDay={e.all_day}
            onChange={(next) => update<'event'>(id, { remind: withReminders(e, me, next) })}
          />
        )}
      {e.status !== 'declined' && <PlanChecklists id={id} e={e} />}
      {e.status !== 'declined' && <AddToCalendar id={id} e={e} day={day} />}
      <div class="thread">
        <p class="eyebrow">Notes</p>
        {comments.length ? (
          comments.map((c) =>
            c.rec.kind === 'comment' ? (
              <div class={`msg${c.rec.data.author === me ? ' mine' : ''}`} key={c.id}>
                <Avatar slot={c.rec.data.author} small />
                <p>
                  <span class="sr">{nameOf(c.rec.data.author)}: </span>
                  {c.rec.data.text}
                </p>
              </div>
            ) : null,
          )
        ) : (
          <p class="nothing">No notes yet.</p>
        )}
        <form class="cform" onSubmit={send}>
          <input
            class="txt"
            type="text"
            value={note}
            onInput={(ev) => setNote(ev.currentTarget.value)}
            placeholder={
              e.privacy === 'busy' ? 'Add a note for yourself' : `Add a note for ${nameOf(p)}`
            }
            autocomplete="off"
            aria-label="Note"
          />
          <button class="iconbtn send" type="submit" aria-label="Send note">
            <Icon name="send" />
          </button>
        </form>
      </div>
      {canDelete && (
        <div class="sh-foot">
          <button type="button" class="btn sm" onClick={() => openPlanForm(id)}>
            {e.rrule ? 'Edit all days' : 'Edit'}
          </button>
          <button
            type="button"
            class="btn sm ghost"
            onClick={() =>
              // A new plan with the same details, to change the day (P-14).
              openPlanForm(null, {
                title: e.title,
                start: e.start,
                end: e.end,
                all_day: e.all_day,
                tz: e.tz,
                owner: e.owner,
                location: e.location,
                notes: e.notes,
                away: e.away,
                privacy: e.privacy,
                rrule: null,
              })
            }
          >
            <Icon name="copy" size={15} />
            Duplicate
          </button>
          <button type="button" class="linkbtn danger" onClick={del}>
            {armed
              ? 'Tap again to confirm'
              : proposed && e.proposed_by === me
                ? 'Withdraw request'
                : 'Delete plan'}
          </button>
        </div>
      )}
    </Sheet>
  );
}

/* ---------- a plan's checklists ---------- */

/** Packing or getting-ready lists for a plan, and a way to add one. */
function PlanChecklists({ id, e }: { id: string; e: EventData }) {
  const lists = listsForPlan(id);
  const [choosing, setChoosing] = useState(false);
  // A private plan's list is private too: the partner never sees either.
  const priv = e.privacy === 'busy';
  // The last trip's list, with its "days before" (review 0008, L-9), and
  // starting points saved with items.
  const earlier = pastChecklists(id)
    .filter((l) => l.rec.data.private === priv)
    .slice(0, 2);
  const saved = savedStartingPoints().filter((sp) => sp.listId);
  const make = (from: { copy: ListEntry } | { start: StartingPoint } | null) => {
    const name = `For ${e.title}`.slice(0, 100);
    let listId: string | null;
    if (from && 'copy' in from) listId = copyList(from.copy.id, { planId: id, name });
    else {
      const start = from?.start ?? STARTING_POINTS.find((sp) => sp.id === 'packing');
      listId = start ? createList(name, start, priv, { planId: id }) : null;
    }
    if (!listId) return;
    open(listId);
    toast(
      from
        ? 'Checklist made, unticked and ready.'
        : 'Checklist made. Give things a “days before” in their details.',
    );
  };
  const open = (listId: string) => {
    currentList.value = listId;
    close();
    location.hash = '#lists';
  };
  return (
    <div class="checklists">
      {lists.map((l) => {
        const { n, what } = countOf(l);
        return (
          <button type="button" class="btn sm" key={l.id} onClick={() => open(l.id)}>
            <Icon name="list" size={15} />
            {l.rec.data.name}
            <span class="small muted">
              {n} {what}
            </span>
          </button>
        );
      })}
      {choosing ? (
        <div class="stack gap">
          <p class="small muted">Start the checklist from:</p>
          <div class="btnrow">
            <button type="button" class="btn sm" onClick={() => make(null)}>
              Nothing yet
            </button>
            {earlier.map((l) => (
              <button type="button" class="btn sm" key={l.id} onClick={() => make({ copy: l })}>
                <Icon name="copy" size={15} />
                Last time: {l.rec.data.name}
              </button>
            ))}
            {saved.map((sp) => (
              <button type="button" class="btn sm" key={sp.id} onClick={() => make({ start: sp })}>
                <Icon name="list" size={15} />
                {sp.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button
          type="button"
          class="linkbtn"
          onClick={() => (earlier.length || saved.length ? setChoosing(true) : make(null))}
        >
          Add a checklist
        </button>
      )}
    </div>
  );
}

/* ---------- imported calendar event (read-only) ---------- */

function ImportSheet({ row, date }: { row: Row; date: string }) {
  const busy = row.type === 'busy';
  const who = row.owner === 'both' ? null : row.owner;
  return (
    <Sheet labelledBy="sh-title" onClose={close}>
      <div class="sh-head">
        <span class="owner">
          <Marker owner={row.owner} {...(busy ? { mode: 'busy' as const } : {})} />
          {ownerLabel(row.owner, { a: nameOf('a'), b: nameOf('b') })}
          {' · imported'}
        </span>
        <CloseButton onClose={close} />
      </div>
      <h2 id="sh-title">{row.title}</h2>
      <p class="when">{whenText(date, row.allDay, row.start, row.end)}</p>
      {row.location && <PlaceLink place={row.location} />}
      <p class="note">
        <Icon name="cal" size={15} />
        <span>
          {busy
            ? `${who ? nameOf(who) : 'Your partner'} shares only busy times from this calendar.`
            : `From ${row.source ?? 'an imported calendar'}. Read-only here: change it in the calendar app it came from.`}
          {row.free ? ' Marked as free, so it doesn’t block your evenings.' : ''}
        </span>
      </p>
    </Sheet>
  );
}
