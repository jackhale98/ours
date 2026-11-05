// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Waiting on you: one thing at a time, with the choices for it, then the
 * next. "Skip for now" moves on without answering; the full list underneath
 * jumps to any item. Each answer is undoable from its toast.
 */

import type { Reaction } from '@ours/core/schema';
import { addDays } from '@ours/core/time';
import { useEffect, useRef, useState } from 'preact/hooks';
import { putRecallAside, type Waiting, waiting } from '../inbox';
import { PartnerInvite } from '../invite';
import { itemSheet } from '../itemsheet';
import {
  completeItem,
  completeItems,
  currentList,
  didIt,
  dueText,
  type ItemEntry,
  react,
  setArchived,
} from '../lists';
import { commentsFor, deleteEvent, findEntry, nameOf, partner, update, viewer } from '../model';
import { noticeProposal } from '../notices';
import { relDay, repeatText, today, whenText } from '../select';
import { accept, decline, openEvent } from '../sheets';
import { Icon, Marker, toast } from '../ui';

function eventWhen(d: { start: string; end: string; all_day: boolean; location: string | null }) {
  return (
    whenText(d.start.slice(0, 10), d.all_day, d.start.slice(11), d.end.slice(11)) +
    (d.location ? ` · ${d.location}` : '')
  );
}

/** One line for the overview list. */
function summary(w: Waiting): { title: string; why: string } {
  const p = nameOf(partner.value);
  if (w.kind === 'invite') return { title: 'Invite your partner', why: 'They haven’t joined yet' };
  if (w.kind === 'task') {
    const d = w.item.rec.data;
    return {
      title: d.text,
      why: `${dueText(d.due ?? today.value).text}${d.assignee ? '' : ' · nobody’s on it'}`,
    };
  }
  if (w.kind === 'overdue')
    return {
      title: `${w.items.length} overdue on ${w.list.rec.data.name}`,
      why: w.items
        .slice(0, 3)
        .map((i) => i.rec.data.text)
        .join(', '),
    };
  if (w.kind === 'archive')
    return { title: `Archive “${w.list.rec.data.name}”?`, why: `${w.plan} is over` };
  if (w.kind === 'recall')
    return {
      title: `How was “${w.item.rec.data.text}”?`,
      why: `You planned it · ${relDay(w.date)}`,
    };
  if (w.entry.rec.kind !== 'event') return { title: '', why: '' };
  const d = w.entry.rec.data;
  return {
    title: d.title,
    why: w.kind === 'ask' ? `${p} asked · ${relDay(d.start.slice(0, 10))}` : `${p} can’t make it`,
  };
}

