// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Search plans, lists, notes and imported calendars, on this device. Results
 * open in place (a plan's sheet, an item's details), so the search stays put
 * for the next look.
 */
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { itemSheet } from '../itemsheet';
import { currentList, dueText } from '../lists';
import { nameOf, partner } from '../model';
import { type Hit, search } from '../search';
import { agendaFrom, fmtLong, fmtTime, relDay, today, zone } from '../select';
import { openEvent, openImport } from '../sheets';
import { Icon } from '../ui';

/** Kept while switching tabs, so coming back shows the same results. */
export const query = signal('');

const GROUPS: [Hit['kind'], string][] = [
  ['plan', 'Plans'],
  ['list', 'Lists'],
  ['item', 'On your lists'],
  ['note', 'Notes on plans'],
  ['import', 'From your other calendars'],
];

function when(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-CA', { timeZone: zone });
  const time = d.toLocaleTimeString('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
  });
  const day =
    Math.abs(Date.parse(date) - Date.parse(today.value)) < 7 * 86_400_000
      ? relDay(date)
      : fmtLong(date);
  return time === '00:00' ? day : `${day}, ${fmtTime(time)}`;
}

function Result({ hit }: { hit: Hit }) {
  switch (hit.kind) {
    case 'plan':
      return (
        <button type="button" class="find-row" onClick={() => openEvent(hit.id, hit.occ)}>
          <Icon name="cal" size={16} />
          <span>
            <b>{hit.title}</b>
            <span class="small muted">
              {hit.when === null
                ? 'No date'
                : `${hit.upcoming ? (hit.repeats ? 'Next: ' : '') : 'Last: '}${when(hit.when)}`}
              {hit.where ? ` · ${hit.where}` : ''}
            </span>
          </span>
        </button>
      );
    case 'note':
      return (
        <button type="button" class="find-row" onClick={() => openEvent(hit.planId)}>
          <Icon name="chat" size={16} />
          <span>
            <b>{hit.text}</b>
            <span class="small muted">On “{hit.planTitle}”</span>
          </span>
        </button>
      );
    case 'item': {
      const d = hit.item.rec.data;
      return (
        <button
          type="button"
          class="find-row"
          onClick={() => {
            itemSheet.value = hit.id;
          }}
        >
          <Icon name={d.done ? 'check' : 'list'} size={16} />
          <span>
            <b class={d.done ? 'done' : undefined}>{d.text}</b>
            <span class="small muted">
              {hit.list.rec.data.name}
              {d.done ? ' · done' : d.due ? ` · ${dueText(d.due).text}` : ''}
            </span>
          </span>
        </button>
      );
    }
    case 'list':
      return (
        <a
          class="find-row"
          href="#lists"
          onClick={() => {
            currentList.value = hit.id;
          }}
        >
          <Icon name="list" size={16} />
          <span>
            <b>{hit.list.rec.data.name}</b>
            <span class="small muted">
              {hit.list.rec.data.private ? 'Just for you' : `Shared with ${nameOf(partner.value)}`}
            </span>
          </span>
        </a>
      );
    case 'import':
      return (
        <button
          type="button"
          class="find-row"
          onClick={() => {
            const row = agendaFrom(hit.date, 1)[0]?.rows.find((r) => r.key === hit.key);
            if (row) openImport(row, hit.date);
          }}
        >
          <Icon name="cal" size={16} />
          <span>
            <b>{hit.title}</b>
            <span class="small muted">
              {when(hit.when)}
              {hit.source ? ` · ${hit.source}` : ''}
            </span>
          </span>
        </button>
      );
  }
}

export function SearchView() {
  const q = query.value;
  const hits = search(q);
  const n = hits.length;
  const box = useRef<HTMLInputElement>(null);
  // Opening search means typing next.
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <>
      <header class="vhead">
        <div>
          <p class="eyebrow">On this device only</p>
          <h1>Search</h1>
        </div>
      </header>
      <form role="search" class="find-form" onSubmit={(e) => e.preventDefault()}>
        <label class="sr" for="find-q">
          Search plans, lists and notes
        </label>
        <Icon name="search" size={18} />
        <input
          id="find-q"
          class="txt"
          type="search"
          value={q}
          ref={box}
          autocomplete="off"
          enterKeyHint="search"
          placeholder="Plans, places, lists, notes…"
          onInput={(e) => {
            query.value = e.currentTarget.value;
          }}
        />
      </form>
      <p class="sr" aria-live="polite">
        {q.trim() ? (n ? `${n} ${n === 1 ? 'result' : 'results'}` : 'No results') : ''}
      </p>
      {!q.trim() ? (
        <p class="lede small">
          Your plans and lists are encrypted, so search runs here on your device. What you type
          isn’t sent anywhere.
        </p>
      ) : n === 0 ? (
        <p class="nothing">Nothing matches “{q.trim()}”.</p>
      ) : (
        GROUPS.map(([kind, label]) => {
          const group = hits.filter((h) => h.kind === kind);
          if (!group.length) return null;
          return (
            <section class="find-group" key={kind} aria-labelledby={`find-${kind}`}>
              <h2 class="sublbl" id={`find-${kind}`}>
                {label}
              </h2>
              <ul>
                {group.map((h) => (
                  <li key={h.id}>
                    <Result hit={h} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </>
  );
}
