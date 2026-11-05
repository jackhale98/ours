// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lists: what each can do (features, switched on in its settings), the
 * starting points that switch on a set of them, and list operations.
 */
import {
  keyBetween,
  keysBetween,
  LIST_FEATURES,
  type ListFeature,
  type ListKind,
  type ListTemplate,
  type Reaction,
  type Season,
  uuidv7,
} from '@ours/core/schema';
import { addDays, nextDueDate } from '@ours/core/time';
import { computed, signal } from '@preact/signals';
import {
  bulk,
  byKind,
  type Entry,
  findEntry,
  other,
  put,
  remove,
  type Slot,
  settings,
  store,
  update,
  updateSettings,
} from './model';
import { relDay, today } from './select';

export type ListEntry = Entry & { rec: { kind: 'list' } };
export type ItemEntry = Entry & { rec: { kind: 'item' } };

/** The list shown on the Lists screen (the first one if null). */
export const currentList = signal<string | null>(null);

/* ---------- features and starting points ---------- */

export type Feature = ListFeature;

/** What each switch is called in a list's settings, and the group it sits in. */
export const FEATURES: Record<Feature, { label: string; hint: string; group: FeatureGroup }> = {
  tick: { label: 'Tick off', hint: 'Things get done and ticked off.', group: 'doing' },
  who: { label: 'Who’s on it', hint: 'Give things to one of you, and take turns.', group: 'doing' },
  due: { label: 'Due dates and repeats', hint: 'By when, and how often.', group: 'doing' },
  pick: { label: 'Pick one for us', hint: 'Can’t decide? Let Ours choose.', group: 'ideas' },
  plan: { label: 'Plan it', hint: 'Turn one into a plan when you’re both free.', group: 'ideas' },
  length: { label: 'How long', hint: 'Roughly, to fit the time you have.', group: 'ideas' },
  hearts: {
    label: 'We both want',
    hint: 'Each of you hearts what you’d like; see what you agree on.',
    group: 'ideas',
  },
  did: {
    label: 'We did it',
    hint: 'Keep when you did it and how it was. Mark favourites.',
    group: 'ideas',
  },
  when: { label: 'Soon or someday', hint: 'And the best seasons for it.', group: 'ideas' },
  notes: { label: 'Notes', hint: 'A few words on each.', group: 'details' },
  qty: { label: 'How many', hint: 'Quantities, like “2” or “500 g”.', group: 'details' },
  link: { label: 'Links', hint: 'A web address. Ours never opens it for you.', group: 'details' },
  price: { label: 'Prices', hint: 'With a total of what’s still to get.', group: 'details' },
  sections: { label: 'Sections', hint: 'Group things, like aisles or days.', group: 'details' },
};
export type FeatureGroup = 'doing' | 'ideas' | 'details';
export const FEATURE_GROUPS: [FeatureGroup, string][] = [
  ['doing', 'Getting things done'],
  ['ideas', 'Ideas and memories'],
  ['details', 'Details on each'],
];

/** A starting point: a name and a set of switches, changeable later. */
export interface StartingPoint {
  id: string;
  template: ListTemplate;
  label: string;
  blurb: string;
  example: string;
  features: Feature[];
  private: boolean;
  checkin?: boolean;
  /** A saved starting point's items, kept in a hidden list (review 0008, L-9). */
  listId?: string;
}

export const STARTING_POINTS: StartingPoint[] = [
  {
    id: 'groceries',
    template: 'groceries',
    label: 'Groceries',
    blurb: 'Tick off, with how many, aisles and who’s getting it.',
    example: 'Groceries',
    features: ['tick', 'who', 'qty', 'sections', 'notes'],
    private: false,
  },
  {
    id: 'todo',
    template: 'todo',
    label: 'To-dos',
    blurb: 'Who’s on it, and by when.',
    example: 'To-dos',
    features: ['tick', 'who', 'due', 'notes'],
    private: false,
  },
  {
    id: 'chores',
    template: 'chores',
    label: 'Chores',
    blurb: 'Repeats, taking turns, in the weekly check-in.',
    example: 'Chores',
    features: ['tick', 'who', 'due'],
    private: false,
    checkin: true,
  },
  {
    id: 'dates',
    template: 'dates',
    label: 'Date ideas',
    blurb: 'Pick one, plan it, remember how it was.',
    example: 'Date ideas',
    features: ['pick', 'plan', 'length', 'hearts', 'did', 'when', 'notes'],
    private: false,
  },
  {
    id: 'watch',
    template: 'watch',
    label: 'Watchlist',
    blurb: 'Films and shows you both want to see.',
    example: 'To watch',
    features: ['pick', 'hearts', 'did', 'notes', 'link'],
    private: false,
  },
  {
    id: 'restaurants',
    template: 'restaurants',
    label: 'Places to try',
    blurb: 'Restaurants, cafés, day trips.',
    example: 'Places to try',
    features: ['pick', 'plan', 'hearts', 'did', 'notes', 'link'],
    private: false,
  },
  {
    id: 'gifts',
    template: 'gifts',
    label: 'Gift ideas',
    blurb: 'Just for you by default, with links and prices.',
    example: 'Gift ideas',
    features: ['tick', 'notes', 'link', 'price'],
    private: true,
  },
  {
    id: 'packing',
    template: 'packing',
    label: 'Packing',
    blurb: 'For a trip, with sections. Start over next time.',
    example: 'Packing',
    features: ['tick', 'qty', 'sections', 'due'],
    private: false,
  },
  {
    id: 'bucket',
    template: 'bucket',
    label: 'Bucket list',
    blurb: 'Big things, someday. Mark them off together.',
    example: 'Bucket list',
    features: ['hearts', 'did', 'when', 'notes', 'plan'],
    private: false,
  },
  {
    id: 'blank',
    template: 'blank',
    label: 'Blank list',
    blurb: 'Switch on just what you want.',
    example: 'New list',
    features: ['tick'],
    private: false,
  },
];

