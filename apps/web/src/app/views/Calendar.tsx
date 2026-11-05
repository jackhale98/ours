// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Week and month views of the Plan tab (docs/design/calendar-views.md).
 * Both are summaries: every plan in them is also in a list (the chosen day's
 * agenda), and every day has a text label, so nothing depends on seeing the grid.
 */
import { addDays, toInstant } from '@ours/core/time';
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { waiting } from '../inbox';
import { nameOf, partner } from '../model';
import { drawerOpen, focusDate, hidden, type PlanMode, planMode, setPlanMode } from '../planview';
import {
  agendaFrom,
  continues,
  type Day,
  dayNum,
  dow,
  fmtLong,
  fmtTime,
  monDay,
  now,
  type Row,
  routineWhileAway,
  shownDays,
  startOfWeek,
  today,
  weekStartsOn,
  zone,
} from '../select';
import { openEvent, openFreeTime, openQuick } from '../sheets';
import { Icon, Marker } from '../ui';
import { EventRow } from './Plan';

/* ---------- shared bits ---------- */

const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const ymd = (date: string) => date.split('-').map(Number) as [number, number, number];
const monthOf = (date: string) => date.slice(0, 7);
const longDay = (date: string) =>
  `${DOW_LONG[dow(date)]} ${dayNum(date)} ${MONTHS[ymd(date)[1] - 1]}`;
export const monthTitle = (date: string) => `${MONTHS[ymd(date)[1] - 1]} ${ymd(date)[0]}`;

/** Adds months, keeping the day where possible (31 Jan + 1 month = 28/29 Feb). */
function addMonths(date: string, n: number): string {
  const [y, m, d] = ymd(date);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)));
  return out.toISOString().slice(0, 10);
}

export const selected = () => focusDate.value ?? today.value;

/** The next or previous week or month (keyboard J and K, review 0009 P-14). */
export function stepPeriod(n: 1 | -1): void {
  const cur = selected();
  focusDate.value = planMode.value === 'month' ? addMonths(cur, n) : addDays(cur, 7 * n);
}

/** Wide screens get the time grid and titles in month cells. */
const wide = signal(typeof matchMedia === 'function' && matchMedia('(min-width: 720px)').matches);
/** Big screens: taller month cells, room for a third title. */
const desk = signal(typeof matchMedia === 'function' && matchMedia('(min-width: 1200px)').matches);
if (typeof matchMedia === 'function') {
  matchMedia('(min-width: 1200px)').addEventListener('change', (e) => {
    desk.value = e.matches;
  });
}
if (typeof matchMedia === 'function') {
  matchMedia('(min-width: 720px)').addEventListener('change', (e) => {
    wide.value = e.matches;
  });
}

/** What a day holds, in words (screen readers; also the cell's accessible name). */
function dayLabel(day: Day, isToday: boolean): string {
  const plans = day.rows.filter((r) => !r.free);
  const parts = [`${isToday ? 'Today, ' : ''}${longDay(day.date)}`];
  parts.push(
    plans.length ? `${plans.length} plan${plans.length === 1 ? '' : 's'}` : 'nothing planned',
  );
  if (plans.some((r) => r.away)) parts.push('someone is away');
  if (plans.some((r) => r.countdown)) parts.push('a countdown day');
  if (day.bothFree && day.date >= today.value) parts.push('both free this evening');
  return parts.join(', ');
}

/**
 * Which plans a crowded month day shows first (review 0009, P-8): trips and
 * all-day plans, one-off plans together, questions, one-off plans of one
 * of you, imported calendars, then routines.
 */
function rank(r: Row): number {
  if (r.allDay) return 0;
  if (r.repeat) return 5;
  if (r.origin === 'import') return 4;
  if (r.status === 'proposed') return 2;
  return r.owner === 'both' ? 1 : 3;
}
const byImportance = (a: Row, b: Row) =>
  rank(a) - rank(b) ||
  // Plans over several days keep the same place in each day, so they line up as a bar.
  Number(!!b.span) - Number(!!a.span) ||
  a.occStart - b.occStart ||
  a.start.localeCompare(b.start) ||
  a.key.localeCompare(b.key);

