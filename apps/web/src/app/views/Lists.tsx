// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lists. Every list is the same kind of thing; what it can do is switched on
 * in its settings (lists.ts FEATURES), and a starting point switches on a
 * sensible set. One view shows whatever a list has on: ticking off, who's
 * on it, due dates, pick one, plan it, hearts, "we did it", sections and
 * details.
 */
import { parseQuickAdd } from '@ours/core/parse';
import { addDays } from '@ours/core/time';
import { signal } from '@preact/signals';
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { LENGTH_LABEL } from '../freetime';
import { BEFORE_CHOICES, itemSheet } from '../itemsheet';
import {
  activeLists,
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
  keepSection,
  type ListEntry,
  type ListOrder,
  lastDid,
  money,
  moveItem,
  moveItems,
  moveList,
  moveSection,
  movesScope,
  orderOf,
  peersOf,
  planForIdea,
  planOf,
  readItemText,
  renameList,
  renameSection,
  SEASON_NAME,
  STARTING_POINTS,
  type StartingPoint,
  sameItem,
  savedStartingPoints,
  saveStartingPoint,
  seasonNow,
  sectionsOf,
  setArchived,
  setFeatures,
  setListCheckin,
  setListPlan,
  setListPrivacy,
  setPinned,
  startOver,
  suggestItems,
  toggleHeart,
  topKey,
  updateItems,
} from '../lists';
import {
  byKind,
  findEntry,
  nameOf,
  partner,
  put,
  remove,
  type Slot,
  settings,
  update,
  viewer,
} from '../model';
import {
  DATE_ORDER,
  fmtLong,
  fmtTime,
  nextFreeEvening,
  relDay,
  repeatText,
  today,
} from '../select';
import { openEvent, openQuick } from '../sheets';
import { CloseButton, colorVar, Icon, Sheet, Switch, toast, typeFirst } from '../ui';
import { CrossViewPane, CrossViews, crossView } from './ListViews';

const showDone = signal(false);
const picked = signal<string | null>(null);
const listSheet = signal<
  { type: 'new' } | { type: 'settings'; id: string } | { type: 'switch'; find?: boolean } | null
>(null);
/** Past this many lists, they can be searched (sidebar box, or a search button on phones). */
const FIND_LISTS = 8;
/** Items picked to change together, in the list they belong to; null when not selecting. */
/*
 * Which list is in select mode, and which of its items are picked, apart:
 * picking an item redraws its checkbox and the bar, not the whole screen
 * (review 0008, L-5).
 */
const selectList = signal<string | null>(null);
const picks = signal<ReadonlySet<string>>(new Set());
const selecting = (listId: string) => selectList.value === listId;
function startSelecting(listId: string | null): void {
  picks.value = new Set();
  selectList.value = listId;
}
function toggleSelected(listId: string, id: string): void {
  if (selectList.value !== listId) return;
  const ids = new Set(picks.value);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  picks.value = ids;
}

/** A row's "pick this" box: the only part of the row that reads the picks. */
function PickBox({ id, listId, label }: { id: string; listId: string; label: string }) {
  const on = picks.value.has(id);
  return (
    <>
      <input
        type="checkbox"
        checked={on}
        aria-label={`Select ${label}`}
        onChange={() => toggleSelected(listId, id)}
      />
      <span class={`box sel${on ? ' on' : ''}`}>
        <Icon name="check" size={15} />
      </span>
    </>
  );
}

/** Filters on the list in view: what the two of you both want, soon, in season, favourites. */
const filters = signal<{ both: boolean; soon: boolean; season: boolean; favs: boolean }>({
  both: false,
  soon: false,
  season: false,
  favs: false,
});

/**
 * Who's on it: the person's initial, and a native dropdown over it to choose
 * (nobody, me, or my partner), so phones show their own picker.
 */
