// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "You're both free": the stretches of a day neither of you has anything
 * on, and your date ideas to fill one. Ideas can say roughly how long they
 * take; those that don't are always offered, since most ideas fit most
 * evenings and nobody should have to size them up front.
 */
import { IDEA_LENGTHS, type IdeaLength } from '@ours/core/schema';
import type { Interval } from '@ours/core/time';
import { useState } from 'preact/hooks';
import { type ItemEntry, ideaLists, itemsOf } from './lists';
import { fmtLong, fmtTime, freeStretches, hhmm, relDay } from './select';
import { openQuick, sheet } from './sheets';
import { CloseButton, Icon, Marker, Sheet } from './ui';

export const LENGTH_LABEL: Record<IdeaLength, string> = {
  short: 'An hour or two',
  evening: 'An evening',
  half: 'Half a day',
  day: 'All day',
};

function span(w: Interval): string {
  const mins = Math.round((w.end - w.start) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const len = m ? `${h}h ${m}m` : `${h} hour${h === 1 ? '' : 's'}`;
  return `${fmtTime(hhmm(w.start))} – ${fmtTime(hhmm(w.end))} · ${len}`;
}

/** Every idea on a list of ideas to plan. */
export function allIdeas(): ItemEntry[] {
  return ideaLists().flatMap((l) => itemsOf(l.id));
}

/** The stretch to start with: this evening's if there is one, else the longest. */
function pickDefault(ws: Interval[]): number {
  const evening = ws.findIndex((w) => hhmm(w.end) >= '19:00' && hhmm(w.start) <= '19:00');
  if (evening >= 0) return evening;
  let best = 0;
  ws.forEach((w, i) => {
    const b = ws[best];
    if (b && w.end - w.start > b.end - b.start) best = i;
  });
  return best;
}

type Filter = 'fits' | 'any' | IdeaLength;

export function FreeTimeSheet({ date }: { date: string }) {
  const stretches = freeStretches(date);
  const [chosen, setChosen] = useState(() => pickDefault(stretches));
  const [filter, setFilter] = useState<Filter>('fits');
  const w = stretches[chosen];
  const room = w ? (w.end - w.start) / 60_000 : 0;
  const ideas = allIdeas();
  const shown = ideas.filter((i) => {
    const len = i.rec.data.length;
    if (filter === 'any') return true;
    // Ideas nobody sized are always offered.
    if (!len) return true;
    if (filter === 'fits') return IDEA_LENGTHS[len] <= room;
    return len === filter;
  });
  // Sized ideas that fit first, then the rest.
  shown.sort((a, b) => Number(!a.rec.data.length) - Number(!b.rec.data.length));
  const close = () => {
    sheet.value = null;
  };
  /** Starts at 7 PM when the stretch spans it and the idea is an evening or less. */
  const startFor = (len: IdeaLength | null | undefined): string => {
    if (!w) return '19:00';
    const start = hhmm(w.start);
    const evening = start <= '19:00' && hhmm(w.end) >= '20:00';
    return evening && (!len || IDEA_LENGTHS[len] <= IDEA_LENGTHS.evening) ? '19:00' : start;
  };
  const plan = (text: string, len?: IdeaLength | null, fromItem?: string) => {
    openQuick({
      text,
      ...(fromItem ? { fromItem } : {}),
      date,
      time: startFor(len),
      who: 'ours',
      ...(len ? { minutes: Math.min(IDEA_LENGTHS[len], room || IDEA_LENGTHS[len]) } : {}),
    });
  };
  const rel = relDay(date);
  const title = rel === 'Today' || rel === 'Tomorrow' ? `${rel}, ${fmtLong(date)}` : fmtLong(date);

  return (
    <Sheet labelledBy="ft-title" onClose={close}>
      <div class="sh-head">
        <span class="owner">
          <Marker owner="both" mode="dash" />
          You’re both free
        </span>
        <CloseButton onClose={close} />
      </div>
      <h2 id="ft-title">{title}</h2>
      {stretches.length ? (
        <fieldset class="ft-times">
          <legend class="sublbl">When</legend>
          {stretches.map((s, i) => (
            <label class={`ft-time${i === chosen ? ' on' : ''}`} key={s.start}>
              <input
                type="radio"
                name="ft-when"
                checked={i === chosen}
                onChange={() => setChosen(i)}
              />
              {span(s)}
            </label>
          ))}
        </fieldset>
      ) : (
        <p class="small muted">No long stretch is free that day any more.</p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the chip layout */}
      <div class="chips ft-filter" role="group" aria-labelledby="ft-len">
        <span class="sublbl" id="ft-len">
          How long
        </span>
        {(
          [
            ['fits', 'Fits this time'],
            ['short', LENGTH_LABEL.short],
            ['evening', LENGTH_LABEL.evening],
            ['half', LENGTH_LABEL.half],
            ['day', LENGTH_LABEL.day],
            ['any', 'Anything'],
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <button
            type="button"
            key={k}
            class="chip"
            aria-pressed={filter === k}
            onClick={() => setFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {ideas.length ? (
        <ul class="ft-ideas" aria-label="Date ideas">
          {shown.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                class="ft-idea"
                onClick={() => plan(i.rec.data.text, i.rec.data.length, i.id)}
              >
                <span>
                  <b>{i.rec.data.text}</b>
                  <span class="small muted">
                    {i.rec.data.length ? LENGTH_LABEL[i.rec.data.length] : 'Any length'}
                  </span>
                </span>
                <span class="ft-go">Plan it</span>
              </button>
            </li>
          ))}
          {!shown.length && <li class="nothing">No ideas of that length. Try “Anything”.</li>}
        </ul>
      ) : (
        <p class="small muted">
          No date ideas yet. Add some on a date ideas list and they’ll show up here.
        </p>
      )}
      <button
        type="button"
        class="btn"
        onClick={() =>
          openQuick({ date, time: startFor(null), who: 'ours', placeholder: 'Date night' })
        }
      >
        <Icon name="plus" size={16} />
        Something else
      </button>
    </Sheet>
  );
}
