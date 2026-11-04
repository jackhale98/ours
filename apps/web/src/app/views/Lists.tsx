// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lists. Every list is the same kind of thing; what it can do is switched on
 * in its settings (lists.ts FEATURES), and a starting point switches on a
 * sensible set. One view shows whatever a list has on: ticking off, who's
 * on it, due dates, pick one, plan it, hearts, "we did it", sections and
 * details.
 */
import { parseQuickAdd } from '@ours/core/parse';
import { keyBetween } from '@ours/core/schema';
import { signal } from '@preact/signals';
import { useRef, useState } from 'preact/hooks';
import { LENGTH_LABEL } from '../freetime';
import { BEFORE_CHOICES, itemSheet } from '../itemsheet';
import {
  allLists,
  bothWant,
  completeItem,
  completeItems,
  copyList,
  countOf,
  createList,
  currentList,
  deleteList,
  deleteStartingPoint,
  didIt,
  dueOf,
  dueText,
  FEATURE_GROUPS,
  FEATURES,
  type Feature,
  featuresOf,
  type ItemEntry,
  inCheckin,
  itemsOf,
  type ListEntry,
  lastDid,
  money,
  planOf,
  renameList,
  SEASON_NAME,
  STARTING_POINTS,
  type StartingPoint,
  savedStartingPoints,
  saveStartingPoint,
  seasonNow,
  setFeatures,
  setListCheckin,
  setListPrivacy,
  startOver,
  toggleHeart,
  updateItems,
} from '../lists';
import { nameOf, partner, put, remove, type Slot, settings, update, viewer } from '../model';
import { fmtLong, nextFreeEvening, relDay, repeatText, today } from '../select';
import { openEvent, openQuick } from '../sheets';
import { CloseButton, colorVar, Icon, Sheet, Switch, toast } from '../ui';
import { CrossViewPane, CrossViews, crossView } from './ListViews';

