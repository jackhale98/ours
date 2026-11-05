// SPDX-License-Identifier: AGPL-3.0-or-later

import { addDays } from '@ours/core/time';
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { tasksFor, waiting } from '../inbox';
import { itemSheet } from '../itemsheet';
import { dueOf, dueText } from '../lists';
import { commentsFor, nameOf, names, partner, viewer } from '../model';
import { markSeen, news } from '../news';
import { clearHidden, type Hide, hidden, planMode, toggleHidden } from '../planview';
import {
  agendaFrom,
  askVerb,
  awaitingMe,
  changeText,
  countdowns,
  dayNum,
  dowShort,
  fmtLong,
  fmtTime,
  isMoveAsk,
  monDay,
  ownerLabel,
  type Row,
  routineWhileAway,
  shownDays,
  startOfWeek,
  today,
  whenText,
} from '../select';
import {
  accept,
  ClashNote,
  decline,
  openEvent,
  openFreeTime,
  openImport,
  openPlanForm,
  SuggestTime,
} from '../sheets';
import { CloseButton, Icon, Marker, MarkerKey, Sheet } from '../ui';
import { MonthView, ViewSwitch, WeekView } from './Calendar';
import { Result } from './Search';

/** "Dec 9 – 15", or "Dec 28 – Jan 3" across months: short enough for the heading. */
function shortRange(from: string): string {
  const to = addDays(from, 6);
  return from.slice(0, 7) === to.slice(0, 7)
    ? `${monDay(from)} – ${Number(to.slice(8))}`
    : `${monDay(from)} – ${monDay(to)}`;
}

/** "Next week", "In 5 weeks", "2 weeks ago": how far the agenda is from today. */
function weeksAway(today: string, from: string): string {
  const days = Math.round((Date.parse(from) - Date.parse(today)) / 86_400_000);
  const w = Math.round(days / 7);
  if (days > 0 && days < 7) return `In ${days} ${days === 1 ? 'day' : 'days'}`;
  if (days < 0 && days > -7) return `${-days} ${days === -1 ? 'day' : 'days'} ago`;
  if (w === 1) return 'Next week';
  if (w === -1) return 'Last week';
  return w > 0 ? `In ${w} weeks` : `${-w} weeks ago`;
}

const filtersOpen = signal(false);
const pickerOpen = signal(false);