function AssignButton({ item }: { item: ItemEntry }) {
  const me = viewer.value;
  const p = partner.value;
  const raw = item.rec.data.assignee;
  const who = raw && raw !== 'both' ? raw : null;
  return (
    <span class={`who${who ? '' : ' none'}`}>
      <span
        class={who ?? undefined}
        style={who ? { '--c': colorVar(who) } : undefined}
        aria-hidden="true"
      >
        {who ? nameOf(who).charAt(0) : '+'}
      </span>
      <select
        class="who-pick"
        value={who ?? ''}
        aria-label={`Who’s on it: ${item.rec.data.text}`}
        onChange={(e) => {
          const v = e.currentTarget.value;
          update<'item'>(item.id, { assignee: v === me || v === p ? (v as Slot) : null });
        }}
      >
        <option value="">Nobody yet</option>
        <option value={me}>Me ({nameOf(me)})</option>
        <option value={p}>{nameOf(p)}</option>
      </select>
    </span>
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
function itemSub(item: ItemEntry, f: ReadonlySet<Feature>): string[] {
  const d = item.rec.data;
  const out: string[] = [];
  if (f.has('qty') && d.qty) out.push(d.qty);
  if (f.has('due')) {
    const due = dueOf(item);
    if (due) out.push(dueText(due, d.before_days != null ? null : d.time).text);
    if (d.repeat) out.push(`${repeatText(d.repeat)}${d.rotate ? ', taking turns' : ''}`);
  }
  if (f.has('length') && d.length) out.push(LENGTH_LABEL[d.length]);
  if (f.has('when')) {
    if (d.when) out.push(d.when === 'soon' ? 'Soon' : 'Someday');
    if (d.season?.length) out.push(d.season.map((s) => SEASON_NAME[s]).join(', '));
  }
  if (f.has('price') && d.price != null) out.push(money(d.price));
  if (f.has('plan') && !f.has('tick')) {
    // So the other one doesn't plan it again (L-10).
    const plan = planForIdea(item.id);
    if (plan && !plan.past) out.push(`Planned · ${relDay(plan.date)}`);
  }
  if (f.has('did')) {
    const last = lastDid(item);
    const n = d.did?.length ?? 0;
    if (last) out.push(`Did it ${n > 1 ? `${n} times, last ` : ''}${dayWord(last.date)}`);
  }
  return out;
}

/**
 * Every tick says so, with Undo; ticks in quick succession share one
 * message and one undo, so a mis-tick in the shop is one tap to fix
 * (review 0008, L-6).
 */
let tickRun: { names: string[]; undos: (() => void)[]; at: number } | null = null;
function noteTick(name: string, undo: () => void, next?: string | null): void {
  const now = Date.now();
  if (!tickRun || now - tickRun.at > 5000) tickRun = { names: [], undos: [], at: now };
  const run = tickRun;
  run.names.push(name);
  run.undos.push(undo);
  run.at = now;
  const message =
    run.names.length > 1
      ? `Ticked ${run.names.length} items.`
      : next !== undefined
        ? next
          ? `Done. Next: ${relDay(next)}.`
          : 'Done.'
        : `Ticked “${name}”.`;
  toast(message, () => {
    for (const u of [...run.undos].reverse()) u();
    if (tickRun === run) tickRun = null;
  });
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
      {sub.length > 0 && (
        <span class={`it-sub${late ? ' late' : ''}`}>
          {sub.join(' · ')}
          {f.has('due') && !!d.reminders?.length && d.before_days == null && (
            <span class="it-bell">
              <Icon name="bell" size={12} />
              <span class="sr"> · reminder set</span>
            </span>
          )}
        </span>
      )}
      {f.has('notes') && d.note && <span class="it-note">{d.note}</span>}
    </span>
  );
  if (chosen) {
    // Selecting: the whole row picks it; nothing else happens on a tap.
    return (
      <li class={`it selecting${done ? ' done' : ''}`} data-id={item.id}>
        {/* biome-ignore lint/a11y/noLabelWithoutControl: PickBox renders the checkbox inside this label */}
        <label class="chk">
          <PickBox id={item.id} listId={list.id} label={d.text} />
          {text}
        </label>
      </li>
    );
  }
  return (
    <li
      class={`it${done ? ' done' : ''}${bothWant(item) && f.has('hearts') ? ' agreed' : ''}${f.has('tick') ? '' : ' idea'}`}
      data-id={item.id}
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
                const undid = f.has('did') ? didIt(item) : null;
                if (d.repeat) setDone(false);
                noteTick(
                  d.text,
                  () => {
                    undid?.();
                    undo();
                  },
                  d.repeat ? next : undefined,
                );
              }, 420);
            }}
          />
          <span class="box">
            <Icon name="check" size={15} />
          </span>
          {text}
        </label>
      ) : (
        // An idea's row is one line: its name opens what you can do with it (L-11).
        <button
          type="button"
          class="grow it-open"
          onClick={() => {
            itemSheet.value = item.id;
          }}
        >
          {text}
        </button>
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
      </span>
    </li>
  );
}

/** Reads a typed line: a due date and repeat (lists with dates), how many and who (L-8). */
function readLine(v: string, list: ListEntry) {
  const f = featuresOf(list);
  // "Take out the bins every monday", "Renew passport by mar 1": a due date
  // and repeat come from the words (only date and repeat phrases are taken out).
  const parsed = f.has('due')
    ? parseQuickAdd(v, { today: today.value, dateOrder: DATE_ORDER })
    : null;
  // "Bins every monday 7pm": a time too, for a task with a date.
  const taken =
    parsed?.tokens.filter((t) => t.type === 'date' || t.type === 'repeat' || t.type === 'time') ??
    [];
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
  const me = viewer.value;
  const read = readItemText(taken.length ? name : v, {
    qty: f.has('qty'),
    who: f.has('who') && f.has('tick') && !list.rec.data.private,
    me,
    names: { a: nameOf('a'), b: nameOf('b') },
  });
  const time = parsed?.time ?? null;
  return {
    ...read,
    repeat,
    // A time alone ("call mum 6pm") is for today.
    due: parsed?.date ?? (repeat || time ? today.value : null),
    time,
  };
}