const markerMode = (r: Row) =>
  r.type === 'busy' ? ('busy' as const) : r.status !== 'confirmed' ? ('dash' as const) : undefined;

function Markers({ rows, max = 3 }: { rows: Row[]; max?: number }) {
  const shown = rows.slice(0, max);
  const more = rows.length - shown.length;
  return (
    <span class="cal-marks" aria-hidden="true">
      {shown.map((r) => {
        const mode = markerMode(r);
        return <Marker key={r.key} owner={r.owner} {...(mode ? { mode } : {})} />;
      })}
      {more > 0 && <span class="cal-more">+{more}</span>}
    </span>
  );
}

/** Agenda · Week · Month. */
export function ViewSwitch() {
  const labels: Record<PlanMode, string> = { agenda: 'Agenda', week: 'Week', month: 'Month' };
  return (
    // biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout
    <div class="seg viewsw" role="group" aria-label="View">
      {(['agenda', 'week', 'month'] as const).map((m) => (
        <button
          type="button"
          key={m}
          aria-pressed={planMode.value === m}
          onClick={() => setPlanMode(m)}
        >
          {labels[m]}
        </button>
      ))}
    </div>
  );
}

function PeriodNav({ unit, step }: { unit: 'week' | 'month'; step: (n: number) => void }) {
  return (
    <div class="pnav">
      <button
        type="button"
        class="iconbtn"
        aria-label={`Previous ${unit}`}
        onClick={() => step(-1)}
      >
        <Icon name="prev" size={18} />
      </button>
      <button
        type="button"
        class="btn sm"
        onClick={() => {
          focusDate.value = null;
        }}
      >
        Today
      </button>
      <button type="button" class="iconbtn" aria-label={`Next ${unit}`} onClick={() => step(1)}>
        <Icon name="next" size={18} />
      </button>
    </div>
  );
}

/**
 * What's waiting on me stays visible in every view. Phones skip it in the
 * month view, where the header's "Waiting on you" button does the same job
 * and the grid needs the height.
 */
function NeedsAnswer() {
  const n = waiting.value.length;
  if (!n) return null;
  return (
    <button
      type="button"
      class="needs"
      onClick={() => {
        location.hash = 'inbox';
      }}
    >
      <Marker owner="both" mode="dash" />
      {n === 1 ? '1 thing is waiting on you' : `${n} things are waiting on you`}
      <span class="free-cta">Go through</span>
    </button>
  );
}

/** The chosen day's plans: the same rows as the agenda. */
function DayPanel({ day }: { day: Day }) {
  const isToday = day.date === today.value;
  return (
    <section class="daypanel" aria-label={`Plans on ${longDay(day.date)}`}>
      <h2 class="h3">{isToday ? `Today, ${fmtLong(day.date)}` : fmtLong(day.date)}</h2>
      <div class="dlist">
        {day.rows.map((row) => (
          <EventRow
            key={row.key}
            row={row}
            date={day.date}
            clash={day.clash.has(row.key)}
            dim={routineWhileAway(row, day)}
          />
        ))}
        {!day.rows.length && <p class="nothing">Nothing planned</p>}
        {day.bothFree && day.date >= today.value && (
          <button type="button" class="free" onClick={() => openFreeTime(day.date)}>
            <Marker owner="both" mode="dash" />
            Both free this evening
            <span class="free-cta">See ideas</span>
          </button>
        )}
      </div>
      <button
        type="button"
        class="btn sm"
        onClick={() =>
          openQuick({ date: day.date, ...(day.bothFree ? { time: '19:00', who: 'ours' } : {}) })
        }
      >
        <Icon name="plus" size={15} />
        Add a plan on this day
      </button>
    </section>
  );
}

/**
 * Slides the next or previous week or month in from the side it lies on,
 * instead of swapping it in place. Only a change of period slides; picking a
 * day within it doesn't. Reduced-motion settings turn the animation off
 * (base.css), leaving the plain swap.
 */
function useSlide(period: string) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef(period);
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = period;
    const el = ref.current;
    if (!el || before === period) return;
    el.classList.remove('slide-next', 'slide-prev');
    void el.offsetWidth; // restart the animation if one is running
    el.classList.add(period > before ? 'slide-next' : 'slide-prev');
  }, [period]);
  return ref;
}

