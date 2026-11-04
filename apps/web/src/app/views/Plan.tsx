// SPDX-License-Identifier: AGPL-3.0-or-later

import { addDays } from '@ours/core/time';
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { tasksFor, waiting } from '../inbox';
import { itemSheet } from '../itemsheet';
import { dueOf, dueText } from '../lists';
import { commentsFor, nameOf, names, partner, viewer } from '../model';
import { markSeen, news } from '../news';
import { planMode } from '../planview';
import {
  agenda,
  awaitingMe,
  countdowns,
  dayNum,
  dowShort,
  fmtLong,
  fmtTime,
  monDay,
  ownerLabel,
  type Row,
  today,
  whenText,
} from '../select';
import { accept, decline, openEvent, openFreeTime, openImport, openPlanForm } from '../sheets';
import { Icon, Marker, MarkerKey } from '../ui';
import { MonthView, ViewSwitch, WeekView } from './Calendar';
import { Result } from './Search';

const weeks = signal<1 | 2>(1);

export function EventRow({ row, date }: { row: Row; date: string }) {
  const me = viewer.value;
  const p = partner.value;
  const masked = row.type === 'busy';
  const mode = masked ? 'busy' : row.status !== 'confirmed' ? 'dash' : undefined;
  const labelNames = { a: nameOf('a'), b: nameOf('b') };
  return (
    <button
      type="button"
      class={`ev${masked ? ' is-masked' : ''}${row.free ? ' is-free' : ''}${row.status === 'declined' ? ' is-declined' : ''}`}
      onClick={() => (row.origin === 'import' ? openImport(row, date) : openEvent(row.id, row.occ))}
    >
      <span class="ev-time">
        {row.allDay ? (
          'All day'
        ) : (
          <>
            {fmtTime(row.start)}
            {row.end !== row.start && <span class="to">{fmtTime(row.end)}</span>}
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
            {row.away && row.allDay && <span>Away</span>}
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
      <p class="eyebrow">{nameOf(from)} asked · needs your answer</p>
      <h2 class="h3" id={titleId}>
        {d.title}
      </h2>
      <p class="ask-when">
        {whenText(d.start.slice(0, 10), d.all_day, d.start.slice(11), d.end.slice(11))}
        {d.location ? ` · ${d.location}` : ''}
      </p>
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
function WhatsNew() {
  const hits = news.value;
  const [all, setAll] = useState(false);
  if (!hits.length) return null;
  const shown = all ? hits : hits.slice(0, 4);
  return (
    <section class="card news" aria-labelledby="news-h">
      <div class="news-head">
        <h2 class="h3" id="news-h">
          New from {nameOf(partner.value)}
        </h2>
        <button type="button" class="linkbtn" onClick={markSeen}>
          Got it
        </button>
      </div>
      <div class="find-group">
        <ul>
          {shown.map((h) => (
            <li key={h.id}>
              <Result hit={h} />
            </li>
          ))}
        </ul>
      </div>
      {hits.length > shown.length && (
        <button type="button" class="linkbtn" onClick={() => setAll(true)}>
          {hits.length - shown.length} more
        </button>
      )}
    </section>
  );
}

export function PlanView() {
  const t = today.value;
  const mode = planMode.value;
  const header = (
    <>
      {mode === 'agenda' ? (
        <>
          <header class="vhead">
            <div>
              <p class="eyebrow">
                {monDay(t)} – {monDay(addDays(t, 6))}
              </p>
              <h1>This week</h1>
            </div>
            <a class="enc" href="#privacy">
              <Icon name="lock" size={14} />
              Encrypted
            </a>
          </header>
          <ViewSwitch />
        </>
      ) : (
        // Week and month need the height for the calendar: the switch says which view this is.
        <header class="vhead compact">
          <h1 class="sr">{mode === 'week' ? 'Week' : 'Month'}</h1>
          <ViewSwitch />
          <a class="enc" href="#privacy" aria-label="Encrypted">
            <Icon name="lock" size={14} />
            <span class="enc-t">Encrypted</span>
          </a>
        </header>
      )}
    </>
  );
  if (mode !== 'agenda') {
    return (
      <>
        {header}
        <WhatsNew />
        {mode === 'week' ? <WeekView /> : <MonthView />}
        <MarkerKey names={names.value} />
      </>
    );
  }
  const days = agenda(7 * weeks.value);
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
              {cds.map((c) => (
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
          {awaitingMe.value.map((e) => (
            <AskCard key={e.id} id={e.id} />
          ))}
          <div class="agenda">
            {days.map((day, i) => (
              <>
                {i === 7 && (
                  <h2 class="wk" key="next">
                    Next week
                  </h2>
                )}
                <section
                  class={`day${i === 0 ? ' today' : ''}`}
                  aria-label={i === 0 ? `Today, ${fmtLong(day.date)}` : fmtLong(day.date)}
                  key={day.date}
                >
                  <div class="dhead" aria-hidden="true">
                    <span class="dow">{i === 0 ? 'Today' : dowShort(day.date)}</span>
                    <span class="dnum">{dayNum(day.date)}</span>
                  </div>
                  <div class="dlist">
                    {day.rows.map((row) => (
                      <EventRow key={row.key} row={row} date={day.date} />
                    ))}
                    {!day.rows.length && !day.bothFree && <p class="nothing">Nothing planned</p>}
                    {day.bothFree && (
                      <button type="button" class="free" onClick={() => openFreeTime(day.date)}>
                        <Marker owner="both" mode="dash" />
                        {i === 0 ? 'Both free tonight' : 'Both free this evening'}
                        <span class="free-cta">Plan something</span>
                      </button>
                    )}
                  </div>
                </section>
              </>
            ))}
          </div>
          <button
            type="button"
            class="btn more"
            onClick={() => {
              weeks.value = weeks.value === 1 ? 2 : 1;
            }}
          >
            {weeks.value === 1 ? 'Show next week' : 'Show less'}
          </button>
          <MarkerKey names={names.value} />
        </div>
      </div>
    </>
  );
}