function AddItem({ list, placeholder }: { list: ListEntry; placeholder: string }) {
  const f = featuresOf(list);
  const [text, setText] = useState('');
  const [section, setSection] = useState('');
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sections = sectionsOf(list.id);
  const line = text.trim() ? readLine(text.trim(), list) : null;
  // What this list reads from the words, shown while the box is empty and in use.
  const tries = [
    ...(f.has('due') ? ['bins every monday 7pm', 'renew passport by mar 1'] : []),
    ...(f.has('qty') ? ['2 x milk'] : []),
    ...(f.has('who') && f.has('tick') && !list.rec.data.private
      ? [`call the plumber @${nameOf(partner.value)}`]
      : []),
  ].slice(0, 3);
  const ideas = line ? suggestItems(list.id, line.text).filter((i) => i.rec.data.done) : [];
  const bringBack = (
    item: ItemEntry,
    extra: { qty?: string | null; assignee?: Slot | null } = {},
  ) => {
    const r = updateItems([item.id], () => ({
      done: false,
      ...(extra.qty ? { qty: extra.qty } : {}),
      ...(extra.assignee ? { assignee: extra.assignee } : {}),
    }));
    toast(`Brought back “${item.rec.data.text}”.`, r.undo);
    setText('');
    input.current?.focus();
  };
  const submit = (e: Event) => {
    e.preventDefault();
    const v = text.trim();
    if (!v || !line) return;
    // The same thing again: a done one comes back, an open one isn't doubled.
    const same = sameItem(list.id, line.text);
    if (same?.rec.data.done) return bringBack(same, line);
    if (same && f.has('tick')) {
      toast(`“${same.rec.data.text}” is already on the list.`);
      setText('');
      return;
    }
    put(
      'item',
      {
        list_id: list.id,
        text: line.text,
        done: false,
        assignee: line.assignee,
        due: line.due,
        sort_key: topKey(list.id),
        ...(line.time ? { time: line.time } : {}),
        ...(line.repeat ? { repeat: line.repeat } : {}),
        ...(line.qty ? { qty: line.qty.slice(0, 30) } : {}),
        ...(f.has('sections') && section.trim() ? { section: section.trim().slice(0, 60) } : {}),
      },
      { scope: list.scope, owner: list.owner },
    );
    if (f.has('sections')) keepSection(list.id, section.trim().slice(0, 60));
    setText('');
    input.current?.focus();
  };
  const chips =
    line && line.text !== text.trim()
      ? [
          line.due && `${relDay(line.due)}${line.time ? ` · ${fmtTime(line.time)}` : ''}`,
          line.repeat && repeatText(line.repeat),
          line.qty && `How many: ${line.qty}`,
          line.assignee &&
            (line.assignee === viewer.value ? 'On me' : `On ${nameOf(line.assignee)}`),
        ].filter((x): x is string => !!x)
      : [];
  return (
    <div class="additem-wrap">
      <form class={`additem${f.has('sections') ? ' with-section' : ''}`} onSubmit={submit}>
        <input
          ref={input}
          class="txt"
          type="text"
          value={text}
          maxLength={500}
          onInput={(e) => setText(e.currentTarget.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          autocomplete="off"
          aria-label={`Add to ${list.rec.data.name}`}
          aria-describedby={`add-hint-${list.id} add-try-${list.id}`}
          aria-keyshortcuts="n a"
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
      {/* Floats under the box: showing or hiding it never moves the list. */}
      {focused && !text.trim() && tries.length > 0 && (
        <p class="add-try small" id={`add-try-${list.id}`}>
          Type it as you’d say it: {tries.map((x) => `“${x}”`).join(', ')}
        </p>
      )}
      <div class="add-hint" id={`add-hint-${list.id}`} aria-live="polite">
        {chips.map((c) => (
          <span class="pchip" key={c}>
            {c}
          </span>
        ))}
        {ideas.map((i) => (
          <button type="button" class="chip sm" key={i.id} onClick={() => bringBack(i, line ?? {})}>
            <Icon name="repeat" size={13} />
            Bring back “{i.rec.data.text}”
          </button>
        ))}
      </div>
    </div>
  );
}

const placeholderFor = (list: ListEntry) => {
  const f = featuresOf(list);
  if (list.rec.data.template === 'gifts' || list.rec.data.kind === 'gifts')
    return 'Add a gift idea';
  if (!f.has('tick') && f.has('plan')) return 'Add an idea';
  // The list's name is its heading now (review 0008, L-1).
  return 'Add an item';
};

/** Plans an idea on the next evening you're both free, linked back to the idea (L-10). */
export function planIdea(text: string, fromItem?: string) {
  openQuick({
    text,
    date: nextFreeEvening(),
    time: '19:00',
    who: 'ours',
    ...(fromItem ? { fromItem } : {}),
  });
}

/** A run of items under one heading: a section, a due-date band or a person. */
interface Group {
  key: string;
  title: string | null;
  items: ItemEntry[];
  /** A section's name: its heading folds away (kept on this device). */
  section?: string;
  late?: boolean;
}

/**
 * The open items in the list's order (L-4, L-7): due-date bands, by person,
 * A to Z, newest first, or the list's own order in its sections, kept in the
 * list's section order with items not in one last.
 */
function groupItems(items: ItemEntry[], list: ListEntry, order: ListOrder): Group[] {
  const f = featuresOf(list);
  const one = (sorted: ItemEntry[]): Group[] => [{ key: 'all', title: null, items: sorted }];
  if (order === 'az')
    return one([...items].sort((a, b) => a.rec.data.text.localeCompare(b.rec.data.text)));
  if (order === 'recent') return one([...items].sort((a, b) => (a.id < b.id ? 1 : -1)));
  if (order === 'due') {
    const t = today.value;
    const week = addDays(t, 7);
    const bands: Group[] = [
      { key: 'late', title: 'Overdue', items: [], late: true },
      { key: 'today', title: 'Today', items: [] },
      { key: 'week', title: 'This week', items: [] },
      { key: 'later', title: 'Later', items: [] },
      { key: 'none', title: 'No date', items: [] },
    ];
    const dues = new Map(items.map((i) => [i.id, dueOf(i)]));
    const sorted = [...items].sort((a, b) =>
      (dues.get(a.id) ?? '9999').localeCompare(dues.get(b.id) ?? '9999'),
    );
    for (const i of sorted) {
      const d = dues.get(i.id);
      const band = !d ? 4 : d < t ? 0 : d === t ? 1 : d <= week ? 2 : 3;
      bands[band]?.items.push(i);
    }
    const used = bands.filter((b) => b.items.length);
    // A single "No date" band needs no heading.
    return used.length === 1 && used[0]?.key === 'none' ? one(used[0].items) : used;
  }
  if (order === 'who') {
    const me = viewer.value;
    const p = partner.value;
    const groups: Group[] = [
      { key: 'me', title: 'Me', items: [] },
      { key: 'p', title: nameOf(p), items: [] },
      { key: 'none', title: 'Nobody yet', items: [] },
    ];
    for (const i of items) {
      const a = i.rec.data.assignee;
      groups[a === me ? 0 : a === p ? 1 : 2]?.items.push(i);
    }
    return groups.filter((g) => g.items.length);
  }
  if (!f.has('sections')) return one(items);
  const bySec = new Map<string, ItemEntry[]>();
  const loose: ItemEntry[] = [];
  for (const i of items) {
    const k = i.rec.data.section?.trim();
    if (!k) loose.push(i);
    else {
      const g = bySec.get(k);
      if (g) g.push(i);
      else bySec.set(k, [i]);
    }
  }
  const out: Group[] = [];
  for (const name of sectionsOf(list.id)) {
    const g = bySec.get(name);
    if (g) out.push({ key: `s:${name}`, title: name, items: g, section: name });
    bySec.delete(name);
  }
  for (const [name, g] of bySec)
    out.push({ key: `s:${name}`, title: name, items: g, section: name });
  if (loose.length) out.push({ key: 'loose', title: out.length ? 'Other' : null, items: loose });
  return out;
}

/**
 * Keys inside a list (review 0008, L-16): ↑/↓ go between rows, Alt+↑/↓
 * moves the item (when the list keeps its own order), x ticks it, and e or
 * Enter opens its details.
 */
function rowKeys(e: KeyboardEvent, list: ListEntry): void {
  const t = e.target as HTMLElement;
  if (t.closest('input[type="text"], input[type="search"], textarea, select')) return;
  const row = t.closest<HTMLElement>('li.it');
  if (!row) return;
  const rows = [...(row.closest('.listcard')?.querySelectorAll<HTMLElement>('li.it') ?? [])];
  const at = rows.indexOf(row);
  const focusRow = (r: HTMLElement | undefined) =>
    r?.querySelector<HTMLElement>('input[type="checkbox"], .it-open, .it-more')?.focus();
  const id = row.dataset.id;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const down = e.key === 'ArrowDown';
    if (!e.altKey) {
      focusRow(rows[at + (down ? 1 : -1)]);
      return;
    }
    const item = id ? (findEntry(id) as ItemEntry | undefined) : undefined;
    if (!item || orderOf(list) !== 'own') return;
    moveItem(item, down ? 'down' : 'up', peersOf(item, list));
    requestAnimationFrame(() =>
      focusRow(document.querySelector<HTMLElement>(`li.it[data-id="${id}"]`) ?? undefined),
    );
    return;
  }
  if (!id || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'e' || (e.key === 'Enter' && t.matches('input[type="checkbox"]'))) {
    e.preventDefault();
    itemSheet.value = id;
  } else if (e.key === 'x') {
    const box = row.querySelector<HTMLInputElement>('.chk input[type="checkbox"]');
    if (box) {
      e.preventDefault();
      box.click();
    }
  }
}

/** Sections folded away, per list, on this device only. */
const FOLD_KEY = 'ours-folded';
const folded = signal<Record<string, string[]>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, string[]>;
    } catch {
      return {};
    }
  })(),
);
function toggleFold(listId: string, name: string): void {
  const cur = folded.value[listId] ?? [];
  const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
  folded.value = { ...folded.value, [listId]: next };
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(folded.value));
  } catch {
    // private mode: folds last until the page closes
  }
}