/** Arrow-key movement shared by the month grid and the week strip. */
function moveBy(e: KeyboardEvent, current: string, unit: 'week' | 'month'): string | null {
  const ws = weekStartsOn.value;
  switch (e.key) {
    case 'ArrowLeft':
      return addDays(current, -1);
    case 'ArrowRight':
      return addDays(current, 1);
    case 'ArrowUp':
      return unit === 'month' ? addDays(current, -7) : null;
    case 'ArrowDown':
      return unit === 'month' ? addDays(current, 7) : null;
    case 'PageUp':
      return unit === 'month' ? addMonths(current, -1) : addDays(current, -7);
    case 'PageDown':
      return unit === 'month' ? addMonths(current, 1) : addDays(current, 7);
    case 'Home':
      return startOfWeek(current, ws);
    case 'End':
      return addDays(startOfWeek(current, ws), 6);
    default:
      return null;
  }
}

/** Keeps keyboard focus on the chosen day after it moves (and re-renders). */
function useFollowFocus(container: { current: HTMLElement | null }, date: string) {
  const hadFocus = useRef(false);
  useEffect(() => {
    if (!hadFocus.current) return;
    hadFocus.current = false;
    container.current?.querySelector<HTMLElement>(`[data-date="${date}"]`)?.focus();
  }, [date]);
  return () => {
    hadFocus.current = !!container.current?.contains(document.activeElement);
  };
}

/* ---------- month ---------- */

/** Phones and small tablets: the grid fills the screen and the day lives in a drawer. */
const compact = signal(
  typeof matchMedia === 'function' && matchMedia('(max-width: 879.98px)').matches,
);
if (typeof matchMedia === 'function') {
  matchMedia('(max-width: 879.98px)').addEventListener('change', (e) => {
    compact.value = e.matches;
    if (!e.matches) drawerOpen.value = false;
  });
}

/** Always six weeks, so the grid never changes height between months. */
const GRID_DAYS = 42;

/** One line about the day, shown on the collapsed drawer. */
function preview(day: Day): string {
  const plans = day.rows.filter((r) => !r.free);
  const first = plans[0];
  if (!first)
    return day.bothFree && day.date >= today.value
      ? 'Nothing planned · both free this evening'
      : 'Nothing planned';
  const when = first.allDay ? 'All day' : fmtTime(first.start);
  return `${when} ${first.title}${plans.length > 1 ? `, +${plans.length - 1} more` : ''}`;
}

/**
 * The chosen day on phones (pattern from fasti's month view): a drawer above
 * the tab bar. Collapsed it shows the day and a one-line preview; tap or drag
 * the handle up for the full list, down or Escape to put it away.
 */
