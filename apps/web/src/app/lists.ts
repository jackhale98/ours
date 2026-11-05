// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lists: what each can do (features, switched on in its settings), the
 * starting points that switch on a set of them, and list operations.
 */
import {
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
    blurb: t.features.map((f) => FEATURES[f].label).join(', '),
    example: t.name,
    features: t.features,
    private: t.private,
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

export function allLists(): ListEntry[] {
  return byKind('list') as ListEntry[];
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

/** Each list's section names, in the order they first appear (once per change). */
const sectionIndex = computed(() => {
  const out = new Map<string, readonly string[]>();
  for (const [listId, items] of itemIndex.value) {
    const names = new Set<string>();
    for (const i of items) if (i.rec.data.section) names.add(i.rec.data.section);
    out.set(listId, Object.freeze([...names]));
  }
  return out;
});
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
  return put(
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

/** A copy of a list and its items, unticked and without anyone's hearts or history. */
export function copyList(id: string): string | null {
  const list = findEntry(id) as ListEntry | undefined;
  if (!list) return null;
  const { plan_id: _plan, ...data } = list.rec.data;
  const newId = put(
    'list',
    { ...data, name: `${data.name} (copy)`.slice(0, 100) },
    {
      scope: list.scope,
    },
  );
  bulk(() => {
    for (const i of itemsOf(id)) {
      const { hearts: _h, did: _d, again: _a, last_done: _l, ...rest } = i.rec.data;
      put('item', { ...rest, list_id: newId, done: false }, { scope: list.scope });
    }
  });
  return newId;
}

/** Saves a list's switches as a starting point for both of you. */
export function saveStartingPoint(list: ListEntry, name: string): void {
  const saved = settings.value.list_templates ?? [];
  updateSettings({
    list_templates: [
      ...saved.filter((t) => t.name !== name),
      {
        id: uuidv7(),
        name,
        features: [...featuresOf(list)],
        private: list.rec.data.private,
      },
    ].slice(-12),
  });
}

export function deleteStartingPoint(id: string): void {
  updateSettings({
    list_templates: (settings.value.list_templates ?? []).filter((t) => t.id !== id),
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
  const items = allItemsOf(id).map((e) => (e.rec.kind === 'item' ? e.rec.data : null));
  remove([id, ...allItemsOf(id).map((e) => e.id)]);
  const scope = isPrivate ? 'user' : 'space';
  const newId = put('list', { ...list.rec.data, private: isPrivate }, { scope });
  for (const item of items) {
    if (item)
      put('item', { ...item, list_id: newId, ...(isPrivate ? { assignee: null } : {}) }, { scope });
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
  return allLists().filter((l) => inCheckin(l, legacyId));
}

export function setListCheckin(id: string, on: boolean): void {
  update<'list'>(id, { checkin: on });
}

/** The shared list the check-in suggests ideas from: the first one you can pick from. */
export function ideasList(): ListEntry | undefined {
  const pickable = allLists().filter((l) => has(l, 'plan') && !has(l, 'tick'));
  return pickable.find((l) => !l.rec.data.private) ?? pickable[0];
}

/** Lists whose items are ideas to plan (for free time and the check-in). */
export function ideaLists(): ListEntry[] {
  return allLists().filter((l) => has(l, 'plan') && !has(l, 'tick'));
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