const MONTH_NAMES = [
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

/**
 * A small month to pick a day from, opened from the agenda's heading. Days
 * with plans have a dot; today is marked; the day showing is chosen.
 */
function DatePicker({
  value,
  onPick,
  onClose,
}: {
  value: string;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  const t = today.value;
  const [month, setMonth] = useState(value.slice(0, 7));
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = `${month}-01`;
  const start = startOfWeek(first);
  const grid = agendaFrom(start, 42);
  const step = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
  };
  const weekdays = grid.slice(0, 7).map((d) => dowShort(d.date).slice(0, 2));
  return (
    <Sheet labelledBy="dp-title" onClose={onClose}>
      <div class="sh-head">
        <h2 id="dp-title">Go to a day</h2>
        <CloseButton onClose={onClose} />
      </div>
      <div class="dp-head">
        <button type="button" class="iconbtn" aria-label="Previous month" onClick={() => step(-1)}>
          <Icon name="prev" size={18} />
        </button>
        <h3 class="dp-month" aria-live="polite">
          {MONTH_NAMES[m - 1]} {y}
        </h3>
        <button type="button" class="iconbtn" aria-label="Next month" onClick={() => step(1)}>
          <Icon name="next" size={18} />
        </button>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of day buttons laid out as a grid; fieldset breaks the grid */}
      <div class="dp-grid" role="group" aria-labelledby="dp-title">
        {weekdays.map((w, i) => (
          <span class="dp-dow" aria-hidden="true" key={`w${i}`}>
            {w}
          </span>
        ))}
        {grid.map((d) => {
          const out = !d.date.startsWith(month);
          return (
            <button
              type="button"
              key={d.date}
              class={`dp-day${out ? ' out' : ''}${d.date === t ? ' today' : ''}`}
              aria-pressed={d.date === value}
              aria-current={d.date === t ? 'date' : undefined}
              aria-label={`${fmtLong(d.date)}${d.rows.length ? `, ${d.rows.length} planned` : ''}`}
              onClick={() => onPick(d.date)}
            >
              {Number(d.date.slice(8))}
              {d.rows.length > 0 && <span class="dp-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <button type="button" class="btn" onClick={() => onPick(t)}>
        Today
      </button>
    </Sheet>
  );
}

/** Shows or hides the view filters; says how many things are left out. */
function FilterButton() {
  const n = hidden.value.size;
  return (
    <button
      type="button"
      class={`linkbtn fbtn${n ? ' on' : ''}`}
      aria-expanded={filtersOpen.value}
      aria-controls="vfilters"
      onClick={() => {
        filtersOpen.value = !filtersOpen.value;
      }}
    >
      {n ? `Filtered (${n})` : 'Filter'}
    </button>
  );
}

/** Mine, theirs, ours, imported, routines: shown or not, on this device (P-8). */
function Filters() {
  if (!filtersOpen.value) return null;
  const p = nameOf(partner.value);
  const choices: [Hide, string][] = [
    ['mine', 'Mine'],
    ['partner', `${p}’s`],
    ['ours', 'Ours'],
    ['imported', 'Imported'],
    // Plans set to repeat: gym every Monday, the weekly standup.
    ['routines', 'Repeating'],
  ];
  return (
    // biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled
    <div class="chips vfilters" id="vfilters" role="group" aria-label="Show">
      {choices.map(([k, label]) => (
        <button
          type="button"
          class="chip"
          key={k}
          aria-pressed={!hidden.value.has(k)}
          onClick={() => toggleHidden(k)}
        >
          {label}
        </button>
      ))}
      {hidden.value.size > 0 && (
        <button type="button" class="linkbtn" onClick={clearHidden}>
          Show everything
        </button>
      )}
    </div>
  );
}

/** The agenda: from which day (null: today), and how many weeks are drawn (P-10). */
const weeks = signal(1);
const agendaStart = signal<string | null>(null);
/** Days whose routines are shown in full (they fold into one line otherwise). */
const routinesOpen = signal<ReadonlySet<string>>(new Set());
const MAX_WEEKS = 26;
/** A day with this many routines folds them into "+N routines". */
const FOLD_ROUTINES = 3;

/** Grows the agenda by a week when its end scrolls into view. */
function MoreWhenSeen() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((x) => x.isIntersecting) && weeks.value < MAX_WEEKS) weeks.value += 1;
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} class="agenda-end" aria-hidden="true" />;
}

export function EventRow({
  row,
  date,
  clash = false,
  dim = false,
}: {
  row: Row;
  date: string;
  /** It overlaps another plan of the same person (P-3). */
  clash?: boolean;
  /** A routine on a day its person is away. */
  dim?: boolean;
}) {
  const me = viewer.value;
  const p = partner.value;
  const masked = row.type === 'busy';
  const mode = masked ? 'busy' : row.status !== 'confirmed' ? 'dash' : undefined;
  const labelNames = { a: nameOf('a'), b: nameOf('b') };
  return (
    <button
      type="button"
      class={`ev${masked ? ' is-masked' : ''}${row.free ? ' is-free' : ''}${row.status === 'declined' ? ' is-declined' : ''}${dim ? ' is-away' : ''}`}
      onClick={() => (row.origin === 'import' ? openImport(row, date) : openEvent(row.id, row.occ))}
    >
      <span class="ev-time">
        {row.allDay ? (
          'All day'
        ) : row.span && row.span.day > 1 ? (
          // Began on an earlier day: what matters today is when it ends (P-11).
          row.span.day < row.span.of ? (
            'All day'
          ) : (
            <>
              <span class="to">Until</span>
              {fmtTime(row.end)}
            </>
          )
        ) : (
          <>
            {fmtTime(row.start)}
            {row.span ? (
              <span class="to">{row.span.of === 2 ? 'to tomorrow' : 'onwards'}</span>
            ) : (
              row.end !== row.start && <span class="to">{fmtTime(row.end)}</span>
            )}
          </>
        )}
      </span>
      <Marker owner={row.owner} {...(mode ? { mode } : {})} />
      <span class="ev-body">
        <span class="sr">
          {masked
            ? `${nameOf(row.owner === 'both' ? p : row.owner)}: `
            : `${ownerLabel(row.owner, labelNames)}: `}
          {row.status === 'proposed' && !masked ? 'tentative, ' : ''}
          {row.status === 'declined' ? `${nameOf(p)} can’t make it, ` : ''}
        </span>
        <span class="ev-title">{row.title}</span>
        {!masked && (
          <span class="ev-meta">
            {row.status === 'proposed' && (
              <span class="tag">
                {row.proposedBy === me ? `Waiting on ${nameOf(p)}` : 'Needs your answer'}
              </span>
            )}
            {row.status === 'declined' && (
              <span class="tag no" aria-hidden="true">
                {nameOf(p)} can’t make it
              </span>
            )}
            {row.span && (row.allDay || row.span.of > 2) && (
              <span>
                Day {row.span.day} of {row.span.of}
              </span>
            )}
            {row.away && row.allDay && <span>Away</span>}
            {clash && <span class="tag warn">Overlaps</span>}
            {dim && <span>While away</span>}
            {row.origin === 'import' && (
              <span>
                <Icon name="cal" size={13} />
                {row.source ?? 'Imported'}
                {row.free ? ' · free' : ''}
              </span>
            )}
            {row.location && (
              <span>
                <Icon name="pin" size={13} />
                {row.location}
              </span>
            )}
            {row.zoneNote && (
              <span>
                <Icon name="clock" size={13} />
                {row.zoneNote}
              </span>
            )}
            {row.repeat && (
              <span>
                <Icon name="repeat" size={13} />
                {row.moved ? `${row.repeat}, moved this time` : row.repeat}
              </span>
            )}
            {row.comments > 0 && (
              <span>
                <Icon name="chat" size={13} />
                {row.comments}
                <span class="sr"> notes</span>
              </span>
            )}
            {row.privacy === 'busy' && (
              <span>
                <Icon name="lock" size={13} />
                {nameOf(p)} sees “Busy”
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

function AskCard({ id }: { id: string }) {
  const e = awaitingMe.value.find((x) => x.id === id);
  if (e?.rec.kind !== 'event') return null;
  const d = e.rec.data;
  const from = d.proposed_by ?? partner.value;
  const note = commentsFor(id).find((c) => c.rec.kind === 'comment' && c.rec.data.author === from);
  const titleId = `ask-${id}`;
  return (
    <section class="ask" aria-labelledby={titleId}>
      <p class="eyebrow">
        {nameOf(from)} {askVerb(d)} · needs your answer
      </p>
      <h2 class="h3" id={titleId}>
        {d.title}
      </h2>
      <p class="ask-when">
        {isMoveAsk(d)
          ? changeText(d)
          : whenText(d.start.slice(0, 10), d.all_day, d.start.slice(11), d.end.slice(11))}
        {d.location ? ` · ${d.location}` : ''}
      </p>
      <ClashNote
        start={d.start}
        end={d.end}
        allDay={d.all_day}
        tz={d.tz}
        owner={d.owner}
        except={id}
      />
      {note && note.rec.kind === 'comment' && <p class="ask-note">{note.rec.data.text}</p>}
      <div class="ask-actions">
        <button type="button" class="btn primary" onClick={() => accept(id)}>
          <Icon name="check" size={16} />
          Yes, add it
        </button>
        <button type="button" class="btn" onClick={() => openEvent(id)}>
          Reply
        </button>
        <button type="button" class="btn ghost" onClick={() => decline(id)}>
          Can’t make it
        </button>
      </div>
      <SuggestTime id={id} />
    </section>
  );
}

/**
 * Wide screens only (hidden on phones, where the tab bar and the header's
 * "Waiting on you" button cover the same ground): what's waiting, and list
 * tasks coming up this week.
 */
function SideCards() {
  const w = waiting.value;
  const tasks = tasksFor(7);
  return (
    <div class="side-cards">
      <section class="card side" aria-labelledby="sc-wait">
        <h2 class="h3" id="sc-wait">
          Waiting on you
        </h2>
        {w.length ? (
          <>
            <p class="small muted">
              {w.length === 1 ? '1 thing needs' : `${w.length} things need`} your answer or a hand.
            </p>
            <a class="btn sm primary" href="#inbox">
              Go through {w.length === 1 ? 'it' : 'them'}
            </a>
          </>
        ) : (
          <p class="small muted">Nothing right now.</p>
        )}
      </section>
      <section class="card side" aria-labelledby="sc-tasks">
        <h2 class="h3" id="sc-tasks">
          On your lists this week
        </h2>
        {tasks.length ? (
          <ul class="side-tasks">
            {tasks.slice(0, 8).map(({ item, list }) => {
              const due = dueText(dueOf(item) ?? today.value);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      itemSheet.value = item.id;
                    }}
                  >
                    <b>{item.rec.data.text}</b>
                    <span class={`small${due.late ? ' late' : ' muted'}`}>
                      {due.text} · {list.rec.data.name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p class="small muted">Nothing with a due date this week.</p>
        )}
        <a class="linkbtn" href="#lists">
          All lists
        </a>
      </section>
    </div>
  );
}

/**
 * What the partner changed since this device last looked, so opening the
 * app after "Something changed" shows what it was.
 */
/** The partner's changes. Over the week and month grids it is one line until opened. */
function WhatsNew({ compact = false }: { compact?: boolean }) {
  const hits = news.value;
  const [all, setAll] = useState(false);
  // Derived, not initial state: the same instance serves agenda and calendar modes.
  const [opened, setOpen] = useState(false);
  const open = !compact || opened;
  if (!hits.length) return null;
  const shown = all ? hits : hits.slice(0, 4);
  return (
    <section class={`card news${open ? '' : ' shut'}`} aria-labelledby="news-h">
      <div class="news-head">
        <h2 class="h3" id="news-h">
          New from {nameOf(partner.value)}
          {!open && <span class="news-n"> · {hits.length}</span>}
        </h2>
        {!open && (
          <button type="button" class="linkbtn" onClick={() => setOpen(true)}>
            Show
          </button>
        )}
        <button type="button" class="linkbtn" onClick={markSeen}>
          Got it
        </button>
      </div>
      {open && (
        <div class="find-group">
          <ul>
            {shown.map((h) => (
              <li key={h.id}>
                <Result hit={h} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && hits.length > shown.length && (
        <button type="button" class="linkbtn" onClick={() => setAll(true)}>
          {hits.length - shown.length} more
        </button>
      )}
    </section>
  );
}

/** How many questions show in full above the agenda, and milestones before "more". */
const ASKS_SHOWN = 2;
const MILESTONES_SHOWN = 4;
const allMilestones = signal(false);

export function PlanView() {
  const t = today.value;
  const mode = planMode.value;
  const from = agendaStart.value ?? t;
  const away = from !== t;
  const header = (
    <>
      {mode === 'agenda' ? (
        <>
          <header class="vhead">
            <div>
              <p class="eyebrow">
                {away ? weeksAway(t, from) : `${monDay(from)} – ${monDay(addDays(from, 6))}`}
                {away && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      class="linkbtn back-today"
                      onClick={() => {
                        agendaStart.value = null;
                        weeks.value = 1;
                      }}
                    >
                      Back to today
                    </button>
                  </>
                )}
              </p>
              <div class="dpick-row">
                {/* The heading picks the day the agenda starts on (review 0009, P-10). */}
                <h1>
                  <button
                    type="button"
                    class="dpick"
                    aria-haspopup="dialog"
                    aria-describedby="dpick-d"
                    onClick={() => {
                      pickerOpen.value = true;
                    }}
                  >
                    {away ? shortRange(from) : 'This week'}
                    <Icon name="down" size={22} />
                  </button>
                </h1>
                <span class="sr" id="dpick-d">
                  Choose a day to start from
                </span>
              </div>
            </div>
            <a class="enc" href="#settings/privacy">
              <Icon name="lock" size={14} />
              Encrypted
            </a>
          </header>
          <div class="vswitch-row">
            <ViewSwitch />
            <FilterButton />
          </div>
          <Filters />
        </>
      ) : (
        // Week and month need the height for the calendar: the switch says which view this is.
        <header class="vhead compact">
          <h1 class="sr">{mode === 'week' ? 'Week' : 'Month'}</h1>
          <ViewSwitch />
          <FilterButton />
          <a class="enc" href="#settings/privacy" aria-label="Encrypted">
            <Icon name="lock" size={14} />
            <span class="enc-t">Encrypted</span>
          </a>
        </header>
      )}
      {mode !== 'agenda' && <Filters />}
      {pickerOpen.value && (
        <DatePicker
          value={from}
          onPick={(d) => {
            agendaStart.value = d === t ? null : d;
            weeks.value = 1;
            pickerOpen.value = false;
          }}
          onClose={() => {
            pickerOpen.value = false;
          }}
        />
      )}
    </>
  );
  if (mode !== 'agenda') {
    return (
      <>
        {header}
        <WhatsNew compact />
        {mode === 'week' ? <WeekView /> : <MonthView />}
        <MarkerKey names={names.value} />
      </>
    );
  }
  const days = shownDays(agendaFrom(from, 7 * weeks.value), hidden.value);
  const cds = countdowns.value;
  return (
    <>
      {header}
      <WhatsNew />
      <div class="plan-grid">
        <div class="plan-side">
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrolling region must be keyboard-focusable (WCAG 2.1.1, axe scrollable-region-focusable) */}
          <section class="cd-wrap" aria-label="Countdowns" tabIndex={0}>
            <ul class="cd">
              {(allMilestones.value ? cds : cds.slice(0, MILESTONES_SHOWN)).map((c) => (
                <li key={c.id}>
                  <button type="button" class="cd-item" onClick={() => openEvent(c.id)}>
                    <span class="cd-n">{c.days}</span>
                    <span class="cd-l">
                      {c.days === 1 ? 'day' : 'days'} to
                      <br />
                      <b>{c.title}</b>
                    </span>
                  </button>
                </li>
              ))}
              {cds.length > MILESTONES_SHOWN && (
                <li>
                  <button
                    type="button"
                    class="cd-item cd-more"
                    aria-expanded={allMilestones.value}
                    onClick={() => {
                      allMilestones.value = !allMilestones.value;
                    }}
                  >
                    <span class="cd-l">
                      {allMilestones.value
                        ? 'Fewer milestones'
                        : `${cds.length - MILESTONES_SHOWN} more milestones`}
                    </span>
                  </button>
                </li>
              )}
              <li>
                <button
                  type="button"
                  class="cd-item cd-add"
                  onClick={() =>
                    openPlanForm(null, {
                      owner: 'both',
                      all_day: true,
                      start: addDays(t, 30),
                      end: addDays(t, 31),
                      countdown: true,
                    })
                  }
                >
                  <Icon name="plus" size={18} />
                  <span class="cd-l">
                    {cds.length
                      ? 'Add a milestone'
                      : 'Count down to something: a trip, a birthday, a big day'}
                  </span>
                </button>
              </li>
            </ul>
          </section>
          <SideCards />
        </div>
        <div class="plan-main">
          {/* A couple of questions in full, then one line: they don't push
              today off the screen (review 0009, P-2). */}
          {awaitingMe.value.slice(0, ASKS_SHOWN).map((e) => (
            <AskCard key={e.id} id={e.id} />
          ))}
          {awaitingMe.value.length > ASKS_SHOWN && (
            <a class="asks-more" href="#inbox">
              <Icon name="inbox" size={16} />
              <span>
                {awaitingMe.value.length - ASKS_SHOWN} more{' '}
                {awaitingMe.value.length - ASKS_SHOWN === 1 ? 'needs' : 'need'} your answer
              </span>
              <span class="free-cta">Go through</span>
            </a>
          )}
          <div class="agenda">
            <button
              type="button"
              class="linkbtn earlier"
              onClick={() => {
                agendaStart.value = addDays(from, -7);
                weeks.value = Math.min(MAX_WEEKS, weeks.value + 1);
              }}
            >
              <Icon name="up" size={14} />
              Show earlier days
            </button>
            {days.map((day, i) => {
              const isToday = day.date === t;
              // Routines fold away on a full day (P-10); clashes and away days stay shown.
              const routines = day.rows.filter(
                (r) => r.repeat && !r.allDay && !day.clash.has(r.key) && r.status === 'confirmed',
              );
              const fold = routines.length >= FOLD_ROUTINES && !routinesOpen.value.has(day.date);
              const rows = fold ? day.rows.filter((r) => !routines.includes(r)) : day.rows;
              return (
                <>
                  {i > 0 && i % 7 === 0 && (
                    <h2 class="wk" key={`wk-${day.date}`}>
                      {from === t && i === 7 ? 'Next week' : `Week of ${fmtLong(day.date)}`}
                    </h2>
                  )}
                  <section
                    class={`day${isToday ? ' today' : ''}`}
                    aria-label={isToday ? `Today, ${fmtLong(day.date)}` : fmtLong(day.date)}
                    key={day.date}
                  >
                    <div class="dhead" aria-hidden="true">
                      <span class="dow">{isToday ? 'Today' : dowShort(day.date)}</span>
                      <span class="dnum">{dayNum(day.date)}</span>
                    </div>
                    <div class="dlist">
                      {rows.map((row) => (
                        <EventRow
                          key={row.key}
                          row={row}
                          date={day.date}
                          clash={day.clash.has(row.key)}
                          dim={routineWhileAway(row, day)}
                        />
                      ))}
                      {fold && (
                        <button
                          type="button"
                          class="linkbtn routines"
                          onClick={() => {
                            routinesOpen.value = new Set([...routinesOpen.value, day.date]);
                          }}
                        >
                          <Icon name="repeat" size={14} />+{routines.length} routines:{' '}
                          {routines
                            .slice(0, 3)
                            .map((r) => r.title)
                            .join(', ')}
                          {routines.length > 3 ? '…' : ''}
                        </button>
                      )}
                      {!day.rows.length && !day.bothFree && <p class="nothing">Nothing planned</p>}
                      {day.bothFree && (
                        <button type="button" class="free" onClick={() => openFreeTime(day.date)}>
                          <Marker owner="both" mode="dash" />
                          {isToday ? 'Both free tonight' : 'Both free this evening'}
                          <span class="free-cta">Plan something</span>
                        </button>
                      )}
                    </div>
                  </section>
                </>
              );
            })}
          </div>
          {weeks.value < MAX_WEEKS && (
            <>
              <button
                type="button"
                class="btn more"
                onClick={() => {
                  weeks.value = Math.min(MAX_WEEKS, weeks.value + 1);
                }}
              >
                Show next week
              </button>
              {weeks.value > 1 && <MoreWhenSeen />}
            </>
          )}
          <MarkerKey names={names.value} />
        </div>
      </div>
    </>
  );
}
