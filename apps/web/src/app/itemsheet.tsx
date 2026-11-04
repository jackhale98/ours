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
  didIt,
  featuresOf,
  type ItemEntry,
  itemsOf,
  type ListEntry,
  money,
  planOf,
  react,
  SEASON_NAME,
} from './lists';
import { findEntry, nameOf, partner, remove, type Slot, update, viewer } from './model';
import { REPEAT_CHOICES } from './planform';
import { fmtLong, relDay, repeatText, today } from './select';
import { CloseButton, Marker, Sheet, Switch, toast } from './ui';

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
  const custom = !!repeat && !REPEAT_CHOICES.some(([v]) => v === repeat);
  const sections = [
    ...new Set(
      itemsOf(list.id)
        .map((i) => i.rec.data.section)
        .filter((s): s is string => !!s),
    ),
  ];

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
            due: due || (repeat ? today.value : null),
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
      <form class="stack gap planform" onSubmit={save} noValidate>
        <div class="field">
          <label for="is-name">What</label>
          <input
            id="is-name"
            class="txt"
            data-autofocus
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
      <div class="sh-foot">
        <span class="small muted">{d.due && !forPlan ? `Due ${fmtLong(d.due)}` : ''}</span>
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
