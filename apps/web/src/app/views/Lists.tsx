// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseQuickAdd } from '@ours/core/parse';
import type { ListKind } from '@ours/core/schema';
import { keyBetween } from '@ours/core/schema';
import { signal } from '@preact/signals';
import { useRef, useState } from 'preact/hooks';
import { LENGTH_LABEL } from '../freetime';
import { itemSheet } from '../itemsheet';
import {
  allLists,
  completeItem,
  createList,
  currentList,
  deleteList,
  dueText,
  type ItemEntry,
  inCheckin,
  itemsOf,
  LIST_TYPES,
  type ListEntry,
  type PickerKind,
  pickerKind,
  renameList,
  setListCheckin,
  setListKind,
  setListPrivacy,
  typeOf,
} from '../lists';
import { nameOf, partner, put, remove, type Slot, settings, update, viewer } from '../model';
import { nextFreeEvening, relDay, repeatText, today } from '../select';
import { openQuick } from '../sheets';
import { CloseButton, colorVar, Icon, Sheet, Switch, toast } from '../ui';

const showDone = signal(false);
const picked = signal<string | null>(null);
const listSheet = signal<{ type: 'new' } | { type: 'edit'; id: string } | null>(null);

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

/** When an item is due, in words ("Overdue · was Mon", "Due today", "Due Fri"). */
export function ItemRow({ item, assignable }: { item: ItemEntry; assignable: boolean }) {
  const d = item.rec.data;
  const [done, setDone] = useState(d.done);
  const due = d.due ? dueText(d.due) : null;
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
            setTimeout(() => {
              if (!v) {
                update<'item'>(item.id, { done: false });
                return;
              }
              const { undo, next } = completeItem(item);
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
        <span class="it-t">
          {d.text}
          {(due || d.repeat) && (
            <span class={`it-sub${due?.late ? ' late' : ''}`}>
              {due?.text}
              {due && d.repeat ? ' · ' : ''}
              {d.repeat && (
                <>
                  <Icon name="repeat" size={12} />
                  {repeatText(d.repeat)}
                  {d.rotate ? ', taking turns' : ''}
                </>
              )}
            </span>
          )}
        </span>
      </label>
      {assignable && <AssignButton item={item} />}
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
    // "Take out the bins every monday", "Renew passport by mar 1": a due date
    // and repeat come from the words (only date and repeat phrases are taken out).
    const parsed = parseQuickAdd(v, { today: today.value });
    const taken = parsed.tokens.filter((t) => t.type === 'date' || t.type === 'repeat');
    let name = v;
    for (const t of [...taken].sort((a, b) => b.start - a.start)) {
      name = name.slice(0, t.start) + name.slice(t.end);
    }
    name =
      name
        .replace(/\s+(by|on|due)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim() || v;
    const repeat = parsed.rrule;
    put(
      'item',
      {
        list_id: list.id,
        text: taken.length ? name : v,
        done: false,
        assignee: null,
        due: parsed.date ?? (repeat ? today.value : null),
        sort_key: keyBetween(null, first?.rec.data.sort_key ?? null),
        ...(repeat ? { repeat } : {}),
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
        maxLength={500}
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

const placeholderFor = (list: ListEntry) =>
  list.rec.data.kind === 'gifts' ? 'Add a gift idea' : `Add to ${list.rec.data.name}`;

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
      <AddItem list={list} placeholder={placeholderFor(list)} />
      <ul class="items">
        {open.map((i) => (
          <ItemRow key={i.id} item={i} assignable={!priv} />
        ))}
      </ul>
      {!open.length && <p class="nothing">{items.length ? 'All done.' : 'Nothing here yet.'}</p>}
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
            <span class="it-t grow">
              {i.rec.data.text}
              {i.rec.data.length && <span class="it-sub">{LENGTH_LABEL[i.rec.data.length]}</span>}
            </span>
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
              class="iconbtn it-more"
              aria-label={`Details: ${i.rec.data.text}`}
              onClick={() => {
                itemSheet.value = i.id;
              }}
            >
              <Icon name="next" size={16} />
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
      {!items.length && <p class="nothing">No ideas yet. Add a few you’d both enjoy.</p>}
    </>
  );
}

/* ---------- create / edit sheets ---------- */

type NewKind = PickerKind;
const KIND_ORDER = Object.keys(LIST_TYPES) as NewKind[];

function TypePicker({ value, onChange }: { value: ListKind; onChange: (k: NewKind) => void }) {
  const current = pickerKind(value);
  return (
    // biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled
    <div class="typepick" role="group" aria-labelledby="lt-type">
      {KIND_ORDER.map((k) => (
        <button type="button" key={k} aria-pressed={current === k} onClick={() => onChange(k)}>
          <b>{LIST_TYPES[k].label}</b>
          <span>{LIST_TYPES[k].blurb}</span>
        </button>
      ))}
    </div>
  );
}

const closeSheet = () => {
  listSheet.value = null;
};

function NewListSheet() {
  const [kind, setKind] = useState<NewKind>('todo');
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(LIST_TYPES.todo.defaultPrivate);
  const [checkin, setCheckin] = useState(false);
  const p = nameOf(partner.value);
  const submit = (e: Event) => {
    e.preventDefault();
    const finalName = name.trim() || LIST_TYPES[kind].example;
    const id = createList(finalName, kind, priv, checkin && kind === 'todo');
    currentList.value = id;
    picked.value = null;
    closeSheet();
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
          What kind of list?
        </span>
        <TypePicker
          value={kind}
          onChange={(k) => {
            setKind(k);
            setPriv(LIST_TYPES[k].defaultPrivate);
          }}
        />
        <div class="field">
          <label for="lt-name">Name</label>
          <input
            id="lt-name"
            class="txt"
            type="text"
            value={name}
            maxLength={100}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder={LIST_TYPES[kind].example}
            autocomplete="off"
          />
        </div>
        <Switch
          checked={priv}
          onChange={setPriv}
          label="Just for me"
          hint={priv ? `${p} won’t see this list at all.` : `Shared with ${p}.`}
        />
        {!priv && kind === 'todo' && (
          <Switch
            checked={checkin}
            onChange={setCheckin}
            label="Part of the weekly check-in"
            hint="Its open items come up in the check-in, to share out who does what."
          />
        )}
        <button class="btn primary big" type="submit">
          Make list
        </button>
      </form>
    </Sheet>
  );
}

function EditListSheet({ id }: { id: string }) {
  const list = allLists().find((l) => l.id === id);
  const [name, setName] = useState(list?.rec.data.name ?? '');
  const [armed, setArmed] = useState(false);
  if (!list) return null;
  const p = nameOf(partner.value);
  const count = itemsOf(id).length;
  const saveName = () => {
    const v = name.trim();
    if (v && v !== list.rec.data.name) renameList(id, v);
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
          <h2 id="le-title">Edit list</h2>
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
        <span class="lbl" id="lt-type">
          Kind
        </span>
        <TypePicker value={list.rec.data.kind} onChange={(k) => setListKind(id, k)} />
        <Switch
          checked={list.rec.data.private}
          onChange={(v) => {
            saveName();
            const newId = setListPrivacy(id, v);
            currentList.value = newId;
            listSheet.value = { type: 'edit', id: newId };
            toast(v ? `${p} can no longer see this list.` : `Shared with ${p}.`);
          }}
          label="Just for me"
          hint={list.rec.data.private ? 'Encrypted with your personal key.' : `Shared with ${p}.`}
        />
        {!list.rec.data.private && pickerKind(list.rec.data.kind) === 'todo' && (
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
        <button class="btn primary big" type="submit">
          Done
        </button>
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

/* ---------- view ---------- */

export function ListsView() {
  const lists = allLists();
  const cur = lists.find((l) => l.id === currentList.value) ?? lists[0];
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
      {cur ? (
        <div class="lists-layout">
          {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
          <div class="ltabs" role="group" aria-label="Lists">
            {lists.map((l) => {
              const items = itemsOf(l.id);
              const isIdeas = typeOf(l.rec.data.kind).behaviour === 'ideas';
              const n = isIdeas ? items.length : items.filter((i) => !i.rec.data.done).length;
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
                    <span class="sr"> {isIdeas ? 'ideas' : 'open'}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div class="lists-pane">
            <div class="listbar">
              <span class="small muted">{typeOf(cur.rec.data.kind).label}</span>
              <button
                type="button"
                class="linkbtn"
                aria-label={`Edit list: ${cur.rec.data.name}`}
                onClick={() => {
                  listSheet.value = { type: 'edit', id: cur.id };
                }}
              >
                Edit list
              </button>
            </div>
            <div class="listcard">
              {typeOf(cur.rec.data.kind).behaviour === 'ideas' ? (
                <IdeasList key={cur.id} list={cur} />
              ) : (
                <CheckList key={cur.id} list={cur} />
              )}
            </div>
          </div>
        </div>
      ) : (
        <p class="nothing">
          No lists yet. Make one for groceries, chores, to-dos, date ideas or gifts.
        </p>
      )}
      {s?.type === 'new' && <NewListSheet />}
      {s?.type === 'edit' && <EditListSheet key={s.id} id={s.id} />}
    </>
  );
}
