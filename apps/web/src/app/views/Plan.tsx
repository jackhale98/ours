// SPDX-License-Identifier: AGPL-3.0-or-later

import { addDays } from '@ours/core/time';
import { signal } from '@preact/signals';
import { commentsFor, nameOf, partner, viewer } from '../model';
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
import { accept, decline, openEvent, openQuick } from '../sheets';
import { Icon, Marker } from '../ui';

const weeks = signal<1 | 2>(1);

function EventRow({ row }: { row: Row }) {
  const me = viewer.value;
  const p = partner.value;
  const masked = row.type === 'busy';
  const mode = masked ? 'busy' : row.status === 'proposed' ? 'dash' : undefined;
  const labelNames = { a: nameOf('a'), b: nameOf('b') };
  return (
    <button
      type="button"
      class={`ev${masked ? ' is-masked' : ''}`}
      onClick={() => openEvent(row.id)}
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
        </span>
        <span class="ev-title">{row.title}</span>
        {!masked && (
          <span class="ev-meta">
            {row.status === 'proposed' && (
              <span class="tag">
                {row.proposedBy === me ? `Waiting on ${nameOf(p)}` : 'Needs your answer'}
              </span>
            )}
            {row.away && row.allDay && <span>Away</span>}
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
                {row.repeat}
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

export function PlanView() {
  const t = today.value;
  const days = agenda(7 * weeks.value);
  const cds = countdowns.value;
  return (
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
      {cds.length > 0 && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrolling region must be keyboard-focusable (WCAG 2.1.1, axe scrollable-region-focusable)
        <section class="cd-wrap" aria-label="Countdowns" tabIndex={0}>
          <ul class="cd">
            {cds.map((c) => (
              <li class="cd-item" key={c.id}>
                <span class="cd-n">{c.days}</span>
                <span class="cd-l">
                  {c.days === 1 ? 'day' : 'days'} to
                  <br />
                  <b>{c.title}</b>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
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
                  <EventRow key={row.key} row={row} />
                ))}
                {!day.rows.length && !day.bothFree && <p class="nothing">Nothing planned</p>}
                {day.bothFree && (
                  <button
                    type="button"
                    class="free"
                    onClick={() =>
                      openQuick({
                        date: day.date,
                        time: '19:00',
                        who: 'ours',
                        placeholder: 'Date night',
                      })
                    }
                  >
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
    </>
  );
}
