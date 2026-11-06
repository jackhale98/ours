// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * An item's details. Shows the fields its list has switched on (lists.ts
 * FEATURES): how long, due date or days before the plan, repeats, who's on
 * it and taking turns, how many, price, section, link, note, soon or
 * someday and seasons, and the times you did it, with how each of you found
 * it. Opened from any list row (Lists, the views across lists, the check-in).
 */

import type { IdeaLength, Reaction, Season } from '@ours/core/schema';
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { LENGTH_LABEL } from './freetime';
import {
  activeLists,
  didIt,
  featuresOf,
  type ItemEntry,
  keepSection,
  type ListEntry,
  money,
  moveItem,
  moveItems,
  movesScope,
  orderOf,
  peersOf,
  planForIdea,
  planOf,
  react,
  SEASON_NAME,
  sectionsOf,
} from './lists';
import { findEntry, nameOf, partner, remove, type Slot, update, viewer } from './model';
import { REPEAT_CHOICES } from './planform';
import { ReminderPicker } from './reminderpicker';
import { fmtLong, fmtTime, nextFreeEvening, relDay, repeatText, today } from './select';
import { openEvent, openQuick } from './sheets';
import { CloseButton, Icon, Marker, Sheet, Switch, toast, typeFirst } from './ui';

export const itemSheet = signal<string | null>(null);
const close = () => {
  itemSheet.value = null;
};

export function ItemSheetHost() {
  const id = itemSheet.value;
  if (!id) return null;
  const item = findEntry(id);
  if (item?.rec.kind !== 'item') return null;
  const list = findEntry(item.rec.data.list_id);
  if (list?.rec.kind !== 'list') return null;
  return <ItemSheet key={id} item={item as ItemEntry} list={list as ListEntry} />;
}

type Who = 'none' | 'me' | 'partner';

const REACTION_LABEL: Record<Reaction, string> = { loved: 'Loved it', good: 'Good', meh: 'Meh' };
export const BEFORE_CHOICES = [
  [null, 'No date'],
  [0, 'On the day'],
  [1, 'The day before'],
  [2, '2 days before'],
  [3, '3 days before'],
  [7, 'A week before'],
  [14, 'Two weeks before'],
] as const;

/** "12.99", "12,99" or "12" as hundredths; null for nothing; NaN if it isn't a price. */
export function parsePrice(text: string): number | null {
  const t = text.trim().replace(/[^\d.,]/g, '');
  if (!t) return null;
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(t);
  if (!m) return Number.NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}

