// SPDX-License-Identifier: AGPL-3.0-or-later
/** Imported calendars and the calendar feed preview (ADR 0011). */
import { type FeedOccurrence, feedBlocks } from '@ours/core/feed';
import { normalizeFeedUrl } from '@ours/core/ics';
import { signal } from '@preact/signals';
import { useRef, useState } from 'preact/hooks';
import { HAS_API } from '../../config';
import {
  type CalendarEntry,
  importCalendar,
  myCalendars,
  removeCalendar,
  updateCalendar,
} from '../calendars';
import { nameOf, partner, type Slot, viewer } from '../model';
import { sampleWorkIcs } from '../sample-calendar';
import { agenda, fmtLong, today, visibleSnapshots, zone } from '../select';
import { Icon, Marker, toast } from '../ui';

type Who = 'me' | 'ours' | 'partner';
const includePartner = signal(false);

function whoToOwner(who: Who): Slot | 'both' {
  return who === 'me' ? viewer.value : who === 'partner' ? partner.value : 'both';
}
function ownerToWho(owner: Slot | 'both'): Who {
  return owner === 'both' ? 'ours' : owner === viewer.value ? 'me' : 'partner';
}
const whoLabel = (owner: Slot | 'both') =>
  owner === 'both' ? 'Ours' : owner === viewer.value ? 'Mine' : `${nameOf(owner)}’s`;

function WhoPicker({
  value,
  onChange,
  labelId,
}: {
  value: Who;
  onChange: (w: Who) => void;
  labelId: string;
}) {
  const p = partner.value;
  const options: [Who, string, Slot | 'both'][] = [
    ['me', 'Mine', viewer.value],
    ['ours', 'Ours', 'both'],
    ['partner', `${nameOf(p)}’s`, p],
  ];
  return (
    // biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout
    <div class="seg" role="group" aria-labelledby={labelId}>
      {options.map(([key, label, owner]) => (
        <button type="button" key={key} aria-pressed={value === key} onClick={() => onChange(key)}>
          <Marker owner={owner} />
          {label}
        </button>
      ))}
    </div>
  );
}

function SharePicker({
  value,
  onChange,
  labelId,
}: {
  value: 'full' | 'busy';
  onChange: (v: 'full' | 'busy') => void;
  labelId: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout
    <div class="seg two" role="group" aria-labelledby={labelId}>
      <button type="button" aria-pressed={value === 'full'} onClick={() => onChange('full')}>
        Everything
      </button>
      <button type="button" aria-pressed={value === 'busy'} onClick={() => onChange('busy')}>
        Just busy
      </button>
    </div>
  );
}

function CalendarRow({ cal }: { cal: CalendarEntry }) {
  const d = cal.rec.data;
  const p = nameOf(partner.value);
  const id = cal.id;
  return (
    <li class="calrow">
      <div class="calrow-head">
        <Marker owner={d.owner} />
        <span class="stack">
          <b>{d.name}</b>
          <span class="small muted">
            {whoLabel(d.owner)} · {d.url ? 'subscription link' : 'imported file'}
            {d.fetched_at
              ? ` · updated ${fmtLong(new Date(d.fetched_at).toISOString().slice(0, 10))}`
              : ''}
          </span>
        </span>
        <button
          type="button"
          class="iconbtn"
          aria-label={`Remove ${d.name}`}
          onClick={() => toast(`Removed ${d.name}.`, removeCalendar(id))}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <span class="sublbl" id={`who-${id}`}>
        Whose calendar
      </span>
      <WhoPicker
        labelId={`who-${id}`}
        value={ownerToWho(d.owner)}
        onChange={(w) => updateCalendar(id, { owner: whoToOwner(w) })}
      />
      <span class="sublbl" id={`share-${id}`}>
        {p} sees
      </span>
      <SharePicker
        labelId={`share-${id}`}
        value={d.share}
        onChange={(share) => updateCalendar(id, { share })}
      />
    </li>
  );
}