/** Starting points saved from your own lists (shared settings). */
export function savedStartingPoints(): StartingPoint[] {
  return (settings.value.list_templates ?? []).map((t) => ({
    id: t.id,
    template: 'custom',
    label: t.name,
    blurb: [
      ...(t.list_id && itemsOf(t.list_id).length ? [`${itemsOf(t.list_id).length} items`] : []),
      ...t.features.map((f) => FEATURES[f].label),
    ].join(', '),
    example: t.name,
    features: t.features,
    private: t.private,
    ...(t.list_id ? { listId: t.list_id } : {}),
  }));
}

/** What lists made before features existed can do, from their old kind. */
function defaultsFor(kind: ListKind): Feature[] {
  if (kind === 'ideas') return ['pick', 'plan', 'length'];
  if (kind === 'gifts') return ['tick'];
  return ['tick', 'who', 'due'];
}

const featureCache = new WeakMap<ListEntry, ReadonlySet<Feature>>();
/** A list's features; worked out once per version of the list (rows ask often). */
export function featuresOf(list: ListEntry): ReadonlySet<Feature> {
  const hit = featureCache.get(list);
  if (hit) return hit;
  const f = new Set(list.rec.data.features ?? defaultsFor(list.rec.data.kind));
  // Who's on it only means something when the list is shared.
  if (list.rec.data.private) f.delete('who');
  featureCache.set(list, f);
  return f;
}
export const has = (list: ListEntry, f: Feature) => featuresOf(list).has(f);

/** The old kind that best matches some features, for older versions of the app. */
function kindFor(features: readonly Feature[], template?: ListTemplate): ListKind {
  if (template === 'gifts') return 'gifts';
  if (template === 'groceries') return 'shopping';
  if (!features.includes('tick') && (features.includes('pick') || features.includes('plan')))
    return 'ideas';
  return 'todo';
}

/** A list's kind of things, in words: "3 open" or "5 ideas". */
export function countOf(list: ListEntry): { n: number; what: string } {
  const items = itemsOf(list.id);
  if (has(list, 'tick')) return { n: items.filter((i) => !i.rec.data.done).length, what: 'open' };
  return { n: items.length, what: 'ideas' };
}