/**
 * How many of a long list's rows to draw: the first screenful at once, then
 * more each frame, so a list of hundreds opens without a pause (review 0008,
 * L-4 and L-5). Everything is drawn within a few frames.
 */
const FIRST_ROWS = 60;
function useProgressive(total: number): number {
  const [limit, setLimit] = useState(FIRST_ROWS);
  useEffect(() => {
    if (limit >= total) return;
    const frame = requestAnimationFrame(() => setLimit((l) => l + 120));
    return () => cancelAnimationFrame(frame);
  }, [limit, total]);
  return limit;
}

function Items({
  items: all,
  list,
  done = false,
}: {
  items: ItemEntry[];
  list: ListEntry;
  done?: boolean;
}) {
  const limit = useProgressive(all.length);
  const groups = done
    ? [{ key: 'done', title: null, items: all } as Group]
    : groupItems(all, list, orderOf(list));
  const shut = folded.value[list.id] ?? [];
  let left = limit;
  return (
    <>
      {groups.map((g) => {
        const isShut = !!g.section && shut.includes(g.section);
        const rows = isShut ? [] : g.items.slice(0, Math.max(0, left));
        left -= rows.length;
        const list_ = (
          <ul class="items" onKeyDown={(e) => rowKeys(e, list)}>
            {rows.map((i) => (
              <ItemRow key={i.id} item={i} list={list} />
            ))}
          </ul>
        );
        if (!g.title) return <Fragment key={g.key}>{list_}</Fragment>;
        const section = g.section;
        return (
          <section class="isection" key={g.key} aria-label={g.title}>
            <h2 class={`eyebrow isec-h${g.late ? ' late' : ''}`}>
              {section ? (
                <button
                  type="button"
                  class="isec-fold"
                  aria-expanded={!isShut}
                  onClick={() => toggleFold(list.id, section)}
                >
                  <Icon name={isShut ? 'next' : 'down'} size={14} />
                  {g.title}
                  <span class="n">{g.items.length}</span>
                </button>
              ) : (
                <>
                  {g.title}
                  <span class="n">{g.items.length}</span>
                </>
              )}
            </h2>
            {list_}
          </section>
        );
      })}
    </>
  );
}