function AddCalendar() {
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [who, setWho] = useState<Who>('me');
  const [share, setShare] = useState<'full' | 'busy'>('busy');
  const file = useRef<HTMLInputElement>(null);
  const p = nameOf(partner.value);

  const finish = (text: string, fallbackName: string, url: string | null) => {
    try {
      const r = importCalendar(text, {
        name: name.trim() || fallbackName,
        owner: whoToOwner(who),
        share,
        url,
      });
      setName('');
      setLink('');
      toast(
        r.events
          ? `Imported ${r.events} event${r.events === 1 ? '' : 's'} for the next 60 days${r.truncated ? ' (trimmed to the first 400)' : ''}.`
          : 'No upcoming events found in that calendar.',
      );
    } catch {
      toast('That calendar couldn’t be read.');
    }
  };

  return (
    <details class="addcal">
      <summary>Add a calendar</summary>
      <div class="stack gap">
        <div class="field">
          <label for="cal-name">Name</label>
          <input
            id="cal-name"
            class="txt"
            type="text"
            value={name}
            maxLength={80}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="Work"
            autocomplete="off"
          />
        </div>
        <span class="sublbl" id="new-who">
          Whose calendar
        </span>
        <WhoPicker labelId="new-who" value={who} onChange={setWho} />
        <span class="sublbl" id="new-share">
          {p} sees
        </span>
        <SharePicker labelId="new-share" value={share} onChange={setShare} />

        <div class="field">
          <label for="cal-link">Subscription link</label>
          <input
            id="cal-link"
            class="txt"
            type="url"
            inputMode="url"
            value={link}
            onInput={(e) => setLink(e.currentTarget.value)}
            placeholder="webcal://… or https://….ics"
            autocomplete="off"
            disabled={!HAS_API}
            aria-describedby="cal-link-note"
          />
          <p class="small muted" id="cal-link-note">
            {HAS_API
              ? 'Refreshes pass through our server, which sees the link and the calendar while relaying it, but never stores either.'
              : 'Links refresh through our server, so they work once accounts are live. In the demo, import a file instead.'}
          </p>
          {HAS_API && (
            <button
              type="button"
              class="btn sm"
              disabled={!normalizeFeedUrl(link)}
              onClick={() => toast('Subscribing needs an account (coming soon).')}
            >
              Subscribe
            </button>
          )}
        </div>

        <div class="field">
          <span class="lbl">Or import a file</span>
          <p class="small muted">
            Download the .ics from Google, Apple or Outlook and add it here. It’s read on this
            device and never sent anywhere unencrypted. It won’t update by itself.
          </p>
          <input
            ref={file}
            class="sr"
            type="file"
            accept=".ics,text/calendar"
            tabIndex={-1}
            aria-hidden="true"
            onChange={async (e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!f) return;
              if (f.size > 5 * 1024 * 1024) {
                toast('That file is over 5 MB.');
                return;
              }
              finish(
                await f.text(),
                f.name.replace(/\.ics$/i, '').slice(0, 80) || 'Imported',
                null,
              );
            }}
          />
          <div class="btnrow">
            <button type="button" class="btn sm" onClick={() => file.current?.click()}>
              <Icon name="download" size={15} />
              Choose .ics file
            </button>
            <button
              type="button"
              class="btn sm ghost"
              onClick={() => finish(sampleWorkIcs(today.value, zone), 'Work', null)}
            >
              Add a sample work calendar
            </button>
          </div>
        </div>
      </div>
    </details>
  );
}

function FeedPreview() {
  const me = viewer.value;
  const days = agenda(7);
  const occurrences: FeedOccurrence[] = days.flatMap((d) =>
    d.rows
      .filter((r) => r.status !== 'declined')
      .map((r) => ({
        start: r.occStart,
        end: r.occEnd,
        busy: !r.free,
        source:
          r.origin === 'import'
            ? {
                kind: 'import' as const,
                owner: r.owner,
                importer: r.importer ?? partner.value,
                calendarId: r.id,
              }
            : { kind: 'plan' as const, owner: r.owner, tentative: r.status === 'proposed' },
      })),
  );
  const from = Date.now();
  const to = from + 7 * 86_400_000;
  const blocks = feedBlocks(occurrences, me, from, to, { includePartner: includePartner.value });
  const left = visibleSnapshots().filter(
    (s) => s.rec.data.importer === me || s.rec.data.owner === me,
  );
  const leftNames = [...new Set(left.map((s) => s.rec.data.name ?? 'an imported calendar'))];
  return (
    <>
      <p class="d">
        Your feed would show <b class="ink">{blocks.length}</b> busy block
        {blocks.length === 1 ? '' : 's'} in the next 7 days: your plans and plans you share. Times
        only, never titles.
      </p>
      {leftNames.length > 0 && (
        <p class="d small">
          Leaves out {leftNames.join(', ')}: it’s already in your calendar app, so including it
          would show everything twice.
        </p>
      )}
      <label class="sw">
        <input
          type="checkbox"
          role="switch"
          checked={includePartner.value}
          aria-checked={includePartner.value}
          onChange={(e) => {
            includePartner.value = e.currentTarget.checked;
          }}
        />
        <span class="track" />
        <span class="sw-t">
          Include {nameOf(partner.value)}’s busy times
          <small>Handy for planning around each other from your work calendar.</small>
        </span>
      </label>
    </>
  );
}

export function CalendarsCard() {
  const mine = myCalendars();
  const shared = visibleSnapshots().filter(
    (s) => s.scope === 'space' && s.rec.data.importer !== viewer.value,
  );
  return (
    <>
      <section class="card" aria-labelledby="cals-h">
        <h2 class="h3" id="cals-h">
          Calendars you already use
        </h2>
        <p class="d">
          Bring in your work or personal calendars so “both free” is right. Say whose each one is,
          and whether {nameOf(partner.value)} sees the details or just that you’re busy.
        </p>
        {mine.length > 0 && (
          <ul class="cals">
            {mine.map((c) => (
              <CalendarRow key={c.id} cal={c} />
            ))}
          </ul>
        )}
        {shared.length > 0 && (
          <ul class="cals">
            {shared.map((s) => (
              <li class="calrow" key={s.id}>
                <div class="calrow-head">
                  <Marker
                    owner={s.rec.data.owner}
                    {...(s.rec.data.detail === 'busy' ? { mode: 'busy' as const } : {})}
                  />
                  <span class="stack">
                    <b>{s.rec.data.name ?? `${nameOf(s.rec.data.importer)}’s calendar`}</b>
                    <span class="small muted">
                      {whoLabel(s.rec.data.owner)} · shared by {nameOf(s.rec.data.importer)} ·{' '}
                      {s.rec.data.detail === 'busy' ? 'busy times only' : 'full details'}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <AddCalendar />
      </section>

      <section class="card" aria-labelledby="feed-h">
        <h2 class="h3" id="feed-h">
          Calendar feed
        </h2>
        <p class="d">
          Subscribe to Ours from Google or Apple Calendar to see your plans next to your work
          calendar. The server can’t read titles, so the feed holds busy times only. It’s off until
          you turn it on.
        </p>
        <FeedPreview />
        {!HAS_API && (
          <p class="note">
            <Icon name="lock" size={15} />
            <span>The feed link itself is available once you have an account.</span>
          </p>
        )}
      </section>
    </>
  );
}