function DayDrawer({ day }: { day: Day }) {
  const open = drawerOpen.value;
  const ref = useRef<HTMLElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [dragY, setDragY] = useState<number | null>(null);
  const drag = useRef<{ y: number; t: number; base: number; max: number; moved: boolean } | null>(
    null,
  );
  const isToday = day.date === today.value;

  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [day.date]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drawerOpen.value || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      drawerOpen.value = false;
      if (ref.current?.contains(document.activeElement)) handle.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      drawerOpen.value = false;
    };
  }, []);

  const collapsedH = () =>
    Number.parseFloat(getComputedStyle(ref.current as Element).getPropertyValue('--col-h')) || 92;
  const start = (e: PointerEvent) => {
    if (!e.isPrimary || !ref.current) return;
    const max = ref.current.offsetHeight - collapsedH();
    drag.current = { y: e.clientY, t: e.timeStamp, base: open ? 0 : max, max, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dy) < 6) return;
    d.moved = true;
    setDragY(Math.min(d.max, Math.max(0, d.base + dy)));
  };
  const end = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDragY(null);
    if (!d) return;
    if (!d.moved) {
      drawerOpen.value = !open; // a tap on the header toggles
      return;
    }
    const dy = e.clientY - d.y;
    const fast = Math.abs(dy) / Math.max(1, e.timeStamp - d.t) > 0.5;
    if (open ? dy > (fast ? 12 : 60) : dy < -(fast ? 12 : 60)) drawerOpen.value = !open;
  };

  return (
    <section
      ref={ref}
      class={`drawer${open ? ' open' : ''}${dragY !== null ? ' dragging' : ''}`}
      style={dragY !== null ? { transform: `translateY(${dragY}px)` } : undefined}
      aria-label="Chosen day"
    >
      <div
        class="dhead"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          drag.current = null;
          setDragY(null);
        }}
      >
        <button
          type="button"
          class="grab"
          ref={handle}
          aria-expanded={open}
          aria-controls="day-list"
          aria-label="Plans on this day"
          onClick={(e) => {
            // Keyboard and screen readers (taps are handled on the header).
            if (e.detail === 0) drawerOpen.value = !open;
          }}
        >
          <span class="bar" />
        </button>
        <h2 class="h3" id="day-h">
          {isToday ? `Today, ${fmtLong(day.date)}` : fmtLong(day.date)}
        </h2>
        {!open && <p class="preview">{preview(day)}</p>}
      </div>
      <div
        id="day-list"
        class="dlist"
        ref={list}
        {...({ inert: !open } as Record<string, boolean>)}
      >
        {day.rows.map((row) => (
          <EventRow
            key={row.key}
            row={row}
            date={day.date}
            clash={day.clash.has(row.key)}
            dim={routineWhileAway(row, day)}
          />
        ))}
        {!day.rows.length && <p class="nothing">Nothing planned</p>}
        {day.bothFree && day.date >= today.value && (
          <button type="button" class="free" onClick={() => openFreeTime(day.date)}>
            <Marker owner="both" mode="dash" />
            Both free this evening
            <span class="free-cta">See ideas</span>
          </button>
        )}
        <button
          type="button"
          class="btn sm"
          onClick={() =>
            openQuick({
              date: day.date,
              ...(day.bothFree && day.date >= today.value ? { time: '19:00', who: 'ours' } : {}),
            })
          }
        >
          <Icon name="plus" size={15} />
          Add a plan on this day
        </button>
      </div>
    </section>
  );
}