function Current({ w, headRef }: { w: Waiting; headRef: { current: HTMLHeadingElement | null } }) {
  const me = viewer.value;
  const p = partner.value;
  if (w.kind === 'invite') {
    return (
      <>
        <p class="eyebrow">Nobody to plan with yet</p>
        <h2 class="h3" id="wo-title" tabIndex={-1} ref={headRef}>
          Invite your partner
        </h2>
        <PartnerInvite />
      </>
    );
  }
  if (w.kind === 'overdue') return <Overdue w={w} headRef={headRef} />;
  if (w.kind === 'recall') return <Recall w={w} headRef={headRef} />;
  if (w.kind === 'archive')
    return (
      <>
        <p class="eyebrow">{w.plan} is over</p>
        <h2 class="h3" id="wo-title" tabIndex={-1} ref={headRef}>
          Archive “{w.list.rec.data.name}”?
        </h2>
        <p class="ask-when">
          It leaves your lists but stays in search, and can come back any time.
        </p>
        <div class="ask-actions">
          <button
            type="button"
            class="btn primary"
            onClick={() =>
              toast(`Archived “${w.list.rec.data.name}”.`, setArchived(w.list.id, true))
            }
          >
            <Icon name="archive" size={16} />
            Archive it
          </button>
          <button
            type="button"
            class="btn ghost"
            onClick={() => toast('Kept with your lists.', putRecallAside(w.id))}
          >
            Keep it
          </button>
        </div>
      </>
    );
  if (w.kind === 'task') {
    const d = w.item.rec.data;
    const due = dueText(d.due ?? today.value);
    const shared = w.item.scope === 'space';
    return (
      <>
        <p class={`eyebrow${due.late ? ' late' : ''}`}>
          {due.text} · {w.list.rec.data.name}
        </p>
        <h2 class="h3" id="wo-title" tabIndex={-1} ref={headRef}>
          {d.text}
        </h2>
        <p class="ask-when">
          {shared ? (d.assignee ? 'You’re on it.' : 'Nobody’s on it yet.') : 'Just for you.'}
          {d.repeat && (
            <>
              {' '}
              <Icon name="repeat" size={13} /> {repeatText(d.repeat)}
              {d.rotate ? ', taking turns' : ''}.
            </>
          )}
        </p>
        <div class="ask-actions">
          <button
            type="button"
            class="btn primary"
            onClick={() => {
              const { undo, next } = completeItem(w.item);
              toast(next ? `Done. Next: ${relDay(next)}.` : 'Done.', undo);
            }}
          >
            <Icon name="check" size={16} />
            Done
          </button>
          {shared && !d.assignee && (
            <button
              type="button"
              class="btn"
              onClick={() => {
                update<'item'>(w.item.id, { assignee: me });
                toast('It’s yours.', () => update<'item'>(w.item.id, { assignee: null }));
              }}
            >
              I’ll do it
            </button>
          )}
          {shared && (
            <button
              type="button"
              class="btn"
              onClick={() => {
                const before = d.assignee;
                update<'item'>(w.item.id, { assignee: p });
                toast(`Passed to ${nameOf(p)}.`, () =>
                  update<'item'>(w.item.id, { assignee: before }),
                );
              }}
            >
              Pass to {nameOf(p)}
            </button>
          )}
          <button
            type="button"
            class="btn ghost"
            onClick={() => {
              const before = d.due;
              const to = addDays(today.value, d.due && d.due > today.value ? 2 : 1);
              update<'item'>(w.item.id, { due: to });
              toast(`Moved to ${relDay(to).toLowerCase()}.`, () =>
                update<'item'>(w.item.id, { due: before }),
              );
            }}
          >
            Later
          </button>
          <button
            type="button"
            class="btn ghost"
            onClick={() => {
              itemSheet.value = w.item.id;
            }}
          >
            Details
          </button>
        </div>
      </>
    );
  }
  if (w.entry.rec.kind !== 'event') return null;
  const d = w.entry.rec.data;
  const from = d.proposed_by ?? p;
  const note = commentsFor(w.id).find(
    (c) => c.rec.kind === 'comment' && c.rec.data.author === from,
  );
  if (w.kind === 'ask') {
    return (
      <>
        <p class="eyebrow">
          <Marker owner={d.owner} mode="dash" /> {nameOf(from)} asked · needs your answer
        </p>
        <h2 class="h3" id="wo-title" tabIndex={-1} ref={headRef}>
          {d.title}
        </h2>
        <p class="ask-when">{eventWhen(d)}</p>
        {note?.rec.kind === 'comment' && <p class="ask-note">{note.rec.data.text}</p>}
        <div class="ask-actions">
          <button type="button" class="btn primary" onClick={() => accept(w.id)}>
            <Icon name="check" size={16} />
            Yes, add it
          </button>
          <button type="button" class="btn" onClick={() => decline(w.id)}>
            Can’t make it
          </button>
          <button type="button" class="btn ghost" onClick={() => openEvent(w.id)}>
            Reply or see details
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <p class="eyebrow">{nameOf(p)} can’t make it</p>
      <h2 class="h3" id="wo-title" tabIndex={-1} ref={headRef}>
        {d.title}
      </h2>
      <p class="ask-when">{eventWhen(d)}</p>
      <p class="small muted">Ask again, or take it off your plan.</p>
      <div class="ask-actions">
        <button
          type="button"
          class="btn primary"
          onClick={() => {
            update<'event'>(w.id, { status: 'proposed' });
            noticeProposal(w.id);
            toast(`Asked ${nameOf(p)} again.`, () => update<'event'>(w.id, { status: 'declined' }));
          }}
        >
          Ask again
        </button>
        <button
          type="button"
          class="btn"
          onClick={() => {
            toast('Removed.', deleteEvent(w.id));
          }}
        >
          Remove it
        </button>
        <button type="button" class="btn ghost" onClick={() => openEvent(w.id)}>
          See details
        </button>
      </div>
    </>
  );
}

type Head = { current: HTMLHeadingElement | null };

/** Several overdue on one list: open the list, or tick them all off (L-12). */
function Overdue({ w, headRef }: { w: Extract<Waiting, { kind: 'overdue' }>; headRef: Head }) {
  const shown = w.items.slice(0, 6);
  return (
    <>
      <p class="eyebrow late">Overdue · {w.list.rec.data.name}</p>
      <h2 class="h3" id="wo-title" tabIndex={-1} ref={headRef}>
        {w.items.length} overdue on {w.list.rec.data.name}
      </h2>
      <ul class="wo-items">
        {shown.map((i) => (
          <li key={i.id}>
            {i.rec.data.text}
            <span class="small muted"> · {dueText(i.rec.data.due ?? today.value).text}</span>
          </li>
        ))}
        {w.items.length > shown.length && (
          <li class="small muted">and {w.items.length - shown.length} more</li>
        )}
      </ul>
      <div class="ask-actions">
        <button
          type="button"
          class="btn primary"
          onClick={() => {
            currentList.value = w.list.id;
            location.hash = 'lists';
          }}
        >
          Open the list
        </button>
        <button
          type="button"
          class="btn"
          onClick={() => {
            const r = completeItems(
              w.items.map((i) => i.id),
              false,
            );
            toast(`Ticked off ${r.changed}.`, r.undo);
          }}
        >
          <Icon name="check" size={16} />
          All done
        </button>
      </div>
    </>
  );
}

const REACTIONS: [Reaction, string][] = [
  ['loved', 'Loved it'],
  ['good', 'Good'],
  ['meh', 'Meh'],
];

/** A planned idea has happened: how was it? Noted as a memory on the idea (L-10). */
function Recall({ w, headRef }: { w: Extract<Waiting, { kind: 'recall' }>; headRef: Head }) {
  const me = viewer.value;
  const d = w.item.rec.data;
  const say = (r: Reaction) => {
    const undo = didIt(w.item, w.date);
    const fresh = findEntry(w.item.id) as ItemEntry | undefined;
    const at = (fresh?.rec.data.did ?? []).length - 1;
    if (fresh && at >= 0) react(fresh, at, me, r);
    toast(`Saved to “${d.text}”.`, undo);
  };
  return (
    <>
      <p class="eyebrow">You planned it · {relDay(w.date)}</p>
      <h2 class="h3" id="wo-title" tabIndex={-1} ref={headRef}>
        How was “{d.text}”?
      </h2>
      <div class="ask-actions">
        {REACTIONS.map(([r, label]) => (
          <button type="button" class="btn" key={r} onClick={() => say(r)}>
            {label}
          </button>
        ))}
        <button
          type="button"
          class="btn ghost"
          onClick={() => toast('Put aside.', putRecallAside(`${w.item.id}:${w.date}`))}
        >
          We didn’t go
        </button>
      </div>
    </>
  );
}

export function InboxView() {
  const all = waiting.value;
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  // The one to show: the picked one if it's still waiting, else the first not skipped.
  const queue = [
    ...all.filter((w) => !skipped.includes(w.id)),
    ...all.filter((w) => skipped.includes(w.id)),
  ];
  const cur = all.find((w) => w.id === pickedId) ?? queue[0];
  const pos = cur ? all.indexOf(cur) : -1;
  const head = useRef<HTMLHeadingElement>(null);
  const shown = useRef<string | null>(null);
  // After an answer, the next item takes its place: move focus to it.
  useEffect(() => {
    const id = cur?.id ?? null;
    if (shown.current !== null && shown.current !== id) head.current?.focus();
    shown.current = id;
  }, [cur?.id]);

  return (
    <>
      <header class="vhead">
        <div>
          <p class="eyebrow">
            {all.length
              ? `${all.length} ${all.length === 1 ? 'thing' : 'things'} for you`
              : 'All clear'}
          </p>
          <h1>Waiting on you</h1>
        </div>
      </header>
      {cur ? (
        <>
          <section class="ask wo-card" aria-labelledby="wo-title">
            <p class="wo-step" aria-live="polite">
              {pos + 1} of {all.length}
            </p>
            <Current w={cur} headRef={head} />
          </section>
          {all.length > 1 && (
            <div class="wo-nav">
              <button
                type="button"
                class="btn sm ghost"
                onClick={() => {
                  setSkipped([...skipped.filter((x) => x !== cur.id), cur.id]);
                  const rest = all.filter((w) => w.id !== cur.id && !skipped.includes(w.id));
                  setPickedId(rest[0]?.id ?? all[(pos + 1) % all.length]?.id ?? null);
                }}
              >
                Skip for now
                <Icon name="next" size={15} />
              </button>
            </div>
          )}
          <section class="wo-all" aria-labelledby="wo-all-h">
            <h2 class="sublbl" id="wo-all-h">
              Everything waiting
            </h2>
            <ul>
              {all.map((w) => {
                const s = summary(w);
                return (
                  <li key={w.id}>
                    <button
                      type="button"
                      class="wo-row"
                      aria-current={w.id === cur.id ? 'step' : undefined}
                      onClick={() => setPickedId(w.id)}
                    >
                      <Icon
                        name={
                          w.kind === 'task' || w.kind === 'overdue'
                            ? 'list'
                            : w.kind === 'archive'
                              ? 'archive'
                              : w.kind === 'recall'
                                ? 'heart'
                                : w.kind === 'ask'
                                  ? 'chat'
                                  : w.kind === 'invite'
                                    ? 'send'
                                    : 'x'
                        }
                        size={16}
                      />
                      <span>
                        <b>{s.title}</b>
                        <span class="small muted">{s.why}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      ) : (
        <section class="wo-done">
          <span class="wo-tick" aria-hidden="true">
            <Icon name="check" size={28} />
          </span>
          <h2 class="h3">Nothing’s waiting on you</h2>
          <p class="lede small">
            Plans {nameOf(partner.value)} asks about, and your tasks that are due, will show up
            here.
          </p>
          <a class="btn" href="#plan">
            Back to your plan
          </a>
        </section>
      )}
    </>
  );
}
