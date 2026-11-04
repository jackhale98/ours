// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * An item's details: name, due date, repeat, who's on it and taking turns.
 * Opened from any list row (Lists and the weekly check-in).
 */

import type { IdeaLength } from '@ours/core/schema';
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { LENGTH_LABEL } from './freetime';
import { type ItemEntry, typeOf } from './lists';
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
  return <ItemSheet key={id} item={item as ItemEntry} />;
}

type Who = 'none' | 'me' | 'partner';

function ItemSheet({ item }: { item: ItemEntry }) {
  const d = item.rec.data;
  const me = viewer.value;
  const p = partner.value;
  const shared = item.scope === 'space';
  const list = findEntry(d.list_id);
  const isIdea = list?.rec.kind === 'list' && typeOf(list.rec.data.kind).behaviour === 'ideas';
  const [length, setLength] = useState<IdeaLength | null>(d.length ?? null);
  const [text, setText] = useState(d.text);
  const [due, setDue] = useState(d.due ?? '');
  const [repeat, setRepeat] = useState(d.repeat ?? '');
  const [rotate, setRotate] = useState(d.rotate ?? false);
  const [who, setWho] = useState<Who>(
    d.assignee === me ? 'me' : d.assignee === p ? 'partner' : 'none',
  );
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const custom = !!repeat && !REPEAT_CHOICES.some(([v]) => v === repeat);

  const save = (e: Event) => {
    e.preventDefault();
    const name = text.trim();
    if (!name) return setError('Give it a name.');
    const assignee: Slot | null = who === 'me' ? me : who === 'partner' ? p : null;
    if (isIdea) {
      update<'item'>(item.id, { text: name.slice(0, 500), length });
      close();
      toast('Saved.');
      return;
    }
    update<'item'>(item.id, {
      text: name.slice(0, 500),
      // A repeating task needs a date to count from: today if none was given.
      due: due || (repeat ? today.value : null),
      repeat: repeat || null,
      rotate: !!repeat && shared && rotate,
      assignee: shared ? assignee : null,
    });
    close();
    toast(repeat ? `Saved. It repeats ${repeatText(repeat).toLowerCase()}.` : 'Saved.');
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
        {isIdea && (
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
        {!isIdea && (
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
        {repeat && (
          <p class="small muted">
            Ticking it moves it to the next date instead of finishing it.
            {d.last_done ? ` Last done ${relDay(d.last_done).toLowerCase()}.` : ''}
          </p>
        )}
        {shared && !isIdea && (
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
        {shared && repeat && (
          <Switch
            checked={rotate}
            onChange={setRotate}
            label="Take turns"
            hint="Each time it’s done, it passes to the other one of you."
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
        <span class="small muted">{d.due ? `Due ${fmtLong(d.due)}` : ''}</span>
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
