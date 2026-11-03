// SPDX-License-Identifier: AGPL-3.0-or-later
import { CHECKIN_STEPS } from '@ours/core/schema';
import { addDays } from '@ours/core/time';
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { choresList, ideasList, itemsOf } from '../lists';
import { byKind, createEvent, nameOf, partner, put, settings, viewer } from '../model';
import { noticeProposal } from '../notices';
import { agenda, dow, fmtLong, freeEvenings, relDay, today, zone } from '../select';
import { Icon, Marker, toast } from '../ui';
import { ItemRow } from './Lists';

interface Draft {
  done: boolean[];
  note: string;
  date: string | null;
  idea: string | null;
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

export function CheckinView() {
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

  const chores = (() => {
    const list = choresList(settings.value.chores_list);
    return list ? itemsOf(list.id).filter((i) => !i.rec.data.done) : [];
  })();

  const frees = freeEvenings(7);
  const date = d.date && frees.includes(d.date) ? d.date : (frees[0] ?? null);
  const ideaList = ideasList();
  const ideas = ideaList ? itemsOf(ideaList.id).slice(0, 6) : [];
  const idea = ideas.find((i) => i.id === d.idea) ?? ideas[0];

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
          <div class="stats">
            <div class="stat">
              <b>{count(me)}</b>
              <span>
                <Marker owner={me} />
                Your plans
              </span>
            </div>
            <div class="stat">
              <b>{count(p)}</b>
              <span>
                <Marker owner={p} />
                {nameOf(p)}’s
              </span>
            </div>
            <div class="stat">
              <b>{count('both')}</b>
              <span>
                <Marker owner="both" />
                Together
              </span>
            </div>
          </div>
          <p class="lede small">
            {busiest && busiest.rows.length > 0 && (
              <>
                Busiest day: <b class="ink">{relDay(busiest.date)}</b>.{' '}
              </>
            )}
            {toAnswer ? (
              <a class="linkbtn" href="#plan">
                {toAnswer} plan{toAnswer > 1 ? 's need' : ' needs'} your answer
              </a>
            ) : (
              'Nothing waiting on you.'
            )}
          </p>
        </Step>
        <Step i={1} title="Share out the chores">
          {chores.length ? (
            <>
              <p class="lede small">
                Tap a circle to give each one an owner. Unowned chores tend to wait.
              </p>
              <ul class="items">
                {chores.map((i) => (
                  <ItemRow key={i.id} item={i} assignable />
                ))}
              </ul>
            </>
          ) : (
            <p class="nothing">No open chores. Nice.</p>
          )}
        </Step>
        <Step i={2} title="Plan time together">
          {frees.length && idea ? (
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
              <div>
                <button
                  type="button"
                  class="btn primary"
                  onClick={() => {
                    if (!date) return;
                    const id = createEvent({
                      title: idea.rec.data.text,
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
                    });
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
            setDraft({ done: [false, false, false, false], note: '', date: null, idea: null });
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