export function MonthView() {
  const sel = selected();
  const first = `${monthOf(sel)}-01`;
  const gridStart = startOfWeek(first);
  const days = shownDays(agendaFrom(gridStart, GRID_DAYS), hidden.value);
  const t = today.value;
  const grid = useRef<HTMLTableElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const remember = useFollowFocus(grid, sel);
  const monthSlide = useSlide(monthOf(sel));
  const ws = weekStartsOn.value;
  const selDay = days.find((d) => d.date === sel) ?? shownDays(agendaFrom(sel, 1), hidden.value)[0];
  const phone = compact.value;
  // Titles shown in each cell: the rest are counted as markers.
  const titles = desk.value ? 3 : 2;

  // Phones: the six weeks share whatever height is left above the drawer.
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    if (!phone) return;
    const measure = () => {
      if (stage.current)
        setTop(Math.round(stage.current.getBoundingClientRect().top + window.scrollY));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (stage.current?.parentElement) ro.observe(stage.current.parentElement);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [phone]);

  const onKey = (e: KeyboardEvent) => {
    const next = moveBy(e, sel, 'month');
    if (!next) return;
    e.preventDefault();
    remember();
    focusDate.value = next;
  };

  // Swipe the grid (phones): sideways changes month, up opens the drawer.
  const swipe = useRef<{ x: number; y: number; done: boolean } | null>(null);
  const swallow = useRef(false);

  return (
    <>
      <div class="phead">
        <h2 class="ptitle" aria-live="polite">
          {monthTitle(sel)}
        </h2>
        <PeriodNav
          unit="month"
          step={(n) => {
            focusDate.value = addMonths(sel, n);
          }}
        />
      </div>
      {!phone && <NeedsAnswer />}
      <div class={`month-wrap${phone ? ' phone' : ''}`}>
        <div
          class="mstage"
          ref={stage}
          style={phone ? ({ '--top': `${top}px` } as Record<string, string>) : undefined}
          onPointerDown={(e) => {
            swallow.current = false;
            swipe.current =
              phone && e.isPrimary ? { x: e.clientX, y: e.clientY, done: false } : null;
          }}
          onPointerMove={(e) => {
            const sw = swipe.current;
            if (!sw || sw.done) return;
            const dx = e.clientX - sw.x;
            const dy = e.clientY - sw.y;
            if (Math.abs(dx) > 48 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
              sw.done = true;
              swallow.current = true;
              focusDate.value = addMonths(sel, dx < 0 ? 1 : -1);
            } else if (dy < -48 && Math.abs(dy) > 1.5 * Math.abs(dx)) {
              sw.done = true;
              swallow.current = true;
              drawerOpen.value = true;
            }
          }}
          onPointerUp={() => {
            swipe.current = null;
          }}
          onClickCapture={(e) => {
            if (!swallow.current) return;
            swallow.current = false;
            e.stopPropagation();
            e.preventDefault();
          }}
        >
          {/* A calendar table: one tab stop (the chosen day); arrow keys, Page Up/Down and Home/End move. */}
          <div class="slide" ref={monthSlide}>
            <table
              class={`month${wide.value ? ' wide' : ''}`}
              aria-label={monthTitle(sel)}
              ref={grid}
              onKeyDown={onKey}
            >
              <thead>
                <tr>
                  {Array.from({ length: 7 }, (_, i) => {
                    const d = (ws + i) % 7;
                    return (
                      <th scope="col" key={d} class="mdow">
                        <abbr title={DOW_LONG[d]}>{DOW_SHORT[d]}</abbr>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: GRID_DAYS / 7 }, (_, w) => (
                  <tr key={w}>
                    {days.slice(w * 7, w * 7 + 7).map((day) => {
                      const out = monthOf(day.date) !== monthOf(sel);
                      const isSel = day.date === sel;
                      const plans = day.rows.filter((r) => !r.free).sort(byImportance);
                      const away = plans.some((r) => r.away);
                      return (
                        <td key={day.date}>
                          <button
                            type="button"
                            class={`mcell${out ? ' out' : ''}${day.date === t ? ' today' : ''}${isSel ? ' sel' : ''}`}
                            data-date={day.date}
                            aria-pressed={isSel}
                            tabIndex={isSel ? 0 : -1}
                            aria-label={dayLabel(day, day.date === t)}
                            aria-current={day.date === t ? 'date' : undefined}
                            onClick={() => {
                              // On phones a second tap on the chosen day opens its plans.
                              if (isSel && phone) drawerOpen.value = true;
                              focusDate.value = day.date;
                            }}
                          >
                            <span class="mnum" aria-hidden="true">
                              {dayNum(day.date)}
                              {plans.some((r) => r.countdown) && <Icon name="flag" size={11} />}
                            </span>
                            {wide.value && (
                              <span class="mtitles" aria-hidden="true">
                                {plans.slice(0, titles).map((r) => {
                                  const mode = markerMode(r);
                                  return (
                                    <span
                                      key={r.key}
                                      class={`mtitle${r.span ? ` mspan${r.span.day > 1 ? ' cont' : ''}${r.span.day < r.span.of ? ' more' : ''}` : ''}`}
                                    >
                                      <Marker owner={r.owner} {...(mode ? { mode } : {})} />
                                      {/* A bar's name shows where it starts, and again each week. */}
                                      <span>
                                        {!r.span || r.span.day === 1 || dow(day.date) === ws
                                          ? r.title
                                          : ' '}
                                      </span>
                                    </span>
                                  );
                                })}
                              </span>
                            )}
                            <Markers rows={wide.value ? plans.slice(titles) : plans} />
                            {day.bothFree && !out && day.date >= t && (
                              <span class="mfree" aria-hidden="true" />
                            )}
                            {away && <span class="maway" aria-hidden="true" />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {selDay && !phone && <DayPanel day={selDay} />}
      </div>
      {selDay && phone && <DayDrawer day={selDay} />}
    </>
  );
}

/* ---------- week ---------- */

const HOUR_PX = 44;

interface Block {
  row: Row;
  top: number;
  height: number;
  lane: number;
  lanes: number;
  /** Starts before the hours shown (an overnight flight): drawn from the top. */
  early: boolean;
}

/** Minutes after the day's midnight, clipped to the day (plans crossing midnight). */
function minutesIn(row: Row, date: string): { start: number; end: number } {
  const dayStart = toInstant(`${date}T00:00`, zone);
  const dayEnd = toInstant(`${addDays(date, 1)}T00:00`, zone);
  const s = Math.max(row.occStart, dayStart);
  const e = Math.min(Math.max(row.occEnd, row.occStart), dayEnd);
  const start = Math.round((s - dayStart) / 60_000);
  const end = Math.max(start + 20, Math.round((e - dayStart) / 60_000));
  return { start, end: Math.min(end, 24 * 60) };
}

/** Side-by-side lanes for overlapping plans (at most 3; the rest are counted). */
function layout(
  rows: Row[],
  date: string,
  fromHour: number,
  toHour: number,
): { blocks: Block[]; hidden: number } {
  const items = rows
    .map((row) => ({ row, ...minutesIn(row, date) }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const blocks: Block[] = [];
  let hidden = 0;
  let cluster: (typeof items)[number][] = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds: number[] = [];
    const placed: { item: (typeof cluster)[number]; lane: number }[] = [];
    for (const item of cluster) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane < 0) lane = laneEnds.length;
      if (lane >= 3) {
        hidden++;
        continue;
      }
      laneEnds[lane] = item.end;
      placed.push({ item, lane });
    }
    const lanes = Math.max(1, laneEnds.length);
    // Plans outside the hours shown are clipped to them, not hidden (P-7).
    const lo = fromHour * 60;
    const hi = toHour * 60;
    for (const { item, lane } of placed) {
      const start = Math.min(Math.max(item.start, lo), hi - 20);
      const end = Math.max(Math.min(item.end, hi), start + 20);
      blocks.push({
        row: item.row,
        top: ((start - lo) / 60) * HOUR_PX,
        height: ((end - start) / 60) * HOUR_PX,
        lane,
        lanes,
        early: item.start < lo,
      });
    }
    cluster = [];
  };
  for (const item of items) {
    if (cluster.length && item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (cluster.length) flush();
  return { blocks, hidden };
}

function blockLabel(r: Row): string {
  const who = r.type === 'busy' ? `${nameOf(r.owner === 'both' ? partner.value : r.owner)}: ` : '';
  const when = r.allDay
    ? 'all day'
    : continues(r)
      ? `until ${fmtTime(r.end)}`
      : `${fmtTime(r.start)} to ${fmtTime(r.end)}`;
  const tentative = r.status === 'proposed' ? ', tentative' : '';
  return `${who}${r.title}, ${when}${tentative}`;
}

/** The value a share `q` of the way through sorted numbers (nearest rank). */
const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ?? 0;

/**
 * The week's all-day plans as bars across the days they cover (review 0009,
 * P-8): a trip is one bar, not seven chips. Bars take the first free lane.
 */
function AllDayBars({ days }: { days: Day[] }) {
  const bars: { row: Row; from: number; to: number; lane: number }[] = [];
  const seen = new Map<string, (typeof bars)[number]>();
  days.forEach((d, i) => {
    for (const r of d.rows) {
      if (!r.allDay) continue;
      const got = seen.get(r.key);
      if (got) got.to = i;
      else {
        const bar = { row: r, from: i, to: i, lane: 0 };
        seen.set(r.key, bar);
        bars.push(bar);
      }
    }
  });
  const lanes: number[] = [];
  for (const b of bars) {
    let lane = lanes.findIndex((end) => end < b.from);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = b.to;
    b.lane = lane;
  }
  return (
    <div
      class="wg-allday"
      style={{ gridTemplateRows: `repeat(${Math.max(1, lanes.length)}, auto)` }}
    >
      <span class="wg-lbl" style={{ gridRow: `1 / ${Math.max(1, lanes.length) + 1}` }}>
        All day
      </span>
      {days.map((d, i) => (
        <span
          key={d.date}
          class="wg-adcell"
          aria-hidden="true"
          style={{ gridColumn: `${i + 2}`, gridRow: `1 / ${Math.max(1, lanes.length) + 1}` }}
        />
      ))}
      {bars.map(({ row: r, from, to, lane }) => {
        const mode = markerMode(r);
        const first = !r.span || r.span.day === 1 || from > 0;
        return (
          <button
            type="button"
            key={r.key}
            class={`wg-chip wg-bar${r.away ? ' away' : ''}${from === 0 && r.span && r.span.day > 1 ? ' cont' : ''}`}
            style={{ gridColumn: `${from + 2} / ${to + 3}`, gridRow: `${lane + 1}` }}
            aria-label={blockLabel(r)}
            onClick={() => openEvent(r.id, r.occ)}
          >
            <Marker owner={r.owner} {...(mode ? { mode } : {})} />
            <span>
              {first ? '' : '← '}
              {r.title}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function WeekGrid({ days, sel }: { days: Day[]; sel: string }) {
  const t = today.value;
  const timed = days.map((d) => d.rows.filter((r) => !r.allDay));
  // The hours most plans fall in: one overnight flight doesn't stretch the
  // grid to midnight; plans outside are clipped with "↑" (review 0009, P-7).
  const starts: number[] = [];
  const ends: number[] = [];
  for (const [i, rows] of timed.entries()) {
    for (const r of rows) {
      const { start, end } = minutesIn(r, days[i]?.date ?? '');
      starts.push(start);
      ends.push(end);
    }
  }
  starts.sort((a, b) => a - b);
  ends.sort((a, b) => a - b);
  const from = Math.max(0, Math.min(7, Math.floor(quantile(starts, 0.05) / 60)));
  const to = Math.min(24, Math.max(23, Math.ceil(quantile(ends, 0.95) / 60)));
  const nowMin = (now.value - toInstant(`${t}T00:00`, zone)) / 60_000;
  const nowTop = ((nowMin - from * 60) / 60) * HOUR_PX;
  const hours = Array.from({ length: to - from }, (_, i) => from + i);
  const eveTop = ((17 - from) * 60 * HOUR_PX) / 60;
  const eveHeight = 5 * HOUR_PX;
  return (
    <div class="wgrid" style={{ '--hours': hours.length } as Record<string, number>}>
      <div class="wg-head">
        <span />
        {/* Each day opens in the panel below, with every plan listed (P-7). */}
        {days.map((d) => (
          <button
            type="button"
            key={d.date}
            class={`wg-day${d.date === t ? ' today' : ''}`}
            aria-pressed={d.date === sel}
            aria-label={dayLabel(d, d.date === t)}
            onClick={() => {
              focusDate.value = d.date;
            }}
          >
            <b>{DOW_SHORT[dow(d.date)]}</b> {dayNum(d.date)}
          </button>
        ))}
      </div>
      <AllDayBars days={days} />
      <div class="wg-body">
        <div class="wg-hours" aria-hidden="true">
          {hours.map((h) => (
            <span key={h} style={{ height: `${HOUR_PX}px` }}>
              {fmtTime(`${String(h).padStart(2, '0')}:00`)}
            </span>
          ))}
        </div>
        {days.map((d, i) => {
          const { blocks, hidden } = layout(timed[i] ?? [], d.date, from, to);
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: tapping empty time is a mouse shortcut; the "Add a plan on this day" button covers keyboard users
            // biome-ignore lint/a11y/noStaticElementInteractions: see above
            <div
              key={d.date}
              class={`wg-col${d.date === t ? ' today' : ''}`}
              style={{ height: `${hours.length * HOUR_PX}px` }}
              onClick={(e) => {
                if (e.target !== e.currentTarget) return;
                const y = (e as MouseEvent).offsetY;
                const h = Math.min(23, from + Math.floor(y / HOUR_PX));
                openQuick({ date: d.date, time: `${String(h).padStart(2, '0')}:00` });
              }}
            >
              {d.bothFree && d.date >= t && (
                <span class="wg-free" style={{ top: `${eveTop}px`, height: `${eveHeight}px` }}>
                  Both free
                </span>
              )}
              {blocks.map((b) => {
                const mode = markerMode(b.row);
                return (
                  <button
                    type="button"
                    key={b.row.key}
                    class={`wg-ev${b.row.type === 'busy' ? ' is-masked' : ''}${b.row.status !== 'confirmed' ? ' tentative' : ''}`}
                    style={{
                      top: `${b.top}px`,
                      height: `${Math.max(22, b.height - 2)}px`,
                      left: `${(b.lane / b.lanes) * 100}%`,
                      width: `${100 / b.lanes}%`,
                    }}
                    aria-label={blockLabel(b.row)}
                    onClick={() => openEvent(b.row.id, b.row.occ)}
                  >
                    <Marker owner={b.row.owner} {...(mode ? { mode } : {})} />
                    <span class="wg-t">{b.row.title}</span>
                    <span class="wg-time">
                      {b.early ? '↑ ' : ''}
                      {continues(b.row) ? `until ${fmtTime(b.row.end)}` : fmtTime(b.row.start)}
                    </span>
                  </button>
                );
              })}
              {d.date === t && nowTop >= 0 && nowTop <= hours.length * HOUR_PX && (
                <span class="wg-now" style={{ top: `${nowTop}px` }} aria-hidden="true" />
              )}
              {hidden > 0 && (
                <button
                  type="button"
                  class="cal-more wg-hidden"
                  aria-label={`${hidden} more on ${fmtLong(d.date)}: show the day`}
                  onClick={() => {
                    focusDate.value = d.date;
                    document.querySelector('.daypanel')?.scrollIntoView({ block: 'nearest' });
                  }}
                >
                  +{hidden}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekStrip({ days, sel }: { days: Day[]; sel: string }) {
  const t = today.value;
  const strip = useRef<HTMLDivElement>(null);
  const remember = useFollowFocus(strip, sel);
  return (
    // biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled
    <div
      class="wstrip"
      role="group"
      aria-label="Days this week"
      ref={strip}
      onKeyDown={(e) => {
        const next = moveBy(e, sel, 'week');
        if (!next) return;
        e.preventDefault();
        remember();
        focusDate.value = next;
      }}
    >
      {days.map((d) => (
        <button
          type="button"
          key={d.date}
          data-date={d.date}
          class={`wday${d.date === t ? ' today' : ''}`}
          aria-pressed={d.date === sel}
          aria-label={dayLabel(d, d.date === t)}
          tabIndex={d.date === sel ? 0 : -1}
          onClick={() => {
            focusDate.value = d.date;
          }}
        >
          <span class="wdow" aria-hidden="true">
            {DOW_SHORT[dow(d.date)]}
          </span>
          <span class="wnum" aria-hidden="true">
            {dayNum(d.date)}
          </span>
          <Markers rows={d.rows.filter((r) => !r.free)} />
        </button>
      ))}
    </div>
  );
}

export function WeekView() {
  const sel = selected();
  const start = startOfWeek(sel);
  const days = shownDays(agendaFrom(start, 7), hidden.value);
  const selDay = days.find((d) => d.date === sel) ?? days[0];
  const weekSlide = useSlide(start);
  // Swipe on the day strip changes week (a shortcut; the buttons do the same).
  const touch = useRef<number | null>(null);
  return (
    <>
      <div class="phead">
        <h2 class="ptitle" aria-live="polite">
          {monDay(start)} – {monDay(addDays(start, 6))}
        </h2>
        <PeriodNav
          unit="week"
          step={(n) => {
            focusDate.value = addDays(sel, 7 * n);
          }}
        />
      </div>
      <NeedsAnswer />
      {wide.value ? (
        <>
          <div class="slide-host">
            <div class="slide" ref={weekSlide}>
              <WeekGrid days={days} sel={sel} />
            </div>
          </div>
          {selDay && <DayPanel day={selDay} />}
        </>
      ) : (
        <div
          onTouchStart={(e) => {
            touch.current = e.touches[0]?.clientX ?? null;
          }}
          onTouchEnd={(e) => {
            const x0 = touch.current;
            const x1 = e.changedTouches[0]?.clientX;
            touch.current = null;
            if (x0 === null || x1 === undefined || Math.abs(x1 - x0) < 60) return;
            focusDate.value = addDays(sel, x1 < x0 ? 7 : -7);
          }}
        >
          <div class="slide-host">
            <div class="slide" ref={weekSlide}>
              <WeekStrip days={days} sel={sel} />
              {selDay && <DayPanel day={selDay} />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