/** Pinned first, then each list's place (L-2); lists never placed come after, oldest first. */
function byListOrder(a: ListEntry, b: ListEntry): number {
  const [x, y] = [a.rec.data, b.rec.data];
  if (!!x.pinned !== !!y.pinned) return x.pinned ? -1 : 1;
  const [kx, ky] = [x.sort_key ?? null, y.sort_key ?? null];
  if (kx !== ky) {
    if (kx === null) return 1;
    if (ky === null) return -1;
    return kx < ky ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const listIndex = computed(() => {
  const lists = (byKind('list') as ListEntry[]).filter((l) => !l.rec.data.stash);
  const all = Object.freeze([...lists].sort(byListOrder));
  return { all, active: Object.freeze(all.filter((l) => !l.rec.data.archived)) };
});

/** Every list in order, archived ones too (search, plans' checklists). Frozen. */
export function allLists(): ListEntry[] {
  return listIndex.value.all as ListEntry[];
}

/** The lists in use: not archived (the switcher, check-in, views across lists). Frozen. */
export function activeLists(): ListEntry[] {
  return listIndex.value.active as ListEntry[];
}

export function archivedLists(): ListEntry[] {
  return allLists().filter((l) => l.rec.data.archived);
}

export function setPinned(id: string, pinned: boolean): void {
  update<'list'>(id, { pinned });
}

/** Archives or brings back a list. Returns undo. */
export function setArchived(id: string, archived: boolean): () => void {
  const d = (findEntry(id) as ListEntry | undefined)?.rec.data;
  const was = { archived: !!d?.archived, pinned: !!d?.pinned };
  update<'list'>(id, { archived, ...(archived ? { pinned: false } : {}) });
  return () => update<'list'>(id, was);
}

/**
 * Moves a list up or down one place among the lists in use (within pinned
 * or unpinned ones). Lists that never had a place get one first, in their
 * current order, so the move is the same on both phones.
 */
export function moveList(id: string, by: -1 | 1): void {
  const list = findEntry(id) as ListEntry | undefined;
  if (!list) return;
  const group = activeLists().filter((l) => !!l.rec.data.pinned === !!list.rec.data.pinned);
  const at = group.findIndex((l) => l.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= group.length) return;
  bulk(() => {
    let keys = group.map((l) => l.rec.data.sort_key ?? null);
    if (keys.some((k, i) => k === null || (i > 0 && (keys[i - 1] ?? '') >= k))) {
      const fresh = keysBetween(null, null, group.length);
      group.forEach((l, i) => {
        update<'list'>(l.id, { sort_key: fresh[i] as string });
      });
      keys = fresh;
    }
    // Between the neighbours on the far side of the one it passes.
    const lo = by < 0 ? (keys[to - 1] ?? null) : keys[to];
    const hi = by < 0 ? keys[to] : (keys[to + 1] ?? null);
    update<'list'>(id, { sort_key: keyBetween(lo ?? null, hi ?? null) });
  });
}

/** In list order; the same on every device even if two keys tie (review 0008, L-14). */
export const bySortKey = (a: ItemEntry, b: ItemEntry) =>
  a.rec.data.sort_key < b.rec.data.sort_key
    ? -1
    : a.rec.data.sort_key > b.rec.data.sort_key
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

/** Items by list, sorted once per change of the store (review 0008, L-5). */
const itemIndex = computed(() => {
  const lists = new Map<string, ItemEntry[]>();
  for (const i of byKind('item') as ItemEntry[]) {
    const list = lists.get(i.rec.data.list_id);
    if (list) list.push(i);
    else lists.set(i.rec.data.list_id, [i]);
  }
  for (const list of lists.values()) Object.freeze(list.sort(bySortKey));
  return lists;
});
const NO_ITEMS: readonly ItemEntry[] = Object.freeze([]);

/**
 * Each list's section names: in the list's own order, then any others in
 * the order they first appear (L-7). Adding an item never moves a section.
 */
const sectionIndex = computed(() => {
  const out = new Map<string, readonly string[]>();
  const lists = new Map<string, ListEntry>();
  for (const l of byKind('list') as ListEntry[]) lists.set(l.id, l);
  for (const [listId, items] of itemIndex.value) {
    const names = new Set<string>(lists.get(listId)?.rec.data.sections ?? []);
    for (const i of items) if (i.rec.data.section) names.add(i.rec.data.section);
    out.set(listId, Object.freeze([...names]));
  }
  for (const [id, l] of lists)
    if (!out.has(id) && l.rec.data.sections?.length)
      out.set(id, Object.freeze(l.rec.data.sections));
  return out;
});

const MAX_SECTIONS = 60;

/** Notes a section in its list's order (at the end) the first time it's used. */
export function keepSection(listId: string, name: string | null | undefined): void {
  if (!name) return;
  const list = findEntry(listId) as ListEntry | undefined;
  if (list?.rec.kind !== 'list') return;
  const known = sectionsOf(listId);
  const saved = list.rec.data.sections ?? [];
  if (saved.includes(name)) return;
  // Sections used before the order was kept join it as they are now. Past
  // 60 the order isn't kept for more (they still show, after the rest).
  const next = [...known.filter((n) => n !== name), name];
  if (next.length > MAX_SECTIONS) return;
  update<'list'>(listId, { sections: next });
}

/** Moves a section up or down. */
export function moveSection(listId: string, name: string, by: -1 | 1): void {
  const names = [...sectionsOf(listId)];
  const at = names.indexOf(name);
  const to = at + by;
  if (at < 0 || to < 0 || to >= names.length) return;
  [names[at], names[to]] = [names[to] as string, names[at] as string];
  update<'list'>(listId, { sections: names.slice(0, MAX_SECTIONS) });
}

/** Renames a section on every item in it. Returns undo. */
export function renameSection(listId: string, from: string, to: string): () => void {
  const name = to.trim().slice(0, 60);
  const list = findEntry(listId) as ListEntry | undefined;
  if (!name || name === from || !list) return () => {};
  const before = [...sectionsOf(listId)];
  const ids = itemsOf(listId)
    .filter((i) => i.rec.data.section === from)
    .map((i) => i.id);
  let undoItems = () => {};
  bulk(() => {
    undoItems = updateItems(ids, () => ({ section: name })).undo;
    const names = before.includes(name)
      ? before.filter((n) => n !== from)
      : before.map((n) => (n === from ? name : n));
    update<'list'>(listId, { sections: names.slice(0, MAX_SECTIONS) });
  });
  return () =>
    bulk(() => {
      undoItems();
      update<'list'>(listId, { sections: before });
    });
}
export function sectionsOf(listId: string): readonly string[] {
  return sectionIndex.value.get(listId) ?? [];
}

/** A list's items in its order. Shared and frozen: copy before sorting. */
export function itemsOf(listId: string): ItemEntry[] {
  return (itemIndex.value.get(listId) ?? NO_ITEMS) as ItemEntry[];
}

/** All items of a list, in every scope (for moves and deletes). */
function allItemsOf(listId: string): Entry[] {
  return store.value.entries.filter((e) => e.rec.kind === 'item' && e.rec.data.list_id === listId);
}

export function createList(
  name: string,
  start: StartingPoint,
  isPrivate: boolean,
  opts: { planId?: string } = {},
): string {
  const id = put(
    'list',
    {
      name,
      kind: kindFor(start.features, start.template),
      private: isPrivate,
      features: [...start.features],
      template: start.template,
      ...(isPrivate ? {} : { checkin: !!start.checkin }),
      ...(opts.planId ? { plan_id: opts.planId } : {}),
    },
    { scope: isPrivate ? 'user' : 'space' },
  );
  if (start.listId) copyItems(start.listId, id, isPrivate ? 'user' : 'space');
  return id;
}

/**
 * Copies a list's items into another, unticked and without anyone's hearts
 * or history; "days before" a plan and sections are kept. Bulk, in order.
 */
function copyItems(fromId: string, toId: string, scope: 'space' | 'user'): void {
  const items = itemsOf(fromId);
  if (!items.length) return;
  const sections = (findEntry(fromId) as ListEntry | undefined)?.rec.data.sections;
  bulk(() => {
    for (const i of items) {
      const { hearts: _h, did: _d, again: _a, last_done: _l, ...rest } = i.rec.data;
      put(
        'item',
        { ...rest, list_id: toId, done: false, ...(scope === 'user' ? { assignee: null } : {}) },
        { scope },
      );
    }
    if (sections?.length) update<'list'>(toId, { sections });
  });
}

/** Switches features on or off. */
export function setFeatures(id: string, features: Feature[]): void {
  const list = findEntry(id) as ListEntry | undefined;
  if (!list) return;
  const ordered = LIST_FEATURES.filter((f) => features.includes(f));
  update<'list'>(id, { features: ordered, kind: kindFor(ordered, list.rec.data.template) });
}

/** Unticks everything that's done, for a list used again (packing, a weekly shop). */
export function startOver(listId: string): () => void {
  const done = itemsOf(listId).filter((i) => i.rec.data.done);
  bulk(() => {
    for (const i of done) update<'item'>(i.id, { done: false });
  });
  return () =>
    bulk(() => {
      for (const i of done) update<'item'>(i.id, { done: true });
    });
}

/**
 * A copy of a list and its items, unticked and without anyone's hearts or
 * history: "(copy)", or for another plan (a checklist from the last trip).
 */
export function copyList(id: string, opts: { planId?: string; name?: string } = {}): string | null {
  const list = findEntry(id) as ListEntry | undefined;
  if (!list) return null;
  // A fresh list: not archived, pinned, placed or hidden like the one copied.
  const {
    plan_id: _plan,
    archived: _ar,
    pinned: _pin,
    sort_key: _key,
    stash: _stash,
    ...data
  } = list.rec.data;
  const newId = put(
    'list',
    {
      ...data,
      name: (opts.name ?? `${data.name} (copy)`).slice(0, 100),
      ...(opts.planId ? { plan_id: opts.planId } : {}),
    },
    { scope: list.scope },
  );
  copyItems(id, newId, list.scope === 'user' ? 'user' : 'space');
  return newId;
}

/** Makes a list a plan's checklist (its "days before" count from that plan), or not. */
export function setListPlan(id: string, planId: string | null): void {
  update<'list'>(id, { plan_id: planId });
}

/** Earlier plans' checklists, newest plan first: to start the next trip's from. */
export function pastChecklists(exceptPlan: string): ListEntry[] {
  return allLists()
    .filter((l) => l.rec.data.plan_id && l.rec.data.plan_id !== exceptPlan && itemsOf(l.id).length)
    .sort((a, b) => {
      const da = (planOf(a)?.rec.data as { start?: string } | undefined)?.start ?? '';
      const db = (planOf(b)?.rec.data as { start?: string } | undefined)?.start ?? '';
      return db.localeCompare(da);
    });
}

/**
 * Saves a list's switches as a starting point for both of you, and, if
 * asked, its items: kept in a hidden list (not in the shared settings, which
 * stay small), under the same key as the list (L-9).
 */
export function saveStartingPoint(list: ListEntry, name: string, withItems = false): void {
  const saved = settings.value.list_templates ?? [];
  const replaced = saved.filter((t) => t.name === name);
  let stash: string | null = null;
  bulk(() => {
    for (const t of replaced) if (t.list_id) deleteList(t.list_id);
    if (withItems && itemsOf(list.id).length) {
      const d = list.rec.data;
      stash = put(
        'list',
        {
          name,
          kind: d.kind,
          private: d.private,
          stash: true,
          ...(d.features ? { features: d.features } : {}),
          ...(d.template ? { template: d.template } : {}),
        },
        { scope: list.scope },
      );
      copyItems(list.id, stash, list.scope === 'user' ? 'user' : 'space');
    }
    const kept = [
      ...saved.filter((t) => t.name !== name),
      {
        id: uuidv7(),
        name,
        features: [...featuresOf(list)],
        private: list.rec.data.private,
        ...(stash ? { list_id: stash } : {}),
      },
    ];
    // Past twelve the oldest goes, with its items.
    for (const t of kept.slice(0, -12)) if (t.list_id) deleteList(t.list_id);
    updateSettings({ list_templates: kept.slice(-12) });
  });
}

export function deleteStartingPoint(id: string): void {
  const t = (settings.value.list_templates ?? []).find((x) => x.id === id);
  bulk(() => {
    if (t?.list_id) deleteList(t.list_id);
    updateSettings({
      list_templates: (settings.value.list_templates ?? []).filter((x) => x.id !== id),
    });
  });
}

/* ---------- hearts and memories ---------- */

export function toggleHeart(item: ItemEntry, slot: Slot): void {
  const hearts = item.rec.data.hearts ?? {};
  update<'item'>(item.id, { hearts: { ...hearts, [slot]: !hearts[slot] } });
}

export const bothWant = (item: ItemEntry) => !!item.rec.data.hearts?.a && !!item.rec.data.hearts?.b;

/** "We did it": a memory with today's date (or another). Returns undo. */
export function didIt(item: ItemEntry, date = today.value): () => void {
  const before = item.rec.data.did ?? [];
  update<'item'>(item.id, { did: [...before, { date }].slice(-100) });
  return () => update<'item'>(item.id, { did: before });
}

/** How one of you found a time you did it. */
export function react(item: ItemEntry, index: number, slot: Slot, r: Reaction | null): void {
  const did = [...(item.rec.data.did ?? [])];
  const entry = did[index];
  if (!entry) return;
  const next = { ...entry };
  if (r) next[slot] = r;
  else delete next[slot];
  did[index] = next;
  update<'item'>(item.id, { did });
}

export const lastDid = (item: ItemEntry) => {
  const did = item.rec.data.did ?? [];
  return did.length ? (did[did.length - 1] ?? null) : null;
};

/**
 * Something to remember in the check-in: a thing you did about a month ago,
 * or else one of your favourites (a different one each week).
 */
export function memoryToRecall(): { item: ItemEntry; date: string | null } | null {
  const t = today.value;
  const from = addDays(t, -38);
  const to = addDays(t, -24);
  const favs: ItemEntry[] = [];
  for (const list of allLists()) {
    if (!has(list, 'did')) continue;
    for (const item of itemsOf(list.id)) {
      for (const m of item.rec.data.did ?? []) {
        if (m.date >= from && m.date <= to) return { item, date: m.date };
      }
      if (item.rec.data.again) favs.push(item);
    }
  }
  if (!favs.length) return null;
  const week = Math.floor(Date.parse(`${t}T00:00:00Z`) / (7 * 86_400_000));
  return { item: favs[week % favs.length] as ItemEntry, date: null };
}

/* ---------- seasons and prices ---------- */

const SEASON_OF_MONTH: Season[] = [
  'winter',
  'winter',
  'spring',
  'spring',
  'spring',
  'summer',
  'summer',
  'summer',
  'autumn',
  'autumn',
  'autumn',
  'winter',
];
/** This season, by month (northern hemisphere). */
export const seasonNow = (): Season =>
  SEASON_OF_MONTH[Number(today.value.slice(5, 7)) - 1] ?? 'winter';
export const SEASON_NAME: Record<Season, string> = {
  spring: 'Spring',
  summer: 'Summer',
  autumn: 'Autumn',
  winter: 'Winter',
};

/** Prices are kept in hundredths; shown in the person's own number format. */
const MONEY = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export const money = (cents: number) => MONEY.format(cents / 100);

/* ---------- plans' checklists ---------- */

/** Lists made as a plan's checklist. */
export function listsForPlan(planId: string): ListEntry[] {
  return allLists().filter((l) => l.rec.data.plan_id === planId);
}

/** The plan a list is a checklist for, if it still exists. */
export function planOf(list: ListEntry): Entry | null {
  const id = list.rec.data.plan_id;
  const e = id ? findEntry(id) : undefined;
  return e?.rec.kind === 'event' ? e : null;
}

/**
 * When an item is due: its own date, or, on a plan's checklist, so many days
 * before the plan (following the plan if it moves).
 */
export function dueOf(item: ItemEntry): string | null {
  const d = item.rec.data;
  if (d.before_days !== undefined && d.before_days !== null) {
    const list = findEntry(d.list_id) as ListEntry | undefined;
    const plan = list ? planOf(list) : null;
    if (plan?.rec.kind === 'event')
      return addDays(plan.rec.data.start.slice(0, 10), -d.before_days);
  }
  return d.due;
}

export function renameList(id: string, name: string): void {
  update<'list'>(id, { name });
}

/**
 * Making a list private (or shared) moves it to another key, so the list and
 * its items are re-created in the new scope. Returns the new list id.
 */
export function setListPrivacy(id: string, isPrivate: boolean): string {
  const list = findEntry(id) as ListEntry | undefined;
  if (!list || list.rec.data.private === isPrivate) return id;
  const items = allItemsOf(id).map((e) => ({
    id: e.id,
    data: e.rec.kind === 'item' ? e.rec.data : null,
  }));
  remove([id, ...items.map((i) => i.id)]);
  const scope = isPrivate ? 'user' : 'space';
  const newId = put('list', { ...list.rec.data, private: isPrivate }, { scope });
  for (const item of items) {
    if (!item.data) continue;
    const made = put(
      'item',
      { ...item.data, list_id: newId, ...(isPrivate ? { assignee: null } : {}) },
      { scope },
    );
    // Plans made from an idea keep pointing at it (L-10).
    relinkPlans(item.id, made);
  }
  return newId;
}

/** Deletes a list and its items. Returns undo. */
export function deleteList(id: string): () => void {
  return remove([id, ...allItemsOf(id).map((e) => e.id)]);
}

/**
 * Whether a list's open items come up in the weekly check-in. Only shared
 * lists can (the check-in is shared). Older lists: the chores kind, or the
 * list the check-in used to point at.
 */
export function inCheckin(list: ListEntry, legacyId?: string | null): boolean {
  if (list.rec.data.private) return false;
  return list.rec.data.checkin ?? (list.rec.data.kind === 'chores' || list.id === legacyId);
}

export function checkinLists(legacyId?: string | null): ListEntry[] {
  return activeLists().filter((l) => inCheckin(l, legacyId));
}

export function setListCheckin(id: string, on: boolean): void {
  update<'list'>(id, { checkin: on });
}

/** The shared list the check-in suggests ideas from: the first one you can pick from. */
export function ideasList(): ListEntry | undefined {
  const pickable = activeLists().filter((l) => has(l, 'plan') && !has(l, 'tick'));
  return pickable.find((l) => !l.rec.data.private) ?? pickable[0];
}

/** Lists whose items are ideas to plan (for free time and the check-in). */
export function ideaLists(): ListEntry[] {
  return activeLists().filter((l) => has(l, 'plan') && !has(l, 'tick'));
}

/**
 * Ticks an item. A repeating task isn't finished: it moves to its next due
 * date, remembers when it was done and, if the two of you take turns, passes
 * to the other person. Returns undo, and the next due date for repeats.
 */
export function completeItem(item: ItemEntry): { undo: () => void; next: string | null } {
  const before = { ...item.rec.data };
  const d = item.rec.data;
  if (!d.repeat) {
    update<'item'>(item.id, { done: true });
    return { undo: () => update<'item'>(item.id, { done: false }), next: null };
  }
  const t = today.value;
  const next = nextDueDate(d.repeat, d.due, t);
  const assignee =
    d.rotate && (d.assignee === 'a' || d.assignee === 'b') ? other(d.assignee) : d.assignee;
  update<'item'>(
    item.id,
    next ? { due: next, last_done: t, assignee, done: false } : { done: true, last_done: t },
  );
  return { undo: () => update<'item'>(item.id, before), next };
}

/** "Due today", "Due Friday", "Overdue · was Mon, Nov 2". */
export function dueText(due: string): { text: string; late: boolean } {
  const t = today.value;
  if (due < t) return { text: `Overdue · was ${relDay(due)}`, late: true };
  return { text: due === t ? 'Due today' : `Due ${relDay(due)}`, late: false };
}

/* ---------- several items at once ---------- */

type ItemData = ItemEntry['rec']['data'];

/**
 * Changes several items at once; `patch` gives each its change, or null to
 * leave it. Returns an undo that puts back what each had, and how many changed.
 */
export function updateItems(
  ids: readonly string[],
  patch: (item: ItemEntry) => Partial<ItemData> | null,
): { undo: () => void; changed: number } {
  const before: [string, Partial<ItemData>][] = [];
  bulk(() => {
    for (const id of ids) {
      const item = findEntry(id);
      if (item?.rec.kind !== 'item') continue;
      const p = patch(item as ItemEntry);
      if (!p) continue;
      const d = item.rec.data as ItemData;
      const old = Object.fromEntries(
        Object.keys(p).map((k) => [k, d[k as keyof ItemData] ?? null]),
      ) as Partial<ItemData>;
      before.push([id, old]);
      update<'item'>(id, p);
    }
  });
  return {
    changed: before.length,
    undo: () =>
      bulk(() => {
        for (const [id, old] of before) update<'item'>(id, old);
      }),
  };
}

/** Ticks several items off, as ticking each would (repeats move on, "did it" is noted). */
export function completeItems(
  ids: readonly string[],
  alsoDid: boolean,
): { undo: () => void; changed: number } {
  const undos: (() => void)[] = [];
  bulk(() => {
    for (const id of ids) {
      const item = findEntry(id);
      if (item?.rec.kind !== 'item' || item.rec.data.done) continue;
      undos.push(completeItem(item as ItemEntry).undo);
      if (alsoDid) undos.push(didIt(item as ItemEntry));
    }
  });
  return {
    changed: alsoDid ? undos.length / 2 : undos.length,
    undo: () =>
      bulk(() => {
        for (const u of undos.reverse()) u();
      }),
  };
}

/* ---------- order ---------- */

/** Past this length a list's keys are renumbered (they grow as items go on top; L-14). */
const LONG_KEY = 24;

/**
 * Spreads a list's keys evenly again, in one batch, keeping its order.
 * Keys come back to two or three characters.
 */
export function renumber(listId: string): void {
  const items = itemsOf(listId);
  const keys = keysBetween(null, null, items.length);
  bulk(() => {
    items.forEach((item, i) => {
      const key = keys[i];
      if (key && key !== item.rec.data.sort_key) update<'item'>(item.id, { sort_key: key });
    });
  });
}

/**
 * A key for a new item at the top of a list. Keys at the top halve each
 * time, so after many adds they would pass the 200-character limit and
 * adding would fail; the list is renumbered first when they get long.
 */
export function topKey(listId: string): string {
  let first = itemsOf(listId)[0]?.rec.data.sort_key ?? null;
  let key = keyBetween(null, first);
  if (key.length > LONG_KEY) {
    renumber(listId);
    first = itemsOf(listId)[0]?.rec.data.sort_key ?? null;
    key = keyBetween(null, first);
  }
  return key;
}

/** A key for a new item at the end of a list. */
export function endKey(listId: string): string {
  const items = itemsOf(listId);
  let last = items[items.length - 1]?.rec.data.sort_key ?? null;
  let key = keyBetween(last, null);
  if (key.length > LONG_KEY) {
    renumber(listId);
    const again = itemsOf(listId);
    last = again[again.length - 1]?.rec.data.sort_key ?? null;
    key = keyBetween(last, null);
  }
  return key;
}

/**
 * Moves an item among `peers` (the items around it as shown: its section's
 * open items, say): one place up or down, or to the top. One write, between
 * its new neighbours; the list is renumbered first if their keys tie.
 */
export function moveItem(
  item: ItemEntry,
  to: 'up' | 'down' | 'top',
  peers: readonly ItemEntry[],
): void {
  const at = peers.findIndex((p) => p.id === item.id);
  const dest = to === 'top' ? 0 : to === 'up' ? at - 1 : at + 1;
  if (at < 0 || dest < 0 || dest >= peers.length || dest === at) return;
  const others = peers.filter((p) => p.id !== item.id);
  const place = () => {
    const fresh = (p: ItemEntry | undefined) =>
      p ? ((findEntry(p.id) as ItemEntry | undefined)?.rec.data.sort_key ?? null) : null;
    return [fresh(others[dest - 1]), fresh(others[dest])] as const;
  };
  let [lo, hi] = place();
  if (lo !== null && hi !== null && lo >= hi) {
    renumber(item.rec.data.list_id);
    [lo, hi] = place();
  }
  update<'item'>(item.id, { sort_key: keyBetween(lo, hi) });
}

/** Points plans made from an idea at its new id (it was re-created). Returns [plan, old id]. */
function relinkPlans(oldId: string, newId: string): [string, string][] {
  const out: [string, string][] = [];
  for (const e of byKind('event'))
    if (e.rec.kind === 'event' && e.rec.data.from_item === oldId) {
      update<'event'>(e.id, { from_item: newId });
      out.push([e.id, oldId]);
    }
  return out;
}

/** Whether moving items between these lists changes who can see them. */
export const movesScope = (from: ListEntry, to: ListEntry) =>
  from.rec.data.private !== to.rec.data.private;

/**
 * Moves items to another list, at its end, keeping their notes, hearts and
 * memories. Between a shared and a private list they are re-created under
 * the other key (as making a list private does), without an assignee when
 * they go private. Returns undo.
 */
export function moveItems(
  ids: readonly string[],
  targetId: string,
): { undo: () => void; moved: number } {
  const target = findEntry(targetId) as ListEntry | undefined;
  if (target?.rec.kind !== 'list') return { undo: () => {}, moved: 0 };
  const items = ids
    .map((id) => findEntry(id))
    .filter((e): e is ItemEntry => e?.rec.kind === 'item' && e.rec.data.list_id !== targetId);
  if (!items.length) return { undo: () => {}, moved: 0 };
  const scope = target.rec.data.private ? 'user' : 'space';
  const last = itemsOf(targetId).at(-1)?.rec.data.sort_key ?? null;
  const keys = keysBetween(last, null, items.length);
  const moved: { id: string; data: ItemData }[] = [];
  const made: string[] = [];
  // Undo puts back the target's section order too, so a private section's
  // name doesn't stay behind on a shared list.
  const hadSections = target.rec.data.sections;
  const relinks: [string, string][] = [];
  let restore = () => {};
  bulk(() => {
    const recreate: ItemEntry[] = [];
    items.forEach((item, i) => {
      const patch = { list_id: targetId, sort_key: keys[i] as string };
      if (item.scope === scope) {
        moved.push({ id: item.id, data: item.rec.data });
        update<'item'>(item.id, patch);
      } else recreate.push(item);
      keepSection(targetId, item.rec.data.section);
    });
    if (recreate.length) {
      restore = remove(recreate.map((r) => r.id));
      recreate.forEach((item) => {
        const i = items.indexOf(item);
        const newId = put(
          'item',
          {
            ...item.rec.data,
            list_id: targetId,
            sort_key: keys[i] as string,
            ...(scope === 'user' ? { assignee: null } : {}),
          },
          { scope },
        );
        made.push(newId);
        relinks.push(...relinkPlans(item.id, newId));
      });
    }
  });
  return {
    moved: items.length,
    undo: () =>
      bulk(() => {
        for (const m of moved)
          update<'item'>(m.id, { list_id: m.data.list_id, sort_key: m.data.sort_key });
        if (made.length) {
          remove(made);
          restore();
          for (const [plan, oldId] of relinks) update<'event'>(plan, { from_item: oldId });
        }
        const now = (findEntry(targetId) as ListEntry | undefined)?.rec.data.sections;
        if (JSON.stringify(now) !== JSON.stringify(hadSections))
          update<'list'>(targetId, { sections: hadSections ?? [] });
      }),
  };
}

export type ListOrder = 'own' | 'due' | 'who' | 'az' | 'recent';

/** How a list's items are ordered: as chosen, else by due date when it has dates (L-4). */
export function orderOf(list: ListEntry): ListOrder {
  const o = list.rec.data.order;
  const f = featuresOf(list);
  if (o === 'due' && !f.has('due')) return 'own';
  if (o === 'who' && !f.has('who')) return 'own';
  return o ?? (f.has('due') && f.has('tick') ? 'due' : 'own');
}

/** The items an item moves among: open or done like it, and in its section. */
export function peersOf(item: ItemEntry, list: ListEntry): ItemEntry[] {
  const d = item.rec.data;
  const bySection = featuresOf(list).has('sections');
  return itemsOf(list.id).filter(
    (i) =>
      i.rec.data.done === d.done &&
      (!bySection || (i.rec.data.section || null) === (d.section || null)),
  );
}

/* ---------- reading what's typed into a list (review 0008, L-8) ---------- */

const QTY_LEAD = /^(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:x|×)\s+(?=\S)/i;
const QTY_TRAIL = /\s+(?:x|×)\s*(\d{1,4})$|\s+(\d{1,4})\s*(?:x|×)$/i;
const QTY_UNIT =
  /\s+(\d{1,4}(?:[.,]\d{1,2})?\s?(?:g|kg|ml|l|lb|lbs|oz|pack|packs|tins?|cans?|bottles?|loaf|loaves))$/i;

/**
 * "2 x milk", "milk x2", "flour 500 g" → how many; "@Alex", "@me" → who's on
 * it. Only for lists with those features; the rest stays the item's name.
 */
export function readItemText(
  input: string,
  opts: { qty: boolean; who: boolean; me: Slot; names: Record<Slot, string> },
): { text: string; qty: string | null; assignee: Slot | null } {
  let text = input.trim();
  let qty: string | null = null;
  let assignee: Slot | null = null;
  if (opts.who) {
    const m = /(?:^|\s)@(\S+)/.exec(text);
    if (m) {
      const tag = (m[1] ?? '').toLowerCase();
      const partner = other(opts.me);
      const who =
        tag === 'me' || tag === opts.names[opts.me].toLowerCase()
          ? opts.me
          : tag === opts.names[partner].toLowerCase()
            ? partner
            : null;
      if (who) {
        assignee = who;
        text = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
      }
    }
  }
  if (opts.qty) {
    const lead = QTY_LEAD.exec(text);
    const trail = lead ? null : QTY_TRAIL.exec(text);
    const unit = lead || trail ? null : QTY_UNIT.exec(text);
    if (lead) {
      qty = lead[1] ?? null;
      text = text.slice(lead[0].length);
    } else if (trail) {
      qty = trail[1] ?? trail[2] ?? null;
      text = text.slice(0, trail.index);
    } else if (unit) {
      qty = unit[1] ?? null;
      text = text.slice(0, unit.index);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text ? { text, qty, assignee } : { text: input.trim(), qty: null, assignee: null };
}

/** The list's items whose names start with (then contain) what's typed, done ones too. */
export function suggestItems(listId: string, typed: string, max = 5): ItemEntry[] {
  const q = typed.trim().toLowerCase();
  if (q.length < 2) return [];
  const starts: ItemEntry[] = [];
  const has: ItemEntry[] = [];
  const seen = new Set<string>();
  for (const i of itemsOf(listId)) {
    const name = i.rec.data.text.toLowerCase();
    if (seen.has(name)) continue;
    if (name.startsWith(q)) starts.push(i);
    else if (name.includes(q)) has.push(i);
    else continue;
    seen.add(name);
  }
  // Done ones first: bringing one back is what typing ahead is for.
  const rank = (a: ItemEntry, b: ItemEntry) => Number(b.rec.data.done) - Number(a.rec.data.done);
  return [...starts.sort(rank), ...has.sort(rank)].slice(0, max);
}

/** The item with exactly this name on the list (any case), open ones first. */
export function sameItem(listId: string, text: string): ItemEntry | undefined {
  const t = text.trim().toLowerCase();
  const found = itemsOf(listId).filter((i) => i.rec.data.text.trim().toLowerCase() === t);
  return found.find((i) => !i.rec.data.done) ?? found[0];
}

/* ---------- ideas planned (review 0008, L-10) ---------- */

/** Plans made from each idea, by the idea's id. */
const plansByIdea = computed(() => {
  const out = new Map<string, Entry[]>();
  for (const e of byKind('event')) {
    if (e.rec.kind !== 'event' || e.rec.data.status === 'declined') continue;
    const from = e.rec.data.from_item;
    if (!from) continue;
    const got = out.get(from);
    if (got) got.push(e);
    else out.set(from, [e]);
  }
  return out;
});

/** The plan an idea was planned as: the next one still ahead, else the latest past one. */
export function planForIdea(itemId: string): { id: string; date: string; past: boolean } | null {
  const plans = plansByIdea.value.get(itemId);
  if (!plans?.length) return null;
  const t = today.value;
  const dated = plans
    .map((e) => ({ id: e.id, date: e.rec.kind === 'event' ? e.rec.data.start.slice(0, 10) : '' }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const ahead = dated.find((p) => p.date >= t);
  const pick = ahead ?? dated[dated.length - 1];
  return pick ? { ...pick, past: !ahead } : null;
}

/**
 * Ideas planned that have now happened and aren't marked done since: the
 * check-in and Waiting on you ask "How was it?" (closing the loop).
 */
export const ideasToRecall = computed(() => {
  const out: { item: ItemEntry; planId: string; date: string }[] = [];
  for (const [itemId] of plansByIdea.value) {
    const item = findEntry(itemId) as ItemEntry | undefined;
    if (item?.rec.kind !== 'item') continue;
    const plan = planForIdea(itemId);
    if (!plan?.past) continue;
    if ((item.rec.data.did ?? []).some((x) => x.date >= plan.date)) continue;
    out.push({ item, planId: plan.id, date: plan.date });
  }
  return out;
});
