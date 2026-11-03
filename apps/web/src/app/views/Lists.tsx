// SPDX-License-Identifier: AGPL-3.0-or-later
import { keyBetween } from '@ours/core/schema';
import { signal } from '@preact/signals';
import { useRef, useState } from 'preact/hooks';
import {
  byKind,
  type Entry,
  nameOf,
  partner,
  put,
  remove,
  type Slot,
  update,
  viewer,
} from '../model';
import { nextFreeEvening, relDay } from '../select';
import { openQuick } from '../sheets';
import { colorVar, Icon, toast } from '../ui';

const currentList = signal<string | null>(null);
const showDone = signal(false);
const picked = signal<string | null>(null);

type ItemEntry = Entry & { rec: { kind: 'item' } };
type ListEntry = Entry & { rec: { kind: 'list' } };

function itemsOf(listId: string): ItemEntry[] {
  return (byKind('item') as ItemEntry[])
    .filter((i) => i.rec.data.list_id === listId)
    .sort((a, b) => (a.rec.data.sort_key < b.rec.data.sort_key ? -1 : 1));
}

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
      <span style={who && who !== 'both' ? { '--c': colorVar(who) } : undefined}>
        {who && who !== 'both' ? nameOf(who).charAt(0) : '+'}
      </span>
    </button>
  );
}

export function ItemRow({ item, assignable }: { item: ItemEntry; assignable: boolean }) {
  const [done, setDone] = useState(item.rec.data.done);
  return (
    <li class={`it${done ? ' done' : ''}`}>
      <label class="chk">
        <input
          type="checkbox"
          checked={done}
          onChange={(e) => {
            const v = e.currentTarget.checked;
            setDone(v);
            // Let the tick register visually before the item moves.
            setTimeout(() => update<'item'>(item.id, { done: v }), 420);
          }}
        />
        <span class="box">
          <Icon name="check" size={15} />
        </span>
        <span class="it-t">
          {item.rec.data.text}
          {item.rec.data.due && <span class="it-sub">Due {relDay(item.rec.data.due)}</span>}
        </span>
      </label>
      {assignable && <AssignButton item={item} />}
    </li>
  );
}

function AddItem({ list, placeholder }: { list: ListEntry; placeholder: string }) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const submit = (e: Event) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    const first = itemsOf(list.id)[0];
    put(
      'item',
      {
        list_id: list.id,
        text: v,
        done: false,
        assignee: null,
        due: null,
        sort_key: keyBetween(null, first?.rec.data.sort_key ?? null),
      },
      { scope: list.scope, owner: list.owner },
    );
    setText('');
    input.current?.focus();
  };
  return (
    <form class="additem" onSubmit={submit}>
      <input
        ref={input}
        class="txt"
        type="text"
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        placeholder={placeholder}
        autocomplete="off"
        aria-label={placeholder}
      />
      <button class="btn primary" type="submit">
        <Icon name="plus" size={16} />
        Add
      </button>
    </form>
  );
}

function CheckList({ list }: { list: ListEntry }) {
  const items = itemsOf(list.id);
  const open = items.filter((i) => !i.rec.data.done);
  const done = items.filter((i) => i.rec.data.done);
  const priv = list.rec.data.private;
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
      <AddItem list={list} placeholder={`Add to ${list.rec.data.name}`} />
      <ul class="items">
        {open.map((i) => (
          <ItemRow key={i.id} item={i} assignable={!priv} />
        ))}
      </ul>
      {!open.length && <p class="nothing">All done.</p>}
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
              onClick={() => toast('Cleared done items.', remove(done.map((i) => i.id)))}
            >
              Clear done
            </button>
          </div>
          {showDone.value && (
            <ul class="items">
              {done.map((i) => (
                <ItemRow key={i.id} item={i} assignable={!priv} />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

export function planIdea(text: string) {
  openQuick({ text, date: nextFreeEvening(), time: '19:00', who: 'ours' });
}

function IdeasList({ list }: { list: ListEntry }) {
  const items = itemsOf(list.id);
  const pick = items.find((i) => i.id === picked.value);
  const shuffle = () => {
    if (!items.length) return;
    let n: ItemEntry | undefined;
    do n = items[Math.floor(Math.random() * items.length)];
    while (items.length > 1 && n?.id === picked.value);
    picked.value = n?.id ?? null;
  };
  return (
    <>
      {pick ? (
        <section class="picked" aria-live="polite" aria-labelledby="pick-title">
          <p class="eyebrow">Your pick</p>
          <h2 class="h3" id="pick-title">
            {pick.rec.data.text}
          </h2>
          <p class="sub">Next evening you’re both free: {relDay(nextFreeEvening())}</p>
          <div class="pickrow">
            <button
              type="button"
              class="btn primary sm"
              onClick={() => planIdea(pick.rec.data.text)}
            >
              Ask {nameOf(partner.value)}
            </button>
            <button type="button" class="btn sm" onClick={shuffle}>
              <Icon name="shuffle" size={15} />
              Another
            </button>
          </div>
        </section>
      ) : (
        <div class="pickrow">
          <button type="button" class="btn primary" onClick={shuffle} disabled={!items.length}>
            <Icon name="shuffle" size={16} />
            Pick one for us
          </button>
        </div>
      )}
      <AddItem list={list} placeholder="Add a date idea" />
      <ul class="items">
        {items.map((i) => (
          <li class="it" key={i.id}>
            <span class="it-t grow">{i.rec.data.text}</span>
            <button
              type="button"
              class="btn sm"
              aria-label={`Plan it: ${i.rec.data.text}`}
              onClick={() => planIdea(i.rec.data.text)}
            >
              Plan it
            </button>
            <button
              type="button"
              class="iconbtn"
              aria-label={`Remove ${i.rec.data.text}`}
              onClick={() => {
                if (picked.value === i.id) picked.value = null;
                toast(`Removed “${i.rec.data.text}”.`, remove([i.id]));
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ListsView() {
  const lists = byKind('list') as ListEntry[];
  const cur = lists.find((l) => l.id === currentList.value) ?? lists[0];
  if (!cur) {
    return (
      <header class="vhead">
        <h1>Lists</h1>
      </header>
    );
  }
  return (
    <>
      <header class="vhead">
        <div>
          <p class="eyebrow">
            {cur.rec.data.private ? 'Just for you' : `Shared with ${nameOf(partner.value)}`}
          </p>
          <h1>Lists</h1>
        </div>
      </header>
      {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
      <div class="ltabs" role="group" aria-label="Lists">
        {lists.map((l) => {
          const items = itemsOf(l.id);
          const n =
            l.rec.data.kind === 'ideas'
              ? items.length
              : items.filter((i) => !i.rec.data.done).length;
          return (
            <button
              type="button"
              class="ltab"
              key={l.id}
              aria-pressed={l.id === cur.id}
              onClick={() => {
                currentList.value = l.id;
                picked.value = null;
              }}
            >
              {l.rec.data.private && <Icon name="lock" size={14} />}
              {l.rec.data.private && <span class="sr">Private: </span>}
              {l.rec.data.name}
              <span class="n">
                {n}
                <span class="sr"> {l.rec.data.kind === 'ideas' ? 'ideas' : 'open'}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div class="listcard">
        {cur.rec.data.kind === 'ideas' ? (
          <IdeasList key={cur.id} list={cur} />
        ) : (
          <CheckList key={cur.id} list={cur} />
        )}
      </div>
    </>
  );
}
