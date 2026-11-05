// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One day of a repeating plan, on its own: skip it, move it, or put a moved
 * day back. Shown in a plan's sheet when it was opened from a particular day.
 * The whole series is still changed with "Edit".
 */
import { addDays, addWallMinutes, wallMinutes } from '@ours/core/time';
import { useState } from 'preact/hooks';
import { type EventData, setException } from './model';
import { fmtLong, planWhen } from './select';
import { skipBetween, splitSeries } from './series';
import { Icon, toast } from './ui';

/** Start and end of one day of the series, as it stands (moved or not). */
export function dayTimes(e: EventData, occ: string): { start: string; end: string } {
  const moved = e.except?.find((x) => x.at === occ)?.to;
  if (moved) return moved;
  if (e.all_day) {
    const days = Math.round(wallMinutes(e.start, e.end) / 1440);
    return { start: occ, end: addDays(occ, Math.max(1, days)) };
  }
  return { start: occ, end: addWallMinutes(occ, wallMinutes(e.start, e.end)) };
}

/** "Tue, Nov 10" for a day's original start (either form). */
const dayName = (at: string) => fmtLong(at.slice(0, 10));

export function ThisDay({
  id,
  e,
  occ,
  onDone,
  onSplit,
}: {
  id: string;
  e: EventData;
  occ: string;
  onDone: () => void;
  /** "This and following": the new series to edit. */
  onSplit?: (copy: string) => void;
}) {
  const cur = dayTimes(e, occ);
  const moved = e.except?.some((x) => x.at === occ && x.to);
  const [moving, setMoving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [skipTo, setSkipTo] = useState(addDays(occ.slice(0, 10), 6));
  const [date, setDate] = useState(cur.start.slice(0, 10));
  const [start, setStart] = useState(e.all_day ? '' : cur.start.slice(11, 16));
  const [end, setEnd] = useState(e.all_day ? '' : cur.end.slice(11, 16));
  const [error, setError] = useState<string | null>(null);

  const move = (ev: Event) => {
    ev.preventDefault();
    if (!date) return setError('Choose a day.');
    let to: { start: string; end: string };
    if (e.all_day) {
      const days = Math.round(wallMinutes(cur.start, cur.end) / 1440);
      to = { start: date, end: addDays(date, Math.max(1, days)) };
    } else {
      if (!start || !end) return setError('Choose a start and end time.');
      const s = `${date}T${start}`;
      let en = `${date}T${end}`;
      // "9 PM to 1 AM" means the next morning.
      if (wallMinutes(s, en) < 0) en = `${addDays(date, 1)}T${end}`;
      to = { start: s, end: en };
    }
    const undo = setException(id, occ, to);
    onDone();
    toast(`Moved to ${planWhen({ ...to, all_day: e.all_day })}.`, undo);
  };

  return (
    <section class="thisday" aria-labelledby="td-h">
      <h3 class="sublbl" id="td-h">
        Just {dayName(cur.start)}
      </h3>
      {moved && (
        <p class="small muted">
          <Icon name="clock" size={14} /> Moved from {dayName(occ)}.
        </p>
      )}
      {skipping ? (
        <form
          class="stack gap"
          onSubmit={(ev) => {
            ev.preventDefault();
            const r = skipBetween(id, occ.slice(0, 10), skipTo);
            onDone();
            toast(
              r.n
                ? `Skipped ${r.n} ${r.n === 1 ? 'day' : 'days'}. The rest still repeat.`
                : 'Those days were already skipped.',
              r.undo,
            );
          }}
        >
          <div class="field">
            <label for="td-until">Skip from {dayName(occ)} until</label>
            <input
              id="td-until"
              class="txt"
              type="date"
              value={skipTo}
              min={occ.slice(0, 10)}
              data-autofocus
              onInput={(ev) => setSkipTo(ev.currentTarget.value)}
            />
          </div>
          <div class="btnrow">
            <button type="submit" class="btn sm primary">
              Skip these days
            </button>
            <button type="button" class="btn sm ghost" onClick={() => setSkipping(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : moving ? (
        <form class="stack gap" onSubmit={move} noValidate>
          <div class={e.all_day ? 'field' : 'row3'}>
            <div class="field">
              <label for="td-date">{e.all_day ? 'Move to' : 'Day'}</label>
              <input
                id="td-date"
                class="txt"
                type="date"
                value={date}
                data-autofocus
                onInput={(ev) => setDate(ev.currentTarget.value)}
              />
            </div>
            {!e.all_day && (
              <>
                <div class="field">
                  <label for="td-start">From</label>
                  <input
                    id="td-start"
                    class="txt"
                    type="time"
                    value={start}
                    onInput={(ev) => setStart(ev.currentTarget.value)}
                  />
                </div>
                <div class="field">
                  <label for="td-end">To</label>
                  <input
                    id="td-end"
                    class="txt"
                    type="time"
                    value={end}
                    onInput={(ev) => setEnd(ev.currentTarget.value)}
                  />
                </div>
              </>
            )}
          </div>
          {error && (
            <p class="formerr" role="alert">
              {error}
            </p>
          )}
          <div class="btnrow">
            <button type="submit" class="btn sm primary">
              Move this day
            </button>
            <button type="button" class="btn sm ghost" onClick={() => setMoving(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div class="btnrow">
          <button type="button" class="btn sm" onClick={() => setMoving(true)}>
            <Icon name="clock" size={15} />
            Move this day
          </button>
          <button
            type="button"
            class="btn sm"
            onClick={() => {
              const undo = setException(id, occ, null);
              onDone();
              toast(`Skipped ${dayName(cur.start)}. The rest still repeat.`, undo);
            }}
          >
            <Icon name="x" size={15} />
            Skip this day
          </button>
          <button type="button" class="btn sm ghost" onClick={() => setSkipping(true)}>
            Skip several days
          </button>
          {onSplit && occ.slice(0, 10) > e.start.slice(0, 10) && (
            <button
              type="button"
              class="btn sm ghost"
              onClick={() => {
                const copy = splitSeries(id, occ);
                if (copy) onSplit(copy);
              }}
            >
              Change from {dayName(occ)} on
            </button>
          )}
          {moved && (
            <button
              type="button"
              class="btn sm ghost"
              onClick={() => {
                const undo = setException(id, occ, undefined);
                onDone();
                toast(`Back on ${dayName(occ)}.`, undo);
              }}
            >
              Put it back
            </button>
          )}
        </div>
      )}
    </section>
  );
}
