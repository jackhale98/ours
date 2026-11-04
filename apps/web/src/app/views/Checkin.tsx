// SPDX-License-Identifier: AGPL-3.0-or-later
import { CHECKIN_STEPS } from '@ours/core/schema';
import { addDays } from '@ours/core/time';
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { checkinLists, ideasList, itemsOf, memoryToRecall } from '../lists';
import { byKind, createEvent, nameOf, partner, put, type Slot, settings, viewer } from '../model';
import { noticeProposal } from '../notices';
import { withDefaultReminders } from '../reminders';
import { agenda, type Day, dow, fmtLong, freeEvenings, relDay, today, zone } from '../select';
import { Icon, Marker, toast } from '../ui';
import { ItemRow, planIdea } from './Lists';
import { EventRow } from './Plan';

interface Draft {
  done: boolean[];
  note: string;
  date: string | null;
  idea: string | null;
  /** What to do, typed, when there's no list of ideas to pick from. */
  what?: string;
}
const DRAFT_KEY = 'ours-checkin-draft';
function loadDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null;
    if (d && Array.isArray(d.done)) return d;
  } catch {
    // ignore
  }
  return { done: [false, false, false, false], note: '', date: null, idea: null };
}
const draft = signal<Draft>(loadDraft());
function setDraft(patch: Partial<Draft>) {
  draft.value = { ...draft.value, ...patch };
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
  } catch {
    // ignore
  }
}

function toggleStep(i: number) {
  const done = [...draft.value.done];
  done[i] = !done[i];
  setDraft({ done });
}

function Step({ i, title, children }: { i: number; title: string; children: ComponentChildren }) {
  const ok = draft.value.done[i];
  return (
    <li class={`step${ok ? ' ok' : ''}`}>
      <div class="step-h">
        <span class="num" aria-hidden="true">
          {ok ? <Icon name="check" size={15} /> : i + 1}
        </span>
        <h2 class="h3">
          {title}
          {ok && <span class="sr"> (done)</span>}
        </h2>
        <button
          type="button"
          class={`btn sm${ok ? ' ghost' : ''}`}
          aria-label={`${ok ? 'Reopen' : 'Done'}: ${title}`}
          onClick={() => toggleStep(i)}
        >
          {ok ? 'Reopen' : 'Done'}
        </button>
      </div>
      {!ok && children}
    </li>
  );
}

/** The week's plans for one owner, by day: what a count above stands for. */
function WeekList({ days, owner, empty }: { days: Day[]; owner: Slot | 'both'; empty: string }) {
  const shown = days
    .map((day) => ({ day, rows: day.rows.filter((r) => r.owner === owner) }))
    .filter((d) => d.rows.length);
  return (
    <div class="weeklist">
      {shown.length ? (
        shown.map(({ day, rows }) => (
          <section key={day.date} aria-label={fmtLong(day.date)}>
            <h3 class="sublbl">{relDay(day.date)}</h3>
            <div class="dlist">
              {rows.map((row) => (
                <EventRow key={row.key} row={row} date={day.date} />
              ))}
            </div>
          </section>
        ))
      ) : (
        <p class="nothing">{empty}</p>
      )}
      <a class="linkbtn" href="#plan/week">
        See the whole week
      </a>
    </div>
  );
}