/** Filter chips for the features a list has, applied to the list and to "pick one". */
function Filters({ list, pool }: { list: ListEntry; pool?: ItemEntry[] }) {
  const f = featuresOf(list);
  const v = filters.value;
  const chips: [keyof typeof v, string][] = [];
  if (f.has('hearts')) chips.push(['both', 'We both want']);
  if (f.has('when'))
    chips.push(['soon', 'Soon'], ['season', `Good in ${SEASON_NAME[seasonNow()].toLowerCase()}`]);
  if (f.has('did')) chips.push(['favs', 'Favourites']);
  // "Pick one for us" leads the row (until a pick is showing): one row, not two.
  const pickBtn = pool && !pool.some((i) => i.id === picked.value) && (
    <button
      type="button"
      class="btn primary sm pickbtn"
      onClick={() => shufflePick(pool)}
      disabled={!pool.length}
    >
      <Icon name="shuffle" size={15} />
      Pick one for us
    </button>
  );
  if (!chips.length) return pickBtn ? <div class="ltoolbar">{pickBtn}</div> : null;
  return (
    <div class="ltoolbar">
      {pickBtn}
      {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled */}
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
    </div>
  );
}

function applyFilters(items: ItemEntry[], f: ReadonlySet<Feature>): ItemEntry[] {
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

/** Picks an idea at random from `pool`, never the same one twice in a row. */
function shufflePick(pool: ItemEntry[]): void {
  if (!pool.length) return;
  let n: ItemEntry | undefined;
  do n = pool[Math.floor(Math.random() * pool.length)];
  while (pool.length > 1 && n?.id === picked.value);
  picked.value = n?.id ?? null;
}

/** The pick, once made: plan it or pick another. The button to pick sits with the filters. */
function Pick({ list, pool }: { list: ListEntry; pool: ItemEntry[] }) {
  const f = featuresOf(list);
  const pick = pool.find((i) => i.id === picked.value);
  const shuffle = () => shufflePick(pool);
  if (!pick) return null;
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
          <button
            type="button"
            class="btn primary sm"
            onClick={() => planIdea(pick.rec.data.text, pick.id)}
          >
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

const ORDER_LABEL: Record<ListOrder, string> = {
  own: 'Our order',
  due: 'Due date',
  who: 'Who’s on it',
  az: 'A to Z',
  recent: 'Newest first',
};

/** How the list is ordered (kept on the list, for both of you), and finding in a long one. */
function ListTools({
  list,
  count,
  find,
  setFind,
}: {
  list: ListEntry;
  count: number;
  find: string;
  setFind: (v: string) => void;
}) {
  const f = featuresOf(list);
  const order = orderOf(list);
  const choices = (Object.keys(ORDER_LABEL) as ListOrder[]).filter(
    (o) => (o !== 'due' || f.has('due')) && (o !== 'who' || f.has('who')),
  );
  // Short lists don't need it: the row would only cost height.
  if (count < 6) return null;
  return (
    <div class="ltools">
      {count >= 30 && (
        <input
          class="txt sm"
          type="search"
          value={find}
          onInput={(e) => setFind(e.currentTarget.value)}
          placeholder="Find in this list"
          aria-label={`Find in ${list.rec.data.name}`}
          autocomplete="off"
        />
      )}
      <label class="ltools-order">
        <span class="small muted">Order</span>
        <select
          class="txt sm"
          value={order}
          onChange={(e) => update<'list'>(list.id, { order: e.currentTarget.value as ListOrder })}
        >
          {choices.map((o) => (
            <option key={o} value={o}>
              {ORDER_LABEL[o]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ListBody({ list }: { list: ListEntry }) {
  const f = featuresOf(list);
  const everything = itemsOf(list.id);
  const [find, setFind] = useState('');
  const needle = find.trim().toLowerCase();
  // "Find in this list" (L-4): by name, note or section.
  const all = needle
    ? everything.filter((i) =>
        [i.rec.data.text, i.rec.data.note, i.rec.data.section].some((x) =>
          x?.toLowerCase().includes(needle),
        ),
      )
    : everything;
  const open = applyFilters(f.has('tick') ? all.filter((i) => !i.rec.data.done) : all, f);
  // Most recently ticked first, so a mis-tick is at the top (L-6).
  const done = f.has('tick')
    ? all.filter((i) => i.rec.data.done).sort((a, b) => b.rec.updated_at - a.rec.updated_at)
    : [];
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
      <Filters list={list} {...(f.has('pick') && !selecting(list.id) ? { pool: open } : {})} />
      {!selecting(list.id) && <AddItem list={list} placeholder={placeholderFor(list)} />}
      <ListTools list={list} count={everything.length} find={find} setFind={setFind} />
      <Items items={open} list={list} />
      {!open.length && (
        <p class="nothing">
          {all.length
            ? f.has('tick') && !filters.value.both && !filters.value.soon
              ? 'All done.'
              : 'Nothing matches.'
            : 'Nothing here yet.'}
          {needle && ' '}
          {needle && (
            <button type="button" class="linkbtn" onClick={() => setFind('')}>
              Clear the search
            </button>
          )}
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
          {showDone.value && <Items items={done} list={list} done />}
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
  const sel = selecting(list.id) ? { ids: picks.value } : null;
  const [panel, setPanel] = useState<'due' | 'who' | 'section' | 'move' | null>(null);
  const [target, setTarget] = useState('');
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
  const sections = sectionsOf(list.id);
  const things = (k: number) => `${k} ${k === 1 ? 'item' : 'items'}`;
  const done = (msg: string, r: { undo: () => void; changed: number }, exit = false) => {
    setPanel(null);
    setArmed(false);
    if (exit) startSelecting(null);
    toast(r.changed ? msg.replace('#', things(r.changed)) : 'Nothing to change.', r.undo);
  };
  const toggle = (which: 'due' | 'who' | 'section' | 'move') => {
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
            picks.value = allShown ? new Set() : new Set(shown.map((i) => i.id));
          }}
        >
          {allShown ? 'Select none' : 'Select all'}
        </button>
        <button type="button" class="linkbtn" onClick={() => startSelecting(null)}>
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
      {panel === 'move' &&
        (() => {
          const others = activeLists().filter((l) => l.id !== list.id);
          // Nothing chosen yet: the first list on the same side of privacy.
          const dest =
            others.find((l) => l.id === target) ??
            others.find((l) => !movesScope(list, l)) ??
            others[0];
          const crossing = !!dest && movesScope(list, dest);
          return (
            <form
              class="bulk-panel"
              onSubmit={(e) => {
                e.preventDefault();
                if (!dest) return;
                // Across privacy it asks first: a second tap, once it says what happens.
                if (crossing && !armed) {
                  setArmed(true);
                  return;
                }
                const r = moveItems(ids, dest.id);
                done(`Moved # to ${dest.rec.data.name}.`, { undo: r.undo, changed: r.moved }, true);
              }}
            >
              <label class="sr" for="bulk-move">
                Move to
              </label>
              <select
                id="bulk-move"
                class="txt"
                value={dest?.id ?? ''}
                onChange={(e) => {
                  setTarget(e.currentTarget.value);
                  setArmed(false);
                }}
              >
                {others.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.rec.data.private ? `${l.rec.data.name} (just you)` : l.rec.data.name}
                  </option>
                ))}
              </select>
              <button class="btn sm primary" type="submit" disabled={!dest}>
                {crossing && armed ? 'Move them anyway' : 'Move'}
              </button>
              {crossing && dest && (
                <p class="small" role={armed ? 'alert' : 'status'}>
                  {dest.rec.data.private
                    ? `${nameOf(p)} won’t see them any more.`
                    : `${nameOf(p)} will see them.`}
                  {armed ? ' Tap again to move them.' : ''}
                </p>
              )}
            </form>
          );
        })()}
      {panel === 'section' && (
        <form
          class="bulk-panel"
          onSubmit={(e) => {
            e.preventDefault();
            const name = section.trim().slice(0, 60) || null;
            keepSection(list.id, name);
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
        {activeLists().length > 1 && (
          <button
            type="button"
            class="btn sm"
            disabled={!n}
            aria-expanded={panel === 'move'}
            onClick={() => toggle('move')}
          >
            <Icon name="move" size={15} />
            Move
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

/** Makes a list a coming plan's checklist, so "days before" count from it (L-9). */
function AttachToPlan({ listId }: { listId: string }) {
  const t = today.value;
  const plans = byKind('event')
    .filter(
      (e) =>
        e.rec.kind === 'event' &&
        e.rec.data.status !== 'declined' &&
        !e.rec.data.rrule &&
        e.rec.data.end.slice(0, 10) >= t,
    )
    .sort((a, b) =>
      (a.rec.data as { start: string }).start.localeCompare(
        (b.rec.data as { start: string }).start,
      ),
    )
    .slice(0, 30);
  if (!plans.length) return null;
  return (
    <div class="field">
      <label for="le-plan">For a plan</label>
      <select
        id="le-plan"
        class="txt"
        value=""
        onChange={(e) => {
          const planId = e.currentTarget.value;
          if (!planId) return;
          setListPlan(listId, planId);
          toast('It’s that plan’s checklist now. Days before count from it.');
        }}
      >
        <option value="">Not for a plan</option>
        {plans.map((e) =>
          e.rec.kind === 'event' ? (
            <option key={e.id} value={e.id}>
              {e.rec.data.title} · {fmtLong(e.rec.data.start.slice(0, 10))}
            </option>
          ) : null,
        )}
      </select>
    </div>
  );
}

/** A list's sections in order: rename (every item follows) and move up or down (L-7). */
function SectionsEditor({ listId }: { listId: string }) {
  const names = sectionsOf(listId);
  return (
    <fieldset class="fgroup">
      <legend class="eyebrow">Sections, in order</legend>
      <ul class="sw-list">
        {names.map((name, i) => (
          <li key={name} class="sw-li">
            <input
              class="txt sm"
              type="text"
              defaultValue={name}
              maxLength={60}
              aria-label={`Rename section ${name}`}
              autocomplete="off"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              onBlur={(e) => {
                const to = e.currentTarget.value.trim();
                if (!to || to === name) {
                  e.currentTarget.value = name;
                  return;
                }
                toast(`Renamed “${name}” to “${to}”.`, renameSection(listId, name, to));
              }}
            />
            <span class="sw-tools">
              <button
                type="button"
                class="iconbtn"
                aria-label={`Move ${name} up`}
                disabled={i === 0}
                onClick={() => moveSection(listId, name, -1)}
              >
                <Icon name="up" size={16} />
              </button>
              <button
                type="button"
                class="iconbtn"
                aria-label={`Move ${name} down`}
                disabled={i === names.length - 1}
                onClick={() => moveSection(listId, name, 1)}
              >
                <Icon name="down" size={16} />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function ListSettingsSheet({ id }: { id: string }) {
  const list = allLists().find((l) => l.id === id);
  const [name, setName] = useState(list?.rec.data.name ?? '');
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [withItems, setWithItems] = useState(true);
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
            data-autofocus={typeFirst() || undefined}
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
        {!list.rec.data.archived && (
          <Switch
            checked={!!list.rec.data.pinned}
            onChange={(v) => setPinned(id, v)}
            label="Pin to the top"
            hint="Pinned lists come first, for both of you."
          />
        )}
        {!plan && <AttachToPlan listId={id} />}
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
        {f.has('sections') && sectionsOf(id).length > 0 && <SectionsEditor listId={id} />}
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
              <button
                type="button"
                class="btn sm"
                onClick={() => {
                  const archive = !list.rec.data.archived;
                  const undo = setArchived(id, archive);
                  closeSheet();
                  if (archive) {
                    currentList.value = null;
                    toast(`Archived “${list.rec.data.name}”. It’s still in search.`, undo);
                  } else toast(`“${list.rec.data.name}” is back with your lists.`);
                }}
              >
                <Icon name="archive" size={15} />
                {list.rec.data.archived ? 'Bring back' : 'Archive'}
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
                    saveStartingPoint(list, n, withItems);
                    setSaving(null);
                    toast(
                      `Saved “${n}”${withItems && count ? ` with its ${count} items` : ''}. It’s in New list for ${
                        list.rec.data.private ? 'you' : 'both of you'
                      }.`,
                    );
                  }}
                >
                  Save
                </button>
              </div>
              {count > 0 && (
                <Switch
                  checked={withItems}
                  onChange={setWithItems}
                  label={`Include its ${count} item${count === 1 ? '' : 's'}`}
                  hint="Unticked, with their sections and days before. Hearts and memories stay here."
                />
              )}
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
/** Opens a list, leaving any view across lists. */
function openList(id: string): void {
  currentList.value = id;
  crossView.value = null;
  picked.value = null;
  filters.value = { both: false, soon: false, season: false, favs: false };
}

/**
 * Every list in one place (review 0008, L-1): grouped, with a filter once
 * there are more than a few, the views across lists, archived lists, and an
 * order mode to move and pin lists (L-2).
 */
function ListSwitcher({ current, find = false }: { current: string | null; find?: boolean }) {
  const [q, setQ] = useState('');
  const [ordering, setOrdering] = useState(false);
  const all = allLists();
  const active = activeLists();
  const needle = q.trim().toLowerCase();
  const match = (l: ListEntry) => !needle || l.rec.data.name.toLowerCase().includes(needle);
  const go = (id: string) => {
    openList(id);
    closeSheet();
  };
  const pinned = active.filter((l) => l.rec.data.pinned);
  const rest = active.filter((l) => !l.rec.data.pinned);
  const groups: [string, ListEntry[]][] = ordering
    ? [
        ['Pinned', pinned],
        ['Lists', rest],
      ]
    : [
        ['Pinned', pinned],
        ['Shared', rest.filter((l) => !l.rec.data.private && !l.rec.data.plan_id)],
        ['Just for you', rest.filter((l) => l.rec.data.private && !l.rec.data.plan_id)],
        ['Plans’ checklists', rest.filter((l) => l.rec.data.plan_id)],
      ];
  const archived = all.filter((l) => l.rec.data.archived && match(l));
  const row = (l: ListEntry, i: number, group: ListEntry[]) => {
    const { n, what } = countOf(l);
    const name = l.rec.data.name;
    return (
      <li key={l.id} class="sw-li">
        <button
          type="button"
          class="sw-row"
          aria-current={l.id === current ? 'true' : undefined}
          onClick={() => go(l.id)}
        >
          {l.rec.data.private && <Icon name="lock" size={14} />}
          {l.rec.data.private && <span class="sr">Private: </span>}
          <span class="sw-name">{name}</span>
          <span class="n">
            {n}
            <span class="sr"> {what}</span>
          </span>
        </button>
        {ordering && !l.rec.data.archived && (
          <span class="sw-tools">
            <button
              type="button"
              class="iconbtn"
              aria-label={`Move ${name} up`}
              disabled={i === 0}
              onClick={() => moveList(l.id, -1)}
            >
              <Icon name="up" size={16} />
            </button>
            <button
              type="button"
              class="iconbtn"
              aria-label={`Move ${name} down`}
              disabled={i === group.length - 1}
              onClick={() => moveList(l.id, 1)}
            >
              <Icon name="down" size={16} />
            </button>
            <button
              type="button"
              class="iconbtn"
              aria-label={`Pin ${name}`}
              aria-pressed={!!l.rec.data.pinned}
              onClick={() => setPinned(l.id, !l.rec.data.pinned)}
            >
              <Icon name="star" size={16} />
            </button>
          </span>
        )}
      </li>
    );
  };
  return (
    <Sheet labelledBy="sw-title" onClose={closeSheet}>
      <div class="sheet-form">
        <div class="sh-head">
          <h2 id="sw-title">Your lists</h2>
          <CloseButton onClose={closeSheet} />
        </div>
        {all.length > FIND_LISTS && !ordering && (
          <input
            data-autofocus={find || typeFirst() || undefined}
            class="txt"
            type="search"
            value={q}
            onInput={(e) => setQ(e.currentTarget.value)}
            placeholder="Find a list"
            aria-label="Find a list"
            autocomplete="off"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const first = active.find(match) ?? all.find(match);
              if (first) go(first.id);
            }}
          />
        )}
        {!needle && !ordering && (
          <section class="sw-group" aria-labelledby="sw-x">
            <h3 class="eyebrow" id="sw-x">
              Across lists
            </h3>
            <CrossViews
              onPick={() => {
                picked.value = null;
                closeSheet();
              }}
            />
          </section>
        )}
        {groups.map(([title, lists]) => {
          const shown = lists.filter(match);
          if (!shown.length) return null;
          const gid = `sw-${title.replace(/\W+/g, '-').toLowerCase()}`;
          return (
            <section class="sw-group" key={title} aria-labelledby={gid}>
              <h3 class="eyebrow" id={gid}>
                {title}
              </h3>
              <ul class="sw-list">{shown.map((l, i) => row(l, i, shown))}</ul>
            </section>
          );
        })}
        {archived.length > 0 && !ordering && (
          <details class="sw-group" open={!!needle}>
            <summary class="eyebrow">Archived ({archived.length})</summary>
            <ul class="sw-list">{archived.map((l, i) => row(l, i, archived))}</ul>
          </details>
        )}
        {active.length > 1 && (
          <button type="button" class="linkbtn" onClick={() => setOrdering(!ordering)}>
            {ordering ? 'Done' : 'Change the order or pin lists'}
          </button>
        )}
      </div>
    </Sheet>
  );
}

function startLabel(list: ListEntry): string {
  const t = list.rec.data.template;
  return STARTING_POINTS.find((s) => s.template === t)?.label ?? 'List';
}

/* ---------- view ---------- */

export function ListsView() {
  const lists = activeLists();
  const view = crossView.value;
  // An archived list can still be open (from search, or the switcher).
  const cur = view
    ? undefined
    : (allLists().find((l) => l.id === currentList.value) ?? lists[0] ?? allLists()[0]);
  const s = listSheet.value;
  const [findList, setFindList] = useState('');
  const needle = findList.trim().toLowerCase();
  const shownLists = needle
    ? lists.filter((l) => l.rec.data.name.toLowerCase().includes(needle))
    : lists;
  // Keep the open list's tab in view, however it was opened (search, a new
  // list, a plan's checklist): the row can be far wider than the screen (L-1).
  const curId = cur?.id;
  useEffect(() => {
    if (!curId) return;
    document
      .querySelector('.ltabs .ltab[aria-pressed="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [curId]);
  return (
    <>
      <header class="vhead">
        <div>
          <p class="eyebrow">
            {lists.length} {lists.length === 1 ? 'list' : 'lists'}
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
            {lists.length > FIND_LISTS && (
              // Many lists: find one by name (wide screens; phones get a search button).
              <input
                class="txt sm lfind"
                type="search"
                value={findList}
                onInput={(e) => setFindList(e.currentTarget.value)}
                placeholder="Find a list"
                aria-label="Find a list"
                autocomplete="off"
              />
            )}
            {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
            <div class="ltabs" role="group" aria-label="Lists">
              {lists.length > FIND_LISTS && (
                <button
                  type="button"
                  class="ltab lfind-btn"
                  aria-label="Find a list"
                  onClick={() => {
                    listSheet.value = { type: 'switch', find: true };
                  }}
                >
                  <Icon name="search" size={16} />
                </button>
              )}
              {shownLists.map((l) => {
                const { n, what } = countOf(l);
                return (
                  <button
                    type="button"
                    class="ltab"
                    key={l.id}
                    aria-pressed={!view && l.id === cur?.id}
                    onClick={() => openList(l.id)}
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
              {needle && !shownLists.length && <p class="small muted">No list called that.</p>}
            </div>
          </div>
          <div class="lists-pane">
            {cur ? (
              <>
                <div class="listbar">
                  {/* The list's own name, and who sees it (review 0008, L-1). */}
                  <div class="ltitle">
                    <h2 class="h3" id="list-h">
                      {/* The name opens every list: the way to find one among many. */}
                      <button
                        type="button"
                        class="lswitch"
                        aria-haspopup="dialog"
                        aria-describedby="lswitch-d"
                        onClick={() => {
                          listSheet.value = { type: 'switch' };
                        }}
                      >
                        {cur.rec.data.private && <Icon name="lock" size={15} />}
                        {cur.rec.data.name}
                        <Icon name="down" size={16} />
                      </button>
                    </h2>
                    <span class="sr" id="lswitch-d">
                      Shows all your lists
                    </span>
                    <span class="small muted">
                      {cur.rec.data.archived
                        ? 'Archived'
                        : cur.rec.data.private
                          ? 'Just for you'
                          : `Shared with ${nameOf(partner.value)}`}{' '}
                      · {startLabel(cur)}
                      {cur.rec.data.archived && (
                        <>
                          {' · '}
                          <button
                            type="button"
                            class="linkbtn"
                            onClick={() => {
                              setArchived(cur.id, false);
                              toast(`“${cur.rec.data.name}” is back with your lists.`);
                            }}
                          >
                            Bring back
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                  {itemsOf(cur.id).length > 1 && (
                    <button
                      type="button"
                      class="linkbtn lselect"
                      aria-pressed={selecting(cur.id)}
                      onClick={() => startSelecting(selecting(cur.id) ? null : cur.id)}
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
      {s?.type === 'switch' && <ListSwitcher current={cur?.id ?? null} find={!!s.find} />}
    </>
  );
}