function ItemSheet({ item, list }: { item: ItemEntry; list: ListEntry }) {
  const d = item.rec.data;
  const f = featuresOf(list);
  const me = viewer.value;
  const p = partner.value;
  const shared = item.scope === 'space';
  const forPlan = !!planOf(list);
  const [length, setLength] = useState<IdeaLength | null>(d.length ?? null);
  const [text, setText] = useState(d.text);
  const [due, setDue] = useState(d.due ?? '');
  const [before, setBefore] = useState<number | null>(d.before_days ?? null);
  const [repeat, setRepeat] = useState(d.repeat ?? '');
  const [time, setTimeRaw] = useState(d.time ?? '');
  const [reminders, setReminders] = useState<number[]>(d.reminders ?? []);
  // Reminders count from the time, or from 9 AM without one: adding or
  // removing the time would move them, so they start over.
  const setTime = (next: string) => {
    if (!!next !== !!time) setReminders([]);
    setTimeRaw(next);
  };
  const [rotate, setRotate] = useState(d.rotate ?? false);
  const [who, setWho] = useState<Who>(
    d.assignee === me ? 'me' : d.assignee === p ? 'partner' : 'none',
  );
  const [qty, setQty] = useState(d.qty ?? '');
  const [price, setPrice] = useState(d.price != null ? money(d.price) : '');
  const [section, setSection] = useState(d.section ?? '');
  const [link, setLink] = useState(d.link ?? '');
  const [note, setNote] = useState(d.note ?? '');
  const [when, setWhen] = useState(d.when ?? null);
  const [season, setSeason] = useState<Season[]>(d.season ?? []);
  const [again, setAgain] = useState(d.again ?? false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Changed but not saved: moving the item to another list waits for Save.
  // Worked out from the fields (a form-wide input handler would undo
  // checkbox clicks: Preact restores a controlled input after its event).
  const fields = JSON.stringify([
    length,
    text,
    due,
    time,
    reminders,
    before,
    repeat,
    rotate,
    who,
    qty,
    price,
    section,
    link,
    note,
    when,
    season,
    again,
  ]);
  const [initial] = useState(fields);
  const dirty = fields !== initial;
  const custom = !!repeat && !REPEAT_CHOICES.some(([v]) => v === repeat);
  const sections = sectionsOf(list.id);

  const save = (e: Event) => {
    e.preventDefault();
    const name = text.trim();
    if (!name) return setError('Give it a name.');
    const cents = f.has('price') ? parsePrice(price) : null;
    if (Number.isNaN(cents)) return setError('That price isn’t a number, like 12.99.');
    const url = link.trim();
    if (f.has('link') && url && !/^https?:\/\/\S+$/.test(url))
      return setError('Links start with https://');
    const assignee: Slot | null = who === 'me' ? me : who === 'partner' ? p : null;
    const useDue = f.has('due');
    update<'item'>(item.id, {
      text: name.slice(0, 500),
      ...(f.has('length') ? { length } : {}),
      ...(useDue && forPlan ? { before_days: before, due: null } : {}),
      ...(useDue && !forPlan
        ? {
            // A repeating task needs a date to count from: today if none was given.
            due: due || (repeat || time ? today.value : null),
            time: time || null,
            reminders: reminders.length ? reminders : null,
            repeat: repeat || null,
            rotate: !!repeat && shared && rotate,
          }
        : {}),
      ...(f.has('who') && f.has('tick') ? { assignee: shared ? assignee : null } : {}),
      ...(f.has('qty') ? { qty: qty.trim().slice(0, 30) || null } : {}),
      ...(f.has('price') ? { price: cents } : {}),
      ...(f.has('sections') ? { section: section.trim().slice(0, 60) || null } : {}),
      ...(f.has('link') ? { link: url || null } : {}),
      ...(f.has('notes') ? { note: note.trim().slice(0, 2000) || null } : {}),
      ...(f.has('when') ? { when, season } : {}),
      ...(f.has('did') ? { again } : {}),
    });
    if (f.has('sections')) keepSection(list.id, section.trim().slice(0, 60));
    close();
    toast(repeat && useDue ? `Saved. It repeats ${repeatText(repeat).toLowerCase()}.` : 'Saved.');
  };

  return (
    <Sheet labelledBy="is-title" onClose={close}>
      <div class="sh-head">
        <span class="owner">{shared ? `Shared with ${nameOf(p)}` : 'Just for you'}</span>
        <CloseButton onClose={close} />
      </div>
      <h2 id="is-title" class="sr">
        {d.text}
      </h2>
      {!f.has('tick') && (f.has('plan') || f.has('did')) && <IdeaActions item={item} />}
      <form class="stack gap planform" onSubmit={save} noValidate>
        <div class="field">
          <label for="is-name">What</label>
          <input
            id="is-name"
            class="txt"
            data-autofocus={typeFirst() || undefined}
            value={text}
            maxLength={500}
            onInput={(e) => setText(e.currentTarget.value)}
            autocomplete="off"
          />
        </div>
        {(f.has('qty') || f.has('price')) && (
          <div class="row2">
            {f.has('qty') && (
              <div class="field">
                <label for="is-qty">
                  How many <span class="opt">optional</span>
                </label>
                <input
                  id="is-qty"
                  class="txt"
                  value={qty}
                  maxLength={30}
                  placeholder="2, 500 g"
                  onInput={(e) => setQty(e.currentTarget.value)}
                  autocomplete="off"
                />
              </div>
            )}
            {f.has('price') && (
              <div class="field">
                <label for="is-price">
                  Price <span class="opt">optional</span>
                </label>
                <input
                  id="is-price"
                  class="txt"
                  inputMode="decimal"
                  value={price}
                  placeholder="12.99"
                  onInput={(e) => setPrice(e.currentTarget.value)}
                  autocomplete="off"
                />
              </div>
            )}
          </div>
        )}
        {f.has('sections') && (
          <div class="field">
            <label for="is-sec">
              Section <span class="opt">optional</span>
            </label>
            <input
              id="is-sec"
              class="txt"
              value={section}
              maxLength={60}
              list="is-sections"
              onInput={(e) => setSection(e.currentTarget.value)}
              autocomplete="off"
            />
            <datalist id="is-sections">
              {sections.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
        )}
        {f.has('length') && (
          <div class="field">
            <span class="lbl" id="is-len">
              How long <span class="opt">optional</span>
            </span>
            {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the chip layout */}
            <div class="chips" role="group" aria-labelledby="is-len">
              {([null, 'short', 'evening', 'half', 'day'] as (IdeaLength | null)[]).map((k) => (
                <button
                  type="button"
                  key={k ?? 'none'}
                  class="chip"
                  aria-pressed={length === k}
                  onClick={() => setLength(k)}
                >
                  {k ? LENGTH_LABEL[k] : 'Not sure'}
                </button>
              ))}
            </div>
            <p class="small muted">Helps pick ideas that fit when you’re both free.</p>
          </div>
        )}
        {f.has('due') && forPlan && (
          <div class="field">
            <label for="is-before">When it’s due</label>
            <select
              id="is-before"
              class="txt"
              value={before === null ? '' : String(before)}
              onChange={(e) =>
                setBefore(e.currentTarget.value ? Number(e.currentTarget.value) : null)
              }
            >
              {BEFORE_CHOICES.map(([v, label]) => (
                <option key={label} value={v === null ? '' : String(v)}>
                  {label}
                </option>
              ))}
            </select>
            <p class="small muted">Counted from the plan, so it moves if the plan does.</p>
          </div>
        )}
        {f.has('due') && !forPlan && (
          <div class="row2">
            <div class="field">
              <label for="is-due">
                Due <span class="opt">optional</span>
              </label>
              <input
                id="is-due"
                class="txt"
                type="date"
                value={due}
                onInput={(e) => setDue(e.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label for="is-rep">Repeats</label>
              <select
                id="is-rep"
                class="txt"
                value={repeat}
                onChange={(e) => setRepeat(e.currentTarget.value)}
              >
                {REPEAT_CHOICES.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
                {custom && <option value={repeat}>{repeatText(repeat)}</option>}
              </select>
            </div>
          </div>
        )}
        {f.has('due') && !forPlan && (due || repeat) && (
          <>
            <div class="field">
              <label for="is-time">
                Time <span class="opt">optional</span>
              </label>
              <input
                id="is-time"
                class="txt"
                type="time"
                value={time}
                onInput={(e) => setTime(e.currentTarget.value)}
              />
            </div>
            <ReminderPicker
              value={reminders}
              allDay={!time}
              onChange={setReminders}
              label={shared ? 'Remind whoever’s on it' : 'Remind me'}
              atTime
            />
          </>
        )}
        {f.has('due') && !forPlan && repeat && (
          <p class="small muted">
            Ticking it moves it to the next date instead of finishing it.
            {d.last_done ? ` Last done ${relDay(d.last_done).toLowerCase()}.` : ''}
          </p>
        )}
        {shared && f.has('who') && f.has('tick') && (
          <div class="field">
            <span class="lbl" id="is-who">
              Who’s on it
            </span>
            {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
            <div class="seg" role="group" aria-labelledby="is-who">
              {(
                [
                  ['none', 'Nobody yet'],
                  ['me', nameOf(me)],
                  ['partner', nameOf(p)],
                ] as const
              ).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={who === key}
                  onClick={() => setWho(key)}
                >
                  {key !== 'none' && <Marker owner={key === 'me' ? me : p} />}
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {shared && f.has('due') && !forPlan && repeat && (
          <Switch
            checked={rotate}
            onChange={setRotate}
            label="Take turns"
            hint="Each time it’s done, it passes to the other one of you."
          />
        )}
        {f.has('when') && (
          <>
            <div class="field">
              <span class="lbl" id="is-when">
                When
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled */}
              <div class="chips" role="group" aria-labelledby="is-when">
                {(
                  [
                    [null, 'Any time'],
                    ['soon', 'Soon'],
                    ['someday', 'Someday'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    type="button"
                    key={label}
                    class="chip"
                    aria-pressed={when === k}
                    onClick={() => setWhen(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div class="field">
              <span class="lbl" id="is-season">
                Best in <span class="opt">optional</span>
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled */}
              <div class="chips" role="group" aria-labelledby="is-season">
                {(Object.keys(SEASON_NAME) as Season[]).map((k) => (
                  <button
                    type="button"
                    key={k}
                    class="chip"
                    aria-pressed={season.includes(k)}
                    onClick={() =>
                      setSeason(season.includes(k) ? season.filter((x) => x !== k) : [...season, k])
                    }
                  >
                    {SEASON_NAME[k]}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        {f.has('link') && (
          <div class="field">
            <label for="is-link">
              Link <span class="opt">optional</span>
            </label>
            <input
              id="is-link"
              class="txt"
              type="url"
              value={link}
              maxLength={2048}
              placeholder="https://"
              onInput={(e) => setLink(e.currentTarget.value)}
              autocomplete="off"
            />
          </div>
        )}
        {f.has('notes') && (
          <div class="field">
            <label for="is-note">
              Note <span class="opt">optional</span>
            </label>
            <textarea
              id="is-note"
              class="txt"
              value={note}
              maxLength={2000}
              onInput={(e) => setNote(e.currentTarget.value)}
            />
          </div>
        )}
        {f.has('did') && <Memories item={item} />}
        {f.has('did') && (
          <Switch
            checked={again}
            onChange={setAgain}
            label="Do it again"
            hint="A favourite. “Favourites” on the list shows just these."
          />
        )}
        {error && (
          <p class="formerr" role="alert">
            {error}
          </p>
        )}
        <button class="btn primary big" type="submit">
          Save
        </button>
      </form>
      <Place item={item} list={list} dirty={dirty} />
      <div class="sh-foot">
        <span class="small muted">
          {d.due && !forPlan ? `Due ${fmtLong(d.due)}${d.time ? `, ${fmtTime(d.time)}` : ''}` : ''}
        </span>
        <button
          type="button"
          class="linkbtn danger"
          onClick={() => {
            if (!armed) return setArmed(true);
            close();
            toast(`Deleted “${d.text}”.`, remove([item.id]));
          }}
        >
          {armed ? 'Tap again to delete' : 'Delete'}
        </button>
      </div>
    </Sheet>
  );
}

/** The times you did it, newest first, with how each of you found it. Saved as you tap. */
function Memories({ item }: { item: ItemEntry }) {
  const me = viewer.value;
  const p = partner.value;
  const did = item.rec.data.did ?? [];
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(today.value);
  return (
    <div class="field memories">
      <span class="lbl">We did it</span>
      {did.length ? (
        <ul class="mem">
          {did
            .map((m, i) => ({ m, i }))
            .reverse()
            .map(({ m, i }) => (
              <li key={`${m.date}-${i}`}>
                <span class="mem-d">{fmtLong(m.date)}</span>
                {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled */}
                <span
                  class="chips"
                  role="group"
                  aria-label={`How it was for you, ${fmtLong(m.date)}`}
                >
                  {(Object.keys(REACTION_LABEL) as Reaction[]).map((r) => (
                    <button
                      type="button"
                      key={r}
                      class="chip"
                      aria-pressed={m[me] === r}
                      onClick={() => react(item, i, me, m[me] === r ? null : r)}
                    >
                      {REACTION_LABEL[r]}
                    </button>
                  ))}
                </span>
                {m[p] && (
                  <span class="small muted">
                    {nameOf(p)}: {REACTION_LABEL[m[p]].toLowerCase()}
                  </span>
                )}
              </li>
            ))}
        </ul>
      ) : (
        <p class="small muted">Not yet.</p>
      )}
      {adding ? (
        <div class="btnrow">
          <input
            class="txt"
            type="date"
            aria-label="When you did it"
            value={date}
            max={today.value}
            onInput={(e) => setDate(e.currentTarget.value)}
          />
          <button
            type="button"
            class="btn sm"
            onClick={() => {
              if (!date) return;
              didIt(item, date);
              setAdding(false);
            }}
          >
            Add
          </button>
        </div>
      ) : (
        <button type="button" class="linkbtn" onClick={() => setAdding(true)}>
          Add a time you did it
        </button>
      )}
    </div>
  );
}

/**
 * Where the item sits: up, down or to the top of its list (when the list
 * keeps its own order), and which list it's on (review 0008, L-3). Moving
 * it to a list the partner can't see, or can, says so first.
 */
function Place({ item, list, dirty }: { item: ItemEntry; list: ListEntry; dirty: boolean }) {
  const [target, setTarget] = useState(list.id);
  const p = nameOf(partner.value);
  const lists = activeLists();
  const options = lists.some((l) => l.id === list.id) ? lists : [list, ...lists];
  const dest = options.find((l) => l.id === target);
  const crossing = dest && dest.id !== list.id && movesScope(list, dest);
  const peers = orderOf(list) === 'own' ? peersOf(item, list) : [];
  const at = peers.findIndex((x) => x.id === item.id);
  const move = (to: ListEntry) => {
    const { undo } = moveItems([item.id], to.id);
    close();
    toast(`Moved to “${to.rec.data.name}”.`, undo);
  };
  return (
    <div class="stack gap itemplace">
      {peers.length > 1 && (
        // biome-ignore lint/a11y/useSemanticElements: a labelled row of buttons; fieldset breaks the row layout
        <div class="btnrow" role="group" aria-label="Order in the list">
          <button
            type="button"
            class="btn sm"
            disabled={at <= 0}
            onClick={() => moveItem(item, 'top', peers)}
          >
            Move to top
          </button>
          <button
            type="button"
            class="btn sm"
            disabled={at <= 0}
            aria-label="Move up"
            onClick={() => moveItem(item, 'up', peers)}
          >
            <Icon name="up" size={16} />
            Up
          </button>
          <button
            type="button"
            class="btn sm"
            disabled={at < 0 || at >= peers.length - 1}
            aria-label="Move down"
            onClick={() => moveItem(item, 'down', peers)}
          >
            <Icon name="down" size={16} />
            Down
          </button>
        </div>
      )}
      {options.length > 1 && (
        <div class="field">
          <label for="is-list">List</label>
          <select
            id="is-list"
            class="txt"
            disabled={dirty}
            aria-describedby={dirty ? 'is-list-d' : undefined}
            value={target}
            onChange={(e) => {
              const id = e.currentTarget.value;
              setTarget(id);
              const to = options.find((l) => l.id === id);
              if (to && to.id !== list.id && !movesScope(list, to)) move(to);
            }}
          >
            {options.map((l) => (
              <option key={l.id} value={l.id}>
                {l.rec.data.private ? `${l.rec.data.name} (just you)` : l.rec.data.name}
              </option>
            ))}
          </select>
          {dirty && (
            <p class="small muted" id="is-list-d">
              Save your changes first, then move it.
            </p>
          )}
          {crossing && dest && (
            <p class="small" role="alert">
              {dest.rec.data.private ? `${p} won’t see it any more.` : `${p} will see it.`}{' '}
              <button type="button" class="linkbtn" onClick={() => move(dest)}>
                Move it
              </button>{' '}
              <button type="button" class="linkbtn" onClick={() => setTarget(list.id)}>
                Keep it here
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** What you do with an idea: plan it (linked back to it), or say you did it (L-10, L-11). */
function IdeaActions({ item }: { item: ItemEntry }) {
  const list = findEntry(item.rec.data.list_id) as ListEntry | undefined;
  if (!list) return null;
  const f = featuresOf(list);
  const d = item.rec.data;
  const plan = planForIdea(item.id);
  return (
    <div class="btnrow ideaacts">
      {f.has('plan') &&
        (plan && !plan.past ? (
          <button
            type="button"
            class="btn sm"
            onClick={() => {
              close();
              openEvent(plan.id);
            }}
          >
            <Icon name="cal" size={15} />
            Planned for {relDay(plan.date)}
          </button>
        ) : (
          <button
            type="button"
            class="btn sm primary"
            onClick={() => {
              close();
              openQuick({
                text: d.text,
                date: nextFreeEvening(),
                time: '19:00',
                who: 'ours',
                fromItem: item.id,
              });
            }}
          >
            <Icon name="cal" size={15} />
            Plan it
          </button>
        ))}
      {f.has('did') && (
        <button
          type="button"
          class="btn sm"
          onClick={() => toast(`Noted. How was “${d.text}”? Say below.`, didIt(item))}
        >
          <Icon name="check" size={15} />
          We did it
        </button>
      )}
    </div>
  );
}
