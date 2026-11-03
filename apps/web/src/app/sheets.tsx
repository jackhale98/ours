// SPDX-License-Identifier: AGPL-3.0-or-later
/** Quick add and event details sheets. */
import { parseQuickAdd } from '@ours/core/parse';
import { addDays, addWallMinutes } from '@ours/core/time';
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { pushState, reminderLabel } from '../account/notify';
import {
  addComment,
  commentsFor,
  createEvent,
  deleteEvent,
  findEntry,
  mode,
  nameOf,
  partner,
  type Slot,
  setEventPrivacy,
  update,
  viewer,
} from './model';
import { noticeAnswer, noticeNote, noticeProposal } from './notices';
import { type Draft, PlanForm } from './planform';
import {
  fmtTime,
  ownerLabel,
  planWhen,
  type Row,
  relDay,
  repeatText,
  today,
  whenText,
  zone,
} from './select';
import { Avatar, CloseButton, Icon, Marker, Sheet, Switch, toast } from './ui';

export interface QuickPreset {
  text?: string;
  date?: string;
  time?: string;
  who?: 'me' | 'ours' | 'partner';
  placeholder?: string;
}

export type SheetState =
  | { type: 'quick'; preset: QuickPreset }
  | { type: 'event'; id: string }
  | { type: 'edit'; id: string | null; draft?: Draft }
  | { type: 'import'; row: Row; date: string }
  | null;
export const sheet = signal<SheetState>(null);
export const openQuick = (preset: QuickPreset = {}) => {
  sheet.value = { type: 'quick', preset };
};
export const openEvent = (id: string) => {
  sheet.value = { type: 'event', id };
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
  if (s.type === 'edit')
    return <PlanForm key={s.id ?? 'new'} id={s.id} {...(s.draft ? { draft: s.draft } : {})} />;
  return <EventSheet key={s.id} id={s.id} />;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- quick add ---------- */

function QuickAdd({ preset }: { preset: QuickPreset }) {
  const me = viewer.value;
  const p = partner.value;
  const [text, setText] = useState(preset.text ?? '');
  const [who, setWho] = useState<'me' | 'ours' | 'partner'>(preset.who ?? 'ours');
  const [ask, setAsk] = useState(true);
  const [priv, setPriv] = useState(false);
  const [dateOverride, setDate] = useState<string | null>(null);
  const [timeOverride, setTime] = useState<string | null>(null);

  const parsed = parseQuickAdd(text, { today: today.value });
  const date = dateOverride ?? parsed.date ?? preset.date ?? today.value;
  const time = timeOverride ?? parsed.time ?? preset.time ?? '';
  const title = parsed.title
    ? capitalise(parsed.title)
    : !text.trim() && preset.placeholder
      ? preset.placeholder
      : '';
  const proposing = who !== 'me' && ask;
  const isPrivate = who === 'me' && (priv || parsed.private);

  const submit = (e: Event) => {
    e.preventDefault();
    if (!title) return;
    const owner: Slot | 'both' = who === 'me' ? me : who === 'partner' ? p : 'both';
    const start = time ? `${date}T${time}` : date;
    let end = time ? addWallMinutes(start, 60) : addDays(date, 1);
    if (time && parsed.endTime && !timeOverride) {
      end = `${date}T${parsed.endTime}`;
      if (end <= start) end = `${addDays(date, 1)}T${parsed.endTime}`;
    }
    try {
      const id = createEvent({
        title,
        start,
        end,
        all_day: !time,
        tz: time ? zone : null,
        rrule: null,
        away: false,
        owner,
        status: proposing ? 'proposed' : 'confirmed',
        proposed_by: proposing ? me : null,
        privacy: isPrivate ? 'busy' : 'full',
        location: parsed.place,
        notes: null,
        countdown: false,
        stub_id: null,
      });
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
              </span>
              <span class="pchip">
                <Icon name="clock" size={13} />
                {time
                  ? fmtTime(time) +
                    (parsed.endTime && !timeOverride ? ` – ${fmtTime(parsed.endTime)}` : '')
                  : 'All day'}
              </span>
              {parsed.place && (
                <span class="pchip">
                  <Icon name="pin" size={13} />
                  {parsed.place}
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
            checked={ask}
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
            const start = time ? `${date}T${time}` : date;
            openPlanForm(null, {
              title,
              owner,
              all_day: !time,
              start,
              end: time
                ? parsed.endTime && !timeOverride
                  ? `${date}T${parsed.endTime}`
                  : addWallMinutes(start, 60)
                : addDays(date, 1),
              location: parsed.place,
              privacy: isPrivate ? 'busy' : 'full',
            });
          }}
        >
          More options: repeat, several days, notes, countdown
        </button>
      </form>
    </Sheet>
  );
}

/* ---------- event details ---------- */

const REMIND_OPTIONS = [0, 15, 60, 1440] as const;

export function accept(id: string): void {
  const e = findEntry(id);
  if (e?.rec.kind !== 'event') return;
  update<'event'>(id, { status: 'confirmed' });
  noticeAnswer(id, true);
  toast(`Added. ${nameOf(e.rec.data.proposed_by ?? partner.value)} will see your yes.`);
}

/** Says no to a proposal. It disappears for me; my partner sees the answer. */
export function decline(id: string): void {
  const e = findEntry(id);
  if (e?.rec.kind !== 'event') return;
  update<'event'>(id, { status: 'declined' });
  noticeAnswer(id, false);
  toast(`Declined. ${nameOf(partner.value)} will see you can’t make it.`, () =>
    update<'event'>(id, { status: 'proposed' }),
  );
}

function EventSheet({ id }: { id: string }) {
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
  const del = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    close();
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
      <p class="when">{when}</p>
      {e.location && (
        <p class="loc">
          <Icon name="pin" size={15} />
          {e.location}
        </p>
      )}
      {e.rrule && (
        <p class="loc">
          <Icon name="repeat" size={15} />
          {repeatText(e.rrule)}
        </p>
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
          <div class="field">
            <label for="remind">Remind me</label>
            <select
              id="remind"
              class="txt"
              value={String(e.remind?.[me] ?? 'none')}
              onChange={(ev) => {
                const v = ev.currentTarget.value;
                const minutes = v === 'none' ? null : Number(v);
                const prev = e.remind ?? { a: null, b: null };
                update<'event'>(id, { remind: { ...prev, [me]: minutes } });
              }}
            >
              <option value="none">No reminder</option>
              {REMIND_OPTIONS.map((m) => (
                <option key={m} value={String(m)}>
                  {reminderLabel(m)}
                </option>
              ))}
            </select>
            {mode.value === 'demo' ? (
              <p class="small muted">In the demo, reminders are saved but not sent.</p>
            ) : (
              pushState.value !== 'on' && (
                <p class="small muted">
                  Turn on notifications in Privacy to get reminders on this device.
                </p>
              )
            )}
          </div>
        )}
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
            Edit
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
      {row.location && (
        <p class="loc">
          <Icon name="pin" size={15} />
          {row.location}
        </p>
      )}
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
