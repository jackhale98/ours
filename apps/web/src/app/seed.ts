// SPDX-License-Identifier: AGPL-3.0-or-later
/** Demo sample data, relative to today (after docs/prototype.html). */
import { generateKey, toBase64Url } from '@ours/core/crypto';
import { type ItemData, keyBetween, keysBetween, type ListData } from '@ours/core/schema';
import { addDays, addWallMinutes, startOfWeek } from '@ours/core/time';
import { STARTING_POINTS } from './lists';
import {
  addComment,
  bulk,
  createEvent,
  type EventData,
  put,
  replaceAll,
  type Slot,
  setViewer,
  store,
  update,
} from './model';
import { seenAt } from './news';
import { dow, today, zone } from './select';

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
/** Today's weekday and the one three days on, in week order (e.g. "MO,TH"). */
export function waterDays(today: string): string {
  const w = new Date(`${today}T12:00:00`).getDay();
  const days = [w, (w + 3) % 7].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
  return days.map((d) => WEEKDAYS[d]).join(',');
}

export function seedDemo(): void {
  bulk(seedAll);
}

function seedAll(): void {
  replaceAll({ v: 2, viewer: 'a', space_key: toBase64Url(generateKey()), entries: [] });
  const t = today.value;
  const d = (n: number) => addDays(t, n);
  let lisbon = '';
  // A few of Alex's changes count as new, so the demo shows "New from Alex" (review 0009, P-15).
  const fromAlex: string[] = [];
  const as = (slot: Slot, fn: () => void) => {
    setViewer(slot);
    fn();
  };

  put('settings', {
    week_start: 1,
    members: {
      a: { name: 'Sam', color: '#2b6e8c', user_id: 'demo-a' },
      b: { name: 'Alex', color: '#b3486a', user_id: 'demo-b' },
    },
  });

  const ev = (
    title: string,
    day: number,
    time: string | null,
    owner: Slot | 'both',
    extra: Partial<EventData> & { mins?: number } = {},
  ): EventData => {
    const { mins = 60, ...rest } = extra;
    const date = d(day);
    const start = time ? `${date}T${time}` : date;
    const end = time ? addWallMinutes(start, mins) : addDays(date, 1);
    return {
      title,
      start,
      end,
      all_day: !time,
      tz: time ? zone : null,
      rrule: null,
      away: false,
      owner,
      status: 'confirmed',
      proposed_by: null,
      privacy: 'full',
      location: null,
      notes: null,
      countdown: false,
      stub_id: null,
      ...rest,
    };
  };

  as('a', () => {
    createEvent(ev('Dentist', 0, '16:30', 'a', { location: 'Dr. Okafor' }));
    createEvent(ev('Book club', 1, '19:00', 'a', { location: 'Lena’s place', mins: 120 }));
    createEvent(
      ev('Trash & recycling out', 1, '21:00', 'both', { rrule: 'FREQ=WEEKLY', mins: 15 }),
    );
    createEvent(
      ev('Pick up Alex’s birthday gift', 3, '18:00', 'a', {
        privacy: 'busy',
        location: 'Greenpoint',
      }),
    );
    const dinner = createEvent(
      ev('Dinner with Jordan & Priya', 4, '19:30', 'both', { location: 'Vic’s', mins: 150 }),
    );
    as('b', () => addComment(dinner, 'I can drive if you grab the wine.'));
    as('a', () => addComment(dinner, 'Deal. Getting the orange one they liked.'));
    const sat = (6 - dow(t) + 7) % 7;
    createEvent(
      ev('Farmers market', sat, '09:30', 'both', {
        location: 'Grand Army Plaza',
        rrule: 'FREQ=WEEKLY;BYDAY=SA',
        mins: 90,
      }),
    );
    createEvent(ev('Call Mom', 6, '11:00', 'a', { mins: 30 }));
    createEvent(
      ev('Hike at Breakneck Ridge', 8, '08:00', 'both', {
        status: 'proposed',
        proposed_by: 'a',
        mins: 360,
      }),
    );
    createEvent(ev('Movie night', 11, '20:00', 'both', { mins: 150 }));
    lisbon = createEvent(ev('Lisbon trip', 23, null, 'both', { countdown: true, away: true }));
    createEvent(ev('Our anniversary', 41, null, 'both', { countdown: true }));
    createEvent(ev('Maya’s wedding', 58, null, 'both', { countdown: true, away: true }));
  });

  as('b', () => {
    createEvent(ev('Late shift', 0, '15:00', 'b', { mins: 480 }));
    createEvent(ev('Yoga', 2, '07:30', 'b'));
    fromAlex.push(
      createEvent(ev('Climbing', 3, '19:00', 'b', { location: 'Brooklyn Boulders', mins: 120 })),
    );
    createEvent(ev('Therapy', 2, '12:00', 'b', { privacy: 'busy' }));
    const parents = createEvent(
      ev('Dinner at my parents’', 5, '18:00', 'both', {
        status: 'proposed',
        proposed_by: 'b',
        mins: 180,
      }),
    );
    addComment(parents, 'Mom is making the lasagna. Can we do it?');
    const trip = { ...ev('Work trip · Chicago', 9, null, 'b', { away: true }), end: d(11) };
    fromAlex.push(createEvent(trip));
  });

  setViewer('a');
  type Seed = [string, Slot | null, boolean?, Partial<ItemData>?];
  const list = (
    name: string,
    start: string,
    items: Seed[],
    owner?: Slot,
    extra: Partial<ListData> = {},
  ) => {
    const sp = STARTING_POINTS.find((x) => x.id === start) as (typeof STARTING_POINTS)[number];
    const scope = owner ? 'user' : 'space';
    const kind =
      sp.template === 'gifts' ? 'gifts' : sp.features.includes('tick') ? 'todo' : 'ideas';
    const id = put(
      'list',
      { name, kind, private: !!owner, features: [...sp.features], template: sp.template, ...extra },
      { scope, owner: owner ?? null },
    );
    let key: string | null = null;
    for (const [text, assignee, done, more] of items) {
      key = keyBetween(key, null);
      put(
        'item',
        { list_id: id, text, done: !!done, assignee, due: null, sort_key: key, ...more },
        { scope, owner: owner ?? null },
      );
    }
    return id;
  };
  list('Groceries', 'groceries', [
    ['Oat milk', null, false, { qty: '2', section: 'Dairy' }],
    ['Eggs', null, false, { qty: 'a dozen', section: 'Dairy' }],
    ['Lemons', 'b', false, { qty: '4', section: 'Produce' }],
    ['Bay leaves', null, false, { section: 'Produce' }],
    ['Coffee beans', 'a', false, { note: 'The Ethiopian one, not the dark roast' }],
    ['Sourdough', null, true, { section: 'Bakery' }],
  ]);
  const home = list('Home', 'chores', [
    ['Book furnace service', 'a'],
    ['Return library books', 'b'],
    ['Fix the bathroom drawer', null],
    ['Renew car registration', 'a'],
    ['Pay electric bill', 'b', true],
  ]);
  // Repeating tasks: the bins every Monday, taking turns; the plants twice a week.
  // The next such weekday after today (a week on if it's today), so the demo
  // reads the same whatever day it's opened.
  const nextDay = (dow: number) => d((dow - new Date(`${t}T00:00:00Z`).getUTCDay() + 7) % 7 || 7);
  put(
    'item',
    {
      list_id: home,
      text: 'Take out the bins',
      done: false,
      assignee: 'a',
      due: nextDay(1),
      sort_key: '01',
      repeat: 'FREQ=WEEKLY;BYDAY=MO',
      rotate: true,
      // A time and a reminder, for whoever's turn it is.
      time: '19:00',
      reminders: [60],
    },
    { scope: 'space' },
  );
  put(
    'item',
    {
      list_id: home,
      text: 'Water the plants',
      done: false,
      assignee: null,
      // Due today whatever the weekday, so the demo always has something
      // waiting on you. Twice a week: today's weekday and three days on, so
      // the next one is never tomorrow (which would still be waiting).
      due: t,
      sort_key: '02',
      repeat: `FREQ=WEEKLY;BYDAY=${waterDays(t)}`,
    },
    { scope: 'space' },
  );
  list(
    'Gift ideas',
    'gifts',
    [
      ['Alex: chalk bag for climbing', null, false, { price: 2800 }],
      ['Alex: the ramen cookbook', null, false, { price: 3200 }],
      ['Mom: wool scarf, green', null, false, { price: 4500, note: 'Not too scratchy' }],
    ],
    'a',
  );
  list('Date ideas', 'dates', [
    ['Pottery class', null, false, { length: 'short', hearts: { a: true, b: true } }],
    ['Night walk and dumplings', null, false, { length: 'evening', hearts: { b: true } }],
    [
      'Board game café',
      null,
      false,
      { did: [{ date: d(-31), a: 'loved', b: 'good' }], again: true, hearts: { a: true } },
    ],
    ['Try the new Georgian place', null, false, { when: 'soon', hearts: { a: true, b: true } }],
    ['Sunrise at the pier', null, false, { season: ['summer'] }],
    ['Cook a three-course dinner', null, false, { length: 'evening' }],
    ['Day trip to the coast', null, false, { length: 'day', when: 'someday' }],
  ]);
  // A packing list for the Lisbon trip, due in the days before it.
  list(
    'For Lisbon',
    'packing',
    [
      ['Passports', null, false, { section: 'Documents', before_days: 1 }],
      ['Book the airport train', 'a', false, { section: 'Before we go', before_days: 7 }],
      ['Sunscreen', null, false, { section: 'Bags', qty: '2' }],
      ['Walking shoes', null, false, { section: 'Bags' }],
    ],
    undefined,
    { plan_id: lisbon },
  );

  // The weekly check-in shares out what's open on the Home list.
  update<'list'>(home, { checkin: true });
  setViewer('b');
  put('checkin', {
    // Most recent Sunday before today.
    date: startOfWeek(t, 0) === t ? addDays(t, -7) : startOfWeek(t, 0),
    author: 'b',
    steps_done: ['week', 'chores', 'time', 'note'],
    note: 'Can we keep Sunday morning slow this week? I’ve been running on empty.',
  });
  setViewer('a');

  // The lists in the order they were made, the same on every load.
  const made = store.value.entries.filter((e) => e.rec.kind === 'list');
  const keys = keysBetween(null, null, made.length);
  made.forEach((l, i) => {
    update<'list'>(l.id, { sort_key: keys[i] as string });
  });

  const drive = store.value.entries.find(
    (e) => e.rec.kind === 'comment' && e.rec.data.text.startsWith('I can drive'),
  );
  if (drive) fromAlex.push(drive.id);
  const marked = new Set(fromAlex);
  store.value = {
    ...store.value,
    entries: store.value.entries.map((e) => (marked.has(e.id) ? { ...e, by: 'b' } : e)),
  };
  const first = Math.min(
    ...store.value.entries.filter((e) => marked.has(e.id)).map((e) => e.rec.updated_at),
  );
  if (seenAt.value >= first) seenAt.value = first - 1;
}