const showDone = signal(false);
const picked = signal<string | null>(null);
const listSheet = signal<{ type: 'new' } | { type: 'settings'; id: string } | null>(null);
/** Items picked to change together, in the list they belong to; null when not selecting. */
const selection = signal<{ list: string; ids: Set<string> } | null>(null);
const selecting = (listId: string) => selection.value?.list === listId;
function toggleSelected(listId: string, id: string): void {
  const cur = selection.value;
  if (!cur || cur.list !== listId) return;
  const ids = new Set(cur.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  selection.value = { list: listId, ids };
}

/** Filters on the list in view: what the two of you both want, soon, in season, favourites. */
const filters = signal<{ both: boolean; soon: boolean; season: boolean; favs: boolean }>({
  both: false,
  soon: false,
  season: false,
  favs: false,
});

function AssignButton({ item }: { item: ItemEntry }) {
  const me = viewer.value;
  const p = partner.value;
  const who = item.rec.data.assignee;
  const order: (Slot | null)[] = [null, me, p];
  const next = order[(order.indexOf(who === 'both' ? null : who) + 1) % order.length] ?? null;
  const label = who && who !== 'both' ? `${nameOf(who)} is on it. Change` : 'No one yet. Assign';
  return (
    <button
      type="button"
      class={`who${who && who !== 'both' ? '' : ' none'}`}
      aria-label={`${label}: ${item.rec.data.text}`}
      onClick={() => update<'item'>(item.id, { assignee: next })}
    >
      <span
        class={who === 'b' ? 'sq' : undefined}
        style={who && who !== 'both' ? { '--c': colorVar(who) } : undefined}
      >
        {who && who !== 'both' ? nameOf(who).charAt(0) : '+'}
      </span>
    </button>
  );
}

/** My heart (a toggle), and whether the partner hearted it too. */
function Hearts({ item }: { item: ItemEntry }) {
  const me = viewer.value;
  const p = partner.value;
  const h = item.rec.data.hearts ?? {};
  const mine = !!h[me];
  const theirs = !!h[p];
  return (
    <span class={`hearts${mine && theirs ? ' both' : ''}`}>
      <button
        type="button"
        class={`iconbtn heart${mine ? ' on' : ''}`}
        aria-pressed={mine}
        aria-label={`I’d like this: ${item.rec.data.text}`}
        onClick={() => toggleHeart(item, me)}
      >
        <Icon name="heart" size={17} />
      </button>
      {theirs && (
        <span class="theirs" title={`${nameOf(p)} would like this`}>
          <Icon name="heart" size={12} />
          <span class="sr">{nameOf(p)} would like this too.</span>
        </span>
      )}
    </span>
  );
}

/** "today", "yesterday", or "Sun, Oct 4", to follow other words. */
const dayWord = (date: string) => {
  const r = relDay(date);
  return /^(Today|Yesterday|Tomorrow)$/.test(r) ? r.toLowerCase() : r;
};

/** The small line under an item: everything its list shows, in words. */
function itemSub(item: ItemEntry, f: Set<Feature>): string[] {
  const d = item.rec.data;
  const out: string[] = [];
  if (f.has('qty') && d.qty) out.push(d.qty);
  if (f.has('due')) {
    const due = dueOf(item);
    if (due) out.push(dueText(due).text);
    if (d.repeat) out.push(`${repeatText(d.repeat)}${d.rotate ? ', taking turns' : ''}`);
  }
  if (f.has('length') && d.length) out.push(LENGTH_LABEL[d.length]);
  if (f.has('when')) {
    if (d.when) out.push(d.when === 'soon' ? 'Soon' : 'Someday');
    if (d.season?.length) out.push(d.season.map((s) => SEASON_NAME[s]).join(', '));
  }
  if (f.has('price') && d.price != null) out.push(money(d.price));
  if (f.has('did')) {
    const last = lastDid(item);
    const n = d.did?.length ?? 0;
    if (last) out.push(`Did it ${n > 1 ? `${n} times, last ` : ''}${dayWord(last.date)}`);
  }
  return out;
}

/** One item. `assign` shows who's on it even if the list doesn't (the check-in shares things out). */
export function ItemRow({
  item,
  list,
  assign,
  from,
}: {
  item: ItemEntry;
  list: ListEntry;
  assign?: boolean;
  /** The list's name, when shown among items from other lists. */
  from?: string;
}) {
  const f = featuresOf(list);
  const chosen = selecting(list.id) && !from;
  const d = item.rec.data;
  const [done, setDone] = useState(d.done);
  const due = f.has('due') ? dueOf(item) : null;
  const late = !!due && !d.done && dueText(due).late;
  const sub = [...(from ? [from] : []), ...itemSub(item, f)];
  const text = (
    <span class="it-t">
      {d.again && f.has('did') && (
        <span class="fav" title="Favourite">
          <Icon name="star" size={13} />
          <span class="sr">Favourite: </span>
        </span>
      )}
      {d.text}
      {sub.length > 0 && <span class={`it-sub${late ? ' late' : ''}`}>{sub.join(' · ')}</span>}
      {f.has('notes') && d.note && <span class="it-note">{d.note}</span>}
    </span>
  );
  if (chosen) {
    // Selecting: the whole row picks it; nothing else happens on a tap.
    const on = !!selection.value?.ids.has(item.id);
    return (
      <li class={`it selecting${done ? ' done' : ''}${on ? ' sel-on' : ''}`}>
        <label class="chk">
          <input
            type="checkbox"
            checked={on}
            aria-label={`Select ${d.text}`}
            onChange={() => toggleSelected(list.id, item.id)}
          />
          <span class="box sel">
            <Icon name="check" size={15} />
          </span>
          {text}
        </label>
      </li>
    );
  }
  return (
    <li
      class={`it${done ? ' done' : ''}${bothWant(item) && f.has('hearts') ? ' agreed' : ''}${f.has('tick') ? '' : ' idea'}`}
    >
      {f.has('tick') ? (
        <label class="chk">
          <input
            type="checkbox"
            checked={done}
            onChange={(e) => {
              const v = e.currentTarget.checked;
              setDone(v);
              // Let the tick register visually before the item moves.
              setTimeout(() => {
                if (!v) {
                  update<'item'>(item.id, { done: false });
                  return;
                }
                const { undo, next } = completeItem(item);
                if (f.has('did')) didIt(item);
                if (d.repeat) {
                  setDone(false);
                  toast(next ? `Done. Next: ${relDay(next)}.` : 'Done.', undo);
                }
              }, 420);
            }}
          />
          <span class="box">
            <Icon name="check" size={15} />
          </span>
          {text}
        </label>
      ) : (
        <span class="grow">{text}</span>
      )}
      <span class="it-acts">
        {f.has('hearts') && <Hearts item={item} />}
        {f.has('link') && d.link && (
          <a
            class="iconbtn"
            href={d.link}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open the link for ${d.text}`}
          >
            <Icon name="link" size={16} />
          </a>
        )}
        {(assign || (f.has('who') && f.has('tick'))) && item.scope === 'space' && (
          <AssignButton item={item} />
        )}
        {f.has('did') && !f.has('tick') && (
          <button
            type="button"
            class="btn sm"
            aria-label={`We did it: ${d.text}`}
            onClick={() => {
              const undo = didIt(item);
              toast(`Noted. How was “${d.text}”? Say in its details.`, undo);
            }}
          >
            We did it
          </button>
        )}
        {f.has('plan') && !f.has('tick') && (
          <button
            type="button"
            class="btn sm"
            aria-label={`Plan it: ${d.text}`}
            onClick={() => planIdea(d.text)}
          >
            Plan it
          </button>
        )}
        <button
          type="button"
          class="iconbtn it-more"
          aria-label={`Details: ${d.text}`}
          onClick={() => {
            itemSheet.value = item.id;
          }}
        >
          <Icon name="next" size={16} />
        </button>
        {!f.has('tick') && (
          <button
            type="button"
            class="iconbtn"
            aria-label={`Remove ${d.text}`}
            onClick={() => {
              if (picked.value === item.id) picked.value = null;
              toast(`Removed “${d.text}”.`, remove([item.id]));
            }}
          >
            <Icon name="x" size={16} />
          </button>
        )}
      </span>
    </li>
  );
}

function AddItem({ list, placeholder }: { list: ListEntry; placeholder: string }) {
  const f = featuresOf(list);
  const [text, setText] = useState('');
  const [section, setSection] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const sections = [
    ...new Set(
      itemsOf(list.id)
        .map((i) => i.rec.data.section)
        .filter((s): s is string => !!s),
    ),
  ];
  const submit = (e: Event) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    const first = itemsOf(list.id)[0];
    // "Take out the bins every monday", "Renew passport by mar 1": a due date
    // and repeat come from the words (only date and repeat phrases are taken out).
    const parsed = f.has('due') ? parseQuickAdd(v, { today: today.value }) : null;
    const taken = parsed?.tokens.filter((t) => t.type === 'date' || t.type === 'repeat') ?? [];
    let name = v;
    for (const t of [...taken].sort((a, b) => b.start - a.start)) {
      name = name.slice(0, t.start) + name.slice(t.end);
    }
    name =
      name
        .replace(/\s+(by|on|due)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim() || v;
    const repeat = parsed?.rrule ?? null;
    put(
      'item',
      {
        list_id: list.id,
        text: taken.length ? name : v,
        done: false,
        assignee: null,
        due: parsed?.date ?? (repeat ? today.value : null),
        sort_key: keyBetween(null, first?.rec.data.sort_key ?? null),
        ...(repeat ? { repeat } : {}),
        ...(f.has('sections') && section.trim() ? { section: section.trim().slice(0, 60) } : {}),
      },
      { scope: list.scope, owner: list.owner },
    );
    setText('');
    input.current?.focus();
  };
  return (
    <form class={`additem${f.has('sections') ? ' with-section' : ''}`} onSubmit={submit}>
      <input
        ref={input}
        class="txt"
        type="text"
        value={text}
        maxLength={500}
        onInput={(e) => setText(e.currentTarget.value)}
        placeholder={placeholder}
        autocomplete="off"
        aria-label={placeholder}
      />
      {f.has('sections') && (
        <>
          <input
            class="txt sec"
            type="text"
            value={section}
            maxLength={60}
            list={`sec-${list.id}`}
            onInput={(e) => setSection(e.currentTarget.value)}
            placeholder="Section"
            aria-label="Section"
            autocomplete="off"
          />
          <datalist id={`sec-${list.id}`}>
            {sections.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      )}
      <button class="btn primary" type="submit">
        <Icon name="plus" size={16} />
        Add
      </button>
    </form>
  );
}

const placeholderFor = (list: ListEntry) => {
  const f = featuresOf(list);
  if (list.rec.data.template === 'gifts' || list.rec.data.kind === 'gifts')
    return 'Add a gift idea';
  if (!f.has('tick') && f.has('plan')) return 'Add an idea';
  return `Add to ${list.rec.data.name}`;
};

export function planIdea(text: string) {
  openQuick({ text, date: nextFreeEvening(), time: '19:00', who: 'ours' });
}

/** Items in their sections (those without one first), in list order. */
function bySection(items: ItemEntry[]): [string | null, ItemEntry[]][] {
  const groups = new Map<string | null, ItemEntry[]>();
  for (const i of items) {
    const k = i.rec.data.section?.trim() || null;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const none = groups.get(null);
  groups.delete(null);
  return [...(none ? [[null, none] as [null, ItemEntry[]]] : []), ...groups.entries()];
}

function Items({ items, list }: { items: ItemEntry[]; list: ListEntry }) {
  if (!featuresOf(list).has('sections'))
    return (
      <ul class="items">
        {items.map((i) => (
          <ItemRow key={i.id} item={i} list={list} />
        ))}
      </ul>
    );
  return (
    <>
      {bySection(items).map(([name, group]) => (
        <section class="isection" key={name ?? ''} aria-label={name ?? 'Not in a section'}>
          {name && <h2 class="eyebrow">{name}</h2>}
          <ul class="items">
            {group.map((i) => (
              <ItemRow key={i.id} item={i} list={list} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** Filter chips for the features a list has, applied to the list and to "pick one". */
function Filters({ list }: { list: ListEntry }) {
  const f = featuresOf(list);
  const v = filters.value;
  const chips: [keyof typeof v, string][] = [];
  if (f.has('hearts')) chips.push(['both', 'We both want']);
  if (f.has('when'))
    chips.push(['soon', 'Soon'], ['season', `Good in ${SEASON_NAME[seasonNow()].toLowerCase()}`]);
  if (f.has('did')) chips.push(['favs', 'Favourites']);
  if (!chips.length) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled
    <div class="chips lfilters" role="group" aria-label="Show only">
      {chips.map(([k, label]) => (
        <button
          type="button"
          key={k}
          class="chip"
          aria-pressed={v[k]}
          onClick={() => {
            filters.value = { ...v, [k]: !v[k] };
            picked.value = null;
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function applyFilters(items: ItemEntry[], f: Set<Feature>): ItemEntry[] {
  const v = filters.value;
  const now = seasonNow();
  return items.filter((i) => {
    const d = i.rec.data;
    if (v.both && f.has('hearts') && !bothWant(i)) return false;
    if (v.soon && f.has('when') && d.when !== 'soon') return false;
    if (v.season && f.has('when') && d.season?.length && !d.season.includes(now)) return false;
    if (v.favs && f.has('did') && !d.again) return false;
    return true;
  });
}

function Pick({ list, pool }: { list: ListEntry; pool: ItemEntry[] }) {
  const f = featuresOf(list);
  const pick = pool.find((i) => i.id === picked.value);
  const shuffle = () => {
    if (!pool.length) return;
    let n: ItemEntry | undefined;
    do n = pool[Math.floor(Math.random() * pool.length)];
    while (pool.length > 1 && n?.id === picked.value);
    picked.value = n?.id ?? null;
  };
  if (!pick)
    return (
      <div class="pickrow">
        <button type="button" class="btn primary" onClick={shuffle} disabled={!pool.length}>
          <Icon name="shuffle" size={16} />
          Pick one for us
        </button>
      </div>
    );
  return (
    <section class="picked" aria-live="polite" aria-labelledby="pick-title">
      <p class="eyebrow">Your pick</p>
      <h2 class="h3" id="pick-title">
        {pick.rec.data.text}
      </h2>
      {f.has('plan') && (
        <p class="sub">Next evening you’re both free: {relDay(nextFreeEvening())}</p>
      )}
      <div class="pickrow">
        {f.has('plan') && (
          <button type="button" class="btn primary sm" onClick={() => planIdea(pick.rec.data.text)}>
            Ask {nameOf(partner.value)}
          </button>
        )}
        <button type="button" class="btn sm" onClick={shuffle}>
          <Icon name="shuffle" size={15} />
          Another
        </button>
      </div>
    </section>
  );
}

function ListBody({ list }: { list: ListEntry }) {
  const f = featuresOf(list);
  const all = itemsOf(list.id);
  const open = applyFilters(f.has('tick') ? all.filter((i) => !i.rec.data.done) : all, f);
  const done = f.has('tick') ? all.filter((i) => i.rec.data.done) : [];
  const priv = list.rec.data.private;
  const plan = planOf(list);
  const toGet = f.has('price')
    ? all.filter((i) => !i.rec.data.done).reduce((n, i) => n + (i.rec.data.price ?? 0), 0)
    : 0;
  return (
    <>
      {priv && (
        <p class="note">
          <Icon name="lock" size={15} />
          <span>
            Only you can see this list. It’s encrypted with your personal key, not the shared one.
          </span>
        </p>
      )}
      {plan?.rec.kind === 'event' && (
        <p class="note">
          <Icon name="cal" size={15} />
          <span>
            For{' '}
            <button type="button" class="linkbtn" onClick={() => openEvent(plan.id)}>
              {plan.rec.data.title}
            </button>
            , {fmtLong(plan.rec.data.start.slice(0, 10))}.
          </span>
        </p>
      )}
      {f.has('pick') && !selecting(list.id) && <Pick list={list} pool={open} />}
      <Filters list={list} />
      {!selecting(list.id) && <AddItem list={list} placeholder={placeholderFor(list)} />}
      <Items items={open} list={list} />
      {!open.length && (
        <p class="nothing">
          {all.length
            ? f.has('tick') && !filters.value.both && !filters.value.soon
              ? 'All done.'
              : 'Nothing matches.'
            : 'Nothing here yet.'}
        </p>
      )}
      {f.has('price') && toGet > 0 && (
        <p class="total">
          Still to get: <b>{money(toGet)}</b>
        </p>
      )}
      {done.length > 0 && (
        <>
          <div class="donebar">
            <button
              type="button"
              class="linkbtn"
              aria-expanded={showDone.value}
              onClick={() => {
                showDone.value = !showDone.value;
              }}
            >
              {showDone.value ? 'Hide' : 'Show'} done · {done.length}
            </button>
            <button
              type="button"
              class="linkbtn"
              onClick={() => toast('Unticked everything.', startOver(list.id))}
            >
              Start over
            </button>
            <button
              type="button"
              class="linkbtn"
              onClick={() => toast('Cleared done items.', remove(done.map((i) => i.id)))}
            >
              Clear done
            </button>
          </div>
          {showDone.value && <Items items={done} list={list} />}
        </>
      )}
      {selecting(list.id) && (
        <BulkBar list={list} shown={[...open, ...(showDone.value ? done : [])]} />
      )}
    </>
  );
}

/** What can be done to the selected items, for the features the list has. */
function BulkBar({ list, shown }: { list: ListEntry; shown: ItemEntry[] }) {
  const f = featuresOf(list);
  const sel = selection.value;
  const [panel, setPanel] = useState<'due' | 'who' | 'section' | null>(null);
  const [date, setDate] = useState(today.value);
  const [before, setBefore] = useState<number | null>(1);
  const [section, setSection] = useState('');
  const [armed, setArmed] = useState(false);
  if (!sel) return null;
  const items = itemsOf(list.id).filter((i) => sel.ids.has(i.id));
  const ids = items.map((i) => i.id);
  const n = ids.length;
  const forPlan = !!planOf(list);
  const shared = !list.rec.data.private;
  const me = viewer.value;
  const p = partner.value;
  const allShown = shown.length > 0 && shown.every((i) => sel.ids.has(i.id));
  const sections = [
    ...new Set(
      itemsOf(list.id)
        .map((i) => i.rec.data.section)
        .filter((x): x is string => !!x),
    ),
  ];
  const things = (k: number) => `${k} ${k === 1 ? 'item' : 'items'}`;
  const done = (msg: string, r: { undo: () => void; changed: number }, exit = false) => {
    setPanel(null);
    setArmed(false);
    if (exit) selection.value = null;
    toast(r.changed ? msg.replace('#', things(r.changed)) : 'Nothing to change.', r.undo);
  };
  const toggle = (which: 'due' | 'who' | 'section') => {
    setArmed(false);
    setPanel(panel === which ? null : which);
  };
  return (
    <section class="bulkbar" aria-label="Change the selected items">
      <div class="bulk-top">
        <span aria-live="polite">
          <b>{n}</b> selected
        </span>
        <button
          type="button"
          class="linkbtn"
          onClick={() => {
            selection.value = {
              list: list.id,
              ids: allShown ? new Set() : new Set(shown.map((i) => i.id)),
            };
          }}
        >
          {allShown ? 'Select none' : 'Select all'}
        </button>
        <button
          type="button"
          class="linkbtn"
          onClick={() => {
            selection.value = null;
          }}
        >
          Done
        </button>
      </div>
      {panel === 'due' && (
        <div class="bulk-panel">
          {forPlan ? (
            <>
              <label class="sr" for="bulk-before">
                When they’re due
              </label>
              <select
                id="bulk-before"
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
              <button
                type="button"
                class="btn sm primary"
                onClick={() =>
                  done(
                    'Changed when # are due.',
                    updateItems(ids, () => ({ before_days: before, due: null })),
                  )
                }
              >
                Set
              </button>
            </>
          ) : (
            <>
              <label class="sr" for="bulk-due">
                Due date
              </label>
              <input
                id="bulk-due"
                class="txt"
                type="date"
                value={date}
                onInput={(e) => setDate(e.currentTarget.value)}
              />
              <button
                type="button"
                class="btn sm primary"
                disabled={!date}
                onClick={() =>
                  done(
                    `# due ${dayWord(date)}.`,
                    updateItems(ids, () => ({ due: date })),
                  )
                }
              >
                Set
              </button>
              <button
                type="button"
                class="btn sm ghost"
                onClick={() =>
                  // A repeating task counts from its date: those keep theirs.
                  done(
                    'Took the date off #.',
                    updateItems(ids, (i) =>
                      i.rec.data.repeat || !i.rec.data.due ? null : { due: null },
                    ),
                  )
                }
              >
                No date
              </button>
            </>
          )}
        </div>
      )}
      {panel === 'who' && (
        <div class="bulk-panel">
          {(
            [
              [me, 'Me'],
              [p, nameOf(p)],
              [null, 'No one'],
            ] as [Slot | null, string][]
          ).map(([slot, label]) => (
            <button
              type="button"
              key={label}
              class="btn sm"
              onClick={() =>
                done(
                  slot ? `${slot === me ? 'You’re' : `${nameOf(slot)}’s`} on #.` : 'Unassigned #.',
                  updateItems(ids, (i) =>
                    i.scope === 'space' && i.rec.data.assignee !== slot ? { assignee: slot } : null,
                  ),
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {panel === 'section' && (
        <form
          class="bulk-panel"
          onSubmit={(e) => {
            e.preventDefault();
            const name = section.trim().slice(0, 60) || null;
            done(
              name ? `Moved # to ${name}.` : 'Took # out of their sections.',
              updateItems(ids, (i) =>
                (i.rec.data.section ?? null) === name ? null : { section: name },
              ),
            );
          }}
        >
          <label class="sr" for="bulk-section">
            Section
          </label>
          <input
            id="bulk-section"
            class="txt"
            list="bulk-sections"
            placeholder="Section name, or empty for none"
            maxLength={60}
            value={section}
            onInput={(e) => setSection(e.currentTarget.value)}
          />
          <datalist id="bulk-sections">
            {sections.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <button type="submit" class="btn sm primary">
            Move
          </button>
        </form>
      )}
      <div class="bulk-acts">
        {f.has('due') && (
          <button
            type="button"
            class="btn sm"
            disabled={!n}
            aria-expanded={panel === 'due'}
            onClick={() => toggle('due')}
          >
            <Icon name="cal" size={15} />
            Due date
          </button>
        )}
        {f.has('who') && f.has('tick') && shared && (
          <button
            type="button"
            class="btn sm"
            disabled={!n}
            aria-expanded={panel === 'who'}
            onClick={() => toggle('who')}
          >
            Assign
          </button>
        )}
        {f.has('sections') && (
          <button
            type="button"
            class="btn sm"
            disabled={!n}
            aria-expanded={panel === 'section'}
            onClick={() => toggle('section')}
          >
            Section
          </button>
        )}
        {f.has('tick') &&
          (items.length > 0 && items.every((i) => i.rec.data.done) ? (
            <button
              type="button"
              class="btn sm"
              disabled={!n}
              onClick={() =>
                done(
                  'Unticked #.',
                  updateItems(ids, () => ({ done: false })),
                  true,
                )
              }
            >
              Mark not done
            </button>
          ) : (
            <button
              type="button"
              class="btn sm"
              disabled={!n}
              onClick={() => done('Ticked off #.', completeItems(ids, f.has('did')), true)}
            >
              <Icon name="check" size={15} />
              Mark done
            </button>
          ))}
        <button
          type="button"
          class="btn sm ghost danger"
          disabled={!n}
          onClick={() => {
            if (!armed) {
              setPanel(null);
              setArmed(true);
              return;
            }
            if (picked.value && sel.ids.has(picked.value)) picked.value = null;
            done(`Removed ${things(n)}.`, { undo: remove(ids), changed: n }, true);
          }}
        >
          {armed ? `Tap again: remove ${n}` : 'Remove'}
        </button>
      </div>
    </section>
  );
}

/* ---------- new list and settings ---------- */

const closeSheet = () => {
  listSheet.value = null;
};

function NewListSheet() {
  const saved = savedStartingPoints();
  const all = [
    ...STARTING_POINTS.slice(0, -1),
    ...saved,
    STARTING_POINTS[STARTING_POINTS.length - 1] as StartingPoint,
  ];
  const [start, setStart] = useState<StartingPoint>(all[0] as StartingPoint);
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(start.private);
  const p = nameOf(partner.value);
  const submit = (e: Event) => {
    e.preventDefault();
    const finalName = name.trim() || start.example;
    const id = createList(finalName, start, priv);
    currentList.value = id;
    picked.value = null;
    // A blank list opens its settings, to switch on what it needs.
    listSheet.value = start.template === 'blank' ? { type: 'settings', id } : null;
    toast(`Made “${finalName}”${priv ? ', just for you' : ''}.`);
  };
  return (
    <Sheet labelledBy="lt-title" onClose={closeSheet}>
      <form class="sheet-form" onSubmit={submit}>
        <div class="sh-head">
          <h2 id="lt-title">New list</h2>
          <CloseButton onClose={closeSheet} />
        </div>
        <span class="lbl" id="lt-type">
          Start from
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled */}
        <div class="typepick" role="group" aria-labelledby="lt-type">
          {all.map((sp) => (
            <span class="tp" key={sp.id}>
              <button
                type="button"
                aria-pressed={start.id === sp.id}
                onClick={() => {
                  setStart(sp);
                  setPriv(sp.private);
                }}
              >
                <b>{sp.label}</b>
                <span>{sp.blurb}</span>
              </button>
              {sp.template === 'custom' && (
                <button
                  type="button"
                  class="iconbtn tp-x"
                  aria-label={`Forget the starting point ${sp.label}`}
                  onClick={() => {
                    deleteStartingPoint(sp.id);
                    if (start.id === sp.id) setStart(all[0] as StartingPoint);
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              )}
            </span>
          ))}
        </div>
        <p class="small muted">You can switch features on and off later, in the list’s settings.</p>
        <div class="field">
          <label for="lt-name">Name</label>
          <input
            id="lt-name"
            class="txt"
            type="text"
            value={name}
            maxLength={100}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder={start.example}
            autocomplete="off"
          />
        </div>
        <Switch
          checked={priv}
          onChange={setPriv}
          label="Just for me"
          hint={priv ? `${p} won’t see this list at all.` : `Shared with ${p}.`}
        />
        <button class="btn primary big" type="submit">
          Make list
        </button>
      </form>
    </Sheet>
  );
}

function ListSettingsSheet({ id }: { id: string }) {
  const list = allLists().find((l) => l.id === id);
  const [name, setName] = useState(list?.rec.data.name ?? '');
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  if (!list) return null;
  const p = nameOf(partner.value);
  const count = itemsOf(id).length;
  const f = featuresOf(list);
  const plan = planOf(list);
  const saveName = () => {
    const v = name.trim();
    if (v && v !== list.rec.data.name) renameList(id, v);
  };
  const toggle = (feature: Feature, on: boolean) => {
    const next = new Set(f);
    if (on) next.add(feature);
    else next.delete(feature);
    setFeatures(id, [...next]);
  };
  return (
    <Sheet labelledBy="le-title" onClose={closeSheet}>
      <form
        class="sheet-form"
        onSubmit={(e) => {
          e.preventDefault();
          saveName();
          closeSheet();
        }}
      >
        <div class="sh-head">
          <h2 id="le-title">List settings</h2>
          <CloseButton onClose={closeSheet} />
        </div>
        <div class="field">
          <label for="le-name">Name</label>
          <input
            id="le-name"
            data-autofocus
            class="txt"
            type="text"
            value={name}
            maxLength={100}
            onInput={(e) => setName(e.currentTarget.value)}
            onBlur={saveName}
            autocomplete="off"
          />
        </div>
        <Switch
          checked={list.rec.data.private}
          onChange={(v) => {
            saveName();
            const newId = setListPrivacy(id, v);
            currentList.value = newId;
            listSheet.value = { type: 'settings', id: newId };
            toast(v ? `${p} can no longer see this list.` : `Shared with ${p}.`);
          }}
          label="Just for me"
          hint={list.rec.data.private ? 'Encrypted with your personal key.' : `Shared with ${p}.`}
        />
        {!list.rec.data.private && f.has('tick') && (
          <Switch
            checked={inCheckin(list, settings.value.chores_list)}
            onChange={(v) => {
              saveName();
              setListCheckin(id, v);
              toast(
                v ? 'It will come up in the weekly check-in.' : 'Left out of the weekly check-in.',
              );
            }}
            label="Part of the weekly check-in"
            hint="Its open items come up in the check-in, to share out who does what."
          />
        )}
        {plan?.rec.kind === 'event' && (
          <p class="small muted">
            A checklist for “{plan.rec.data.title}”.{' '}
            <button
              type="button"
              class="linkbtn"
              onClick={() => update<'list'>(id, { plan_id: null })}
            >
              Make it a list of its own
            </button>
          </p>
        )}
        {FEATURE_GROUPS.map(([group, title]) => (
          <fieldset class="fgroup" key={group}>
            <legend class="eyebrow">{title}</legend>
            {(Object.keys(FEATURES) as Feature[])
              .filter((k) => FEATURES[k].group === group)
              .filter((k) => !(k === 'who' && list.rec.data.private))
              .map((k) => (
                <Switch
                  key={k}
                  checked={f.has(k)}
                  onChange={(on) => toggle(k, on)}
                  label={FEATURES[k].label}
                  hint={FEATURES[k].hint}
                />
              ))}
          </fieldset>
        ))}
        <button class="btn primary big" type="submit">
          Done
        </button>
        <div class="stack gap">
          {saving === null ? (
            <div class="btnrow">
              <button type="button" class="btn sm" onClick={() => setSaving(list.rec.data.name)}>
                Save as a starting point
              </button>
              <button
                type="button"
                class="btn sm"
                onClick={() => {
                  const copy = copyList(id);
                  if (!copy) return;
                  currentList.value = copy;
                  closeSheet();
                  toast(`Copied “${list.rec.data.name}”.`);
                }}
              >
                Copy list
              </button>
            </div>
          ) : (
            <div class="field">
              <label for="le-sp">Starting point name</label>
              <div class="btnrow">
                <input
                  id="le-sp"
                  class="txt"
                  type="text"
                  value={saving}
                  maxLength={40}
                  onInput={(e) => setSaving(e.currentTarget.value)}
                  autocomplete="off"
                />
                <button
                  type="button"
                  class="btn sm primary"
                  onClick={() => {
                    const n = saving.trim();
                    if (!n) return;
                    saveStartingPoint(list, n);
                    setSaving(null);
                    toast(`Saved “${n}”. It’s in New list for both of you.`);
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
        <div class="sh-foot">
          <button
            type="button"
            class="linkbtn danger"
            onClick={() => {
              if (!armed) {
                setArmed(true);
                return;
              }
              closeSheet();
              currentList.value = null;
              toast(`Deleted “${list.rec.data.name}”.`, deleteList(id));
            }}
          >
            {armed
              ? 'Tap again to delete'
              : `Delete list${count ? ` and its ${count} item${count === 1 ? '' : 's'}` : ''}`}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** What the list's starting point was called, or "Your list". */
function startLabel(list: ListEntry): string {
  const t = list.rec.data.template;
  return STARTING_POINTS.find((s) => s.template === t)?.label ?? 'List';
}

/* ---------- view ---------- */

export function ListsView() {
  const lists = allLists();
  const view = crossView.value;
  const cur = view ? undefined : (lists.find((l) => l.id === currentList.value) ?? lists[0]);
  const s = listSheet.value;
  return (
    <>
      <header class="vhead">
        <div>
          <p class="eyebrow">
            {cur
              ? cur.rec.data.private
                ? 'Just for you'
                : `Shared with ${nameOf(partner.value)}`
              : 'Lists'}
          </p>
          <h1>Lists</h1>
        </div>
        <button
          type="button"
          class="btn sm"
          onClick={() => {
            listSheet.value = { type: 'new' };
          }}
        >
          <Icon name="plus" size={15} />
          New list
        </button>
      </header>
      {lists.length ? (
        <div class="lists-layout">
          <div class="ltabs-col">
            <CrossViews
              onPick={() => {
                picked.value = null;
              }}
            />
            {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
            <div class="ltabs" role="group" aria-label="Lists">
              {lists.map((l) => {
                const { n, what } = countOf(l);
                return (
                  <button
                    type="button"
                    class="ltab"
                    key={l.id}
                    aria-pressed={!view && l.id === cur?.id}
                    onClick={() => {
                      currentList.value = l.id;
                      crossView.value = null;
                      picked.value = null;
                      filters.value = { both: false, soon: false, season: false, favs: false };
                    }}
                  >
                    {l.rec.data.private && <Icon name="lock" size={14} />}
                    {l.rec.data.private && <span class="sr">Private: </span>}
                    {l.rec.data.name}
                    <span class="n">
                      {n}
                      <span class="sr"> {what}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div class="lists-pane">
            {cur ? (
              <>
                <div class="listbar">
                  <span class="small muted">{startLabel(cur)}</span>
                  {itemsOf(cur.id).length > 1 && (
                    <button
                      type="button"
                      class="linkbtn lselect"
                      aria-pressed={selecting(cur.id)}
                      onClick={() => {
                        selection.value = selecting(cur.id)
                          ? null
                          : { list: cur.id, ids: new Set() };
                      }}
                    >
                      <Icon name="check" size={15} />
                      {selecting(cur.id) ? 'Cancel' : 'Select'}
                    </button>
                  )}
                  <button
                    type="button"
                    class="linkbtn"
                    aria-label={`List settings: ${cur.rec.data.name}`}
                    onClick={() => {
                      listSheet.value = { type: 'settings', id: cur.id };
                    }}
                  >
                    <Icon name="settings" size={15} />
                    Settings
                  </button>
                </div>
                <div class="listcard">
                  <ListBody key={cur.id} list={cur} />
                </div>
              </>
            ) : (
              <CrossViewPane />
            )}
          </div>
        </div>
      ) : (
        <p class="nothing">
          No lists yet. Make one for groceries, chores, date ideas, a trip or anything else.
        </p>
      )}
      {s?.type === 'new' && <NewListSheet />}
      {s?.type === 'settings' && <ListSettingsSheet key={s.id} id={s.id} />}
    </>
  );
}
