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
  findEntry,
  nameOf,
  partner,
  type Slot,
  setEventPrivacy,
  updateEvent,
  viewer,
} from './model';
import { noticeProposal } from './notices';
import { repeatText, today, zone } from './select';
import { afterAdd, sheet } from './sheets';
import { CloseButton, Marker, Sheet, Switch, toast } from './ui';

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
  const [location, setLocation] = useState(base.location ?? '');
  const [notes, setNotes] = useState(base.notes ?? '');
  const [away, setAway] = useState(base.away ?? false);
  const [countdown, setCountdown] = useState(base.countdown ?? false);
  const [priv, setPriv] = useState(base.privacy === 'busy');
  const [ask, setAsk] = useState(!editing);
  const [error, setError] = useState<string | null>(null);

  const custom = !!repeat && !REPEAT_CHOICES.some(([v]) => v === repeat);

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
      tz: allDay ? null : (base.tz ?? zone),
      rrule: repeat || null,
      away: allDay && away,
      owner,
      location: location.trim() ? location.trim().slice(0, 200) : null,
      notes: notes.trim() ? notes.trim().slice(0, 4000) : null,
      countdown,
    };
    const isPrivate = who === 'me' && priv;
    try {
      if (existing?.rec.kind === 'event') {
        let target = existing.id;
        if ((existing.rec.data.privacy === 'busy') !== isPrivate) {
          target = setEventPrivacy(existing.id, isPrivate);
        }
        updateEvent(target, fields);
        sheet.value = { type: 'event', id: target };
        toast('Plan updated.');
      } else {
        const proposing = who !== 'me' && ask;
        const newId = createEvent({
          ...fields,
          status: proposing ? 'proposed' : 'confirmed',
          proposed_by: proposing ? me : null,
          privacy: isPrivate ? 'busy' : 'full',
          stub_id: null,
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
      <form class="stack gap planform" onSubmit={save} noValidate>
        <div class="field">
          <label for="pf-name">What</label>
          <input
            id="pf-name"
            class="txt"
            value={title}
            maxLength={200}
            required
            data-autofocus
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

        <div class="field">
          <label for="pf-rep">Repeats</label>
          <select
            id="pf-rep"
            class="txt"
            value={repeat}
            onChange={(e) => setRepeat(e.currentTarget.value)}
          >
            {REPEAT_CHOICES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
            {custom && <option value={repeat}>{repeatText(repeat) || 'Custom'}</option>}
          </select>
        </div>

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
        ) : (
          !editing && (
            <Switch
              checked={ask}
              onChange={setAsk}
              label={`Ask ${nameOf(p)} first`}
              hint="It stays tentative until they say yes."
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