export function CheckinView() {
  const [show, setShow] = useState<'me' | 'partner' | 'both' | null>(null);
  const me = viewer.value;
  const p = partner.value;
  const d = draft.value;
  const t = today.value;

  const week = agenda(7);
  const rows = week.flatMap((day) => day.rows);
  const count = (owner: string) =>
    new Set(rows.filter((r) => r.owner === owner).map((r) => r.key)).size;
  const busiest = [...week].sort((a, b) => b.rows.length - a.rows.length)[0];
  const toAnswer = byKind('event').filter(
    (e) =>
      e.rec.kind === 'event' && e.rec.data.status === 'proposed' && e.rec.data.proposed_by === p,
  ).length;

  // Open items from every shared list that's part of the check-in, grouped by list.
  const shareLists = checkinLists(settings.value.chores_list)
    .map((l) => ({ list: l, items: itemsOf(l.id).filter((i) => !i.rec.data.done) }))
    .filter((g) => g.items.length);
  const chores = shareLists.flatMap((g) => g.items);

  const frees = freeEvenings(7);
  const date = d.date && frees.includes(d.date) ? d.date : (frees[0] ?? null);
  const ideaList = ideasList();
  const ideas = ideaList ? itemsOf(ideaList.id).slice(0, 6) : [];
  const idea = ideas.find((i) => i.id === d.idea) ?? ideas[0];
  const recall = memoryToRecall();

  const checkins = byKind('checkin')
    .flatMap((c) => (c.rec.kind === 'checkin' ? [c.rec.data] : []))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const last = checkins[0];
  const partnerNote = checkins.find((c) => c.author === p && c.note);
  const nextSunday = addDays(t, (7 - dow(t)) % 7 || 7);
  const doneCount = d.done.filter(Boolean).length;

  return (
    <>
      <header class="vhead">
        <div>
          <p class="eyebrow">
            {last ? `Last one ${fmtLong(last.date)} · ` : ''}next {fmtLong(nextSunday)}
          </p>
          <h1>Weekly check-in</h1>
        </div>
      </header>
      <p class="lede">
        Ten minutes, side by side, to get on the same page before the week runs you.
      </p>
      {partnerNote?.note && (
        <section class="picked" aria-label={`Note from ${nameOf(p)}`}>
          <p class="eyebrow">
            {nameOf(p)}’s note · {fmtLong(partnerNote.date)}
          </p>
          <p>{partnerNote.note}</p>
        </section>
      )}
      <div
        class="prog"
        role="progressbar"
        aria-label="Check-in progress"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={doneCount}
        aria-valuetext={`${doneCount} of 4 steps done`}
      >
        {d.done.map((on, i) => (
          <i key={CHECKIN_STEPS[i]} class={on ? 'on' : ''} />
        ))}
      </div>
      <ol class="steps">
        <Step i={0} title="Look at the week ahead">
          {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the grid layout */}
          <div class="stats" role="group" aria-label="Show plans">
            {(
              [
                ['me', me, 'Your plans'],
                ['partner', p, `${nameOf(p)}’s`],
                ['both', 'both', 'Together'],
              ] as const
            ).map(([key, owner, label]) => (
              <button
                type="button"
                class="stat"
                key={key}
                aria-pressed={show === key}
                onClick={() => setShow(show === key ? null : key)}
              >
                <b>{count(owner)}</b>
                <span>
                  <Marker owner={owner} />
                  {label}
                </span>
              </button>
            ))}
          </div>
          {show && (
            <WeekList
              days={week}
              owner={show === 'me' ? me : show === 'partner' ? p : 'both'}
              empty={
                show === 'me'
                  ? 'Nothing of yours this week.'
                  : show === 'partner'
                    ? `Nothing of ${nameOf(p)}’s this week.`
                    : 'Nothing planned together yet. Step 3 can fix that.'
              }
            />
          )}
          <p class="lede small">
            {busiest && busiest.rows.length > 0 && (
              <>
                Busiest day: <b class="ink">{relDay(busiest.date)}</b>.{' '}
              </>
            )}
            {toAnswer ? (
              <a class="linkbtn" href="#inbox">
                {toAnswer} plan{toAnswer > 1 ? 's need' : ' needs'} your answer
              </a>
            ) : (
              'Nothing waiting on you.'
            )}
          </p>
        </Step>
        <Step i={1} title="Share out what needs doing">
          {chores.length ? (
            <>
              <p class="lede small">
                Tap a circle to give each one an owner. Things nobody owns tend to wait.
              </p>
              {shareLists.map((g) => (
                <div key={g.list.id}>
                  {shareLists.length > 1 && <p class="sublbl">{g.list.rec.data.name}</p>}
                  <ul class="items">
                    {g.items.map((i) => (
                      <ItemRow key={i.id} item={i} list={g.list} assign />
                    ))}
                  </ul>
                </div>
              ))}
            </>
          ) : checkinLists(settings.value.chores_list).length ? (
            <p class="nothing">Nothing open on your check-in lists. Nice.</p>
          ) : (
            <p class="nothing">
              No lists are part of the check-in yet. Turn on “Part of the weekly check-in” on a
              shared list in Lists.
            </p>
          )}
        </Step>
        <Step i={2} title="Plan time together">
          {recall && (
            <p class="note recall">
              <Icon name="star" size={15} />
              <span>
                {recall.date
                  ? `About a month ago you did “${recall.item.rec.data.text}”.`
                  : `A favourite: “${recall.item.rec.data.text}”.`}{' '}
                <button
                  type="button"
                  class="linkbtn"
                  onClick={() => planIdea(recall.item.rec.data.text)}
                >
                  Do it again
                </button>
              </span>
            </p>
          )}
          {frees.length ? (
            <>
              <span class="sublbl" id="ci-dates">
                Evenings you’re both free
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
              <div class="chips" role="group" aria-labelledby="ci-dates">
                {frees.map((s) => (
                  <button
                    type="button"
                    class="chip"
                    key={s}
                    aria-pressed={s === date}
                    onClick={() => setDraft({ date: s })}
                  >
                    {relDay(s)}
                  </button>
                ))}
              </div>
              {idea ? (
                <>
                  <span class="sublbl" id="ci-ideas">
                    Do what?
                  </span>
                  {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
                  <div class="chips" role="group" aria-labelledby="ci-ideas">
                    {ideas.map((i) => (
                      <button
                        type="button"
                        class="chip"
                        key={i.id}
                        aria-pressed={i.id === idea.id}
                        onClick={() => setDraft({ idea: i.id })}
                      >
                        {i.rec.data.text}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div class="field">
                  <label for="ci-what">Do what?</label>
                  <input
                    id="ci-what"
                    class="txt"
                    maxLength={120}
                    placeholder="Dinner out, a walk, a film…"
                    value={d.what ?? ''}
                    onInput={(e) => setDraft({ what: e.currentTarget.value })}
                  />
                  <p class="small muted">
                    Keep a list of date ideas in Lists and you can pick from it here.
                  </p>
                </div>
              )}
              <div>
                <button
                  type="button"
                  class="btn primary"
                  onClick={() => {
                    if (!date) return;
                    const title = (idea ? idea.rec.data.text : d.what?.trim()) || 'Time together';
                    const id = createEvent(
                      withDefaultReminders(
                        {
                          title,
                          start: `${date}T19:00`,
                          end: `${date}T21:00`,
                          all_day: false,
                          tz: zone,
                          rrule: null,
                          away: false,
                          owner: 'both',
                          status: 'proposed',
                          proposed_by: me,
                          privacy: 'full',
                          location: null,
                          notes: null,
                          countdown: false,
                          stub_id: null,
                        },
                        me,
                      ),
                    );
                    noticeProposal(id);
                    const done = [...d.done];
                    done[2] = true;
                    setDraft({ done });
                  }}
                >
                  Ask {nameOf(p)} · {date ? relDay(date) : ''} 7 PM
                </button>
              </div>
            </>
          ) : (
            <p class="nothing">
              No shared free evenings this week. Try next week, or trade something off.
            </p>
          )}
        </Step>
        <Step i={3} title="Anything on your mind?">
          <textarea
            class="txt"
            value={d.note}
            onInput={(e) => setDraft({ note: e.currentTarget.value })}
            placeholder="Something you’re looking forward to, worried about, or want help with."
            aria-label={`Note for ${nameOf(p)}`}
          />
          <p class="lede small">
            {nameOf(p)} sees this when you finish. Encrypted like everything else.
          </p>
        </Step>
      </ol>
      <div class="finish">
        <button
          type="button"
          class="btn primary"
          disabled={doneCount < 4}
          onClick={() => {
            put('checkin', {
              date: t,
              author: me,
              steps_done: [...CHECKIN_STEPS],
              note: d.note.trim() || null,
            });
            setDraft({
              done: [false, false, false, false],
              note: '',
              date: null,
              idea: null,
              what: '',
            });
            window.scrollTo(0, 0);
            toast(`Check-in saved. ${nameOf(p)} can see your note.`);
          }}
        >
          Finish check-in
        </button>
        <span class="lede small" aria-live="polite">
          {doneCount < 4
            ? `${4 - doneCount} step${4 - doneCount > 1 ? 's' : ''} to go`
            : 'All set.'}
        </span>
      </div>
    </>
  );
}
