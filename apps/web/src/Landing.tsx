// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The front page: what Ours does for a couple first, then how it keeps it
 * private. Product previews are drawn in HTML and CSS (no screenshots), so
 * they follow light and dark mode, stay sharp and add no requests. They are
 * decorative (aria-hidden); the text next to each one says what it shows.
 */
import type { ComponentChildren } from 'preact';
import { APP_NAME, HAS_API } from './config';
import { LogoMark } from './Logo';

type Who = 'a' | 'b' | 'both';

/** The app's line icons, copied here so the front page doesn't load the app. */
const ICONS = {
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8.5 3v4M15.5 3v4"/>',
  chat: '<path d="M4.5 5.5h15v10h-9.5l-5.5 4z"/>',
  type: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
  list: '<path d="M9.5 6.5h10.5M9.5 12h10.5M9.5 17.5h10.5"/><path d="M4 6.5l1.2 1.2L7.2 5.5M4 12l1.2 1.2L7.2 11"/><circle cx="5.5" cy="17.5" r="1.2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  inbox:
    '<path d="M3.5 13.5 6 5.5h12l2.5 8v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/>',
  flag: '<path d="M6 21V4.5M6 5h11l-2.5 4 2.5 4H6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  heart:
    '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.2"/>',
  repeat:
    '<path d="M17 3l3 3-3 3"/><path d="M4 12v-1.5A4.5 4.5 0 0 1 8.5 6H20"/><path d="M7 21l-3-3 3-3"/><path d="M20 12v1.5a4.5 4.5 0 0 1-4.5 4.5H4"/>',
  next: '<path d="M9.5 6l6 6-6 6"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2.2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
} as const;

function LineIcon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

/**
 * The app's plan marks: a dot each, two overlapping for a plan you share,
 * rings while waiting for a yes, stripes when the details are private.
 */
function Mk({ who, mode }: { who: Who; mode?: 'dash' | 'busy' }) {
  return (
    <span class={`ld-mk${who === 'both' ? ' ours' : ''}${mode ? ` ${mode}` : ''}`}>
      {who === 'both' ? (
        <>
          <i class="a" />
          <i class="b" />
        </>
      ) : (
        <i class={who} />
      )}
    </span>
  );
}

function Ev({
  from,
  to,
  who,
  title,
  mode,
  place,
  repeat,
}: {
  from: string;
  to: string;
  who: Who;
  title: string;
  mode?: 'dash' | 'busy';
  place?: string;
  repeat?: string;
}) {
  return (
    <div class="ld-row">
      <span class="ld-time">
        {from}
        <br />
        {to}
      </span>
      <Mk who={who} {...(mode ? { mode } : {})} />
      <span class="ld-title">
        {title}
        {(place || repeat) && (
          <span class="ld-meta">
            {place && (
              <>
                <LineIcon name="pin" size={11} /> {place}
              </>
            )}
            {repeat && (
              <>
                <LineIcon name="repeat" size={11} /> {repeat}
              </>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

function Day({
  label,
  n,
  today,
  children,
}: {
  label: string;
  n: number;
  today?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class="ld-dayrow">
      <span class="ld-dlabel">
        {label}
        <b class={today ? 'today' : undefined}>{n}</b>
      </span>
      <div class="ld-evs">{children}</div>
    </div>
  );
}

/** The hero preview: a phone showing this week, as in the demo. */
function PhonePreview() {
  return (
    <div class="ld-phone" aria-hidden="true">
      <div class="ld-screen">
        <div class="ld-bar">
          <span class="ld-logo">
            <LogoMark size={18} />
            ours
          </span>
          <span class="ld-tools">
            <LineIcon name="search" size={16} />
            <span class="ld-inbox">
              <LineIcon name="inbox" size={16} />
              <span class="ld-badge">2</span>
            </span>
            <span class="ld-pair">
              <span class="ld-av a">S</span>
              <span class="ld-av b round">A</span>
            </span>
          </span>
        </div>
        <p class="ld-eyebrow">Nov 4 – Nov 10</p>
        <p class="ld-h">This week</p>
        <div class="ld-seg">
          <span class="on">Agenda</span>
          <span>Week</span>
          <span>Month</span>
        </div>
        <div class="ld-cds">
          <span class="ld-cd">
            <b>23</b>
            <span>
              days to
              <em>Lisbon trip</em>
            </span>
          </span>
          <span class="ld-cd">
            <b>41</b>
            <span>
              days to
              <em>Our anniversary</em>
            </span>
          </span>
        </div>
        <div class="ld-ask">
          <p class="ld-eyebrow ours">Alex asked · needs your answer</p>
          <p class="ld-asktitle">Dinner at my parents’</p>
          <p class="ld-meta">Monday, Nov 9 · 6 PM – 9 PM</p>
          <p class="ld-bubble">Mom is making the lasagna. Can we do it?</p>
          <div class="ld-btns">
            <span class="ld-btn primary">✓ Yes, add it</span>
            <span class="ld-btn">Reply</span>
            <span class="ld-btn ghost">Can’t make it</span>
          </div>
        </div>
        <Day label="Today" n={4} today>
          <Ev from="3 PM" to="11 PM" who="b" title="Late shift" />
          <Ev from="4:30 PM" to="5:30 PM" who="a" title="Dentist" place="Dr. Okafor" />
        </Day>
        <Day label="Thu" n={5}>
          <Ev from="7 PM" to="9 PM" who="a" title="Book club" place="Lena’s place" />
          <Ev
            from="9 PM"
            to="9:15 PM"
            who="both"
            title="Trash & recycling out"
            repeat="Every week"
          />
        </Day>
        <Day label="Fri" n={6}>
          <Ev from="12 PM" to="1 PM" who="b" mode="busy" title="Busy" />
          <div class="ld-free">
            <Mk who="both" mode="dash" /> Both free this evening
            <span>Plan something</span>
          </div>
        </Day>
      </div>
    </div>
  );
}

/** The demo's Home list: who's on what, due dates and repeats that take turns. */
function ListPreview() {
  const items: [string, string, Who | null][] = [
    ['Take out the bins', 'Due Monday · 7 PM · Every Monday, taking turns', 'a'],
    ['Water the plants', 'Due today · Every Wednesday and Saturday', null],
    ['Book furnace service', '', 'a'],
    ['Return library books', '', 'b'],
  ];
  return (
    <div class="ld-card ld-list" aria-hidden="true">
      <div class="ld-tabs">
        <span>Groceries 5</span>
        <span class="on">Home 6</span>
        <span>
          <LineIcon name="lock" size={11} /> Gift ideas 3
        </span>
      </div>
      <div class="ld-lbar">
        <span>Chores</span>
        <span class="ld-links">
          <u>Select</u>
          <u>Settings</u>
        </span>
      </div>
      {items.map(([text, sub, who]) => (
        <div class="ld-item" key={text}>
          <span class="ld-box" />
          <span class="ld-title">
            {text}
            {sub && <span class="ld-meta">{sub}</span>}
          </span>
          <span class={`ld-av ${who ?? 'none'}`}>
            {who === 'a' ? 'S' : who === 'b' ? 'A' : '+'}
          </span>
          <span class="ld-chev">
            <LineIcon name="next" size={14} />
          </span>
        </div>
      ))}
    </div>
  );
}

function CheckinPreview() {
  const steps: [string, boolean][] = [
    ['Look at the week ahead', true],
    ['Share out what needs doing', true],
    ['Plan time together', false],
    ['Anything on your mind?', false],
  ];
  return (
    <div class="ld-card ld-checkin" aria-hidden="true">
      <p class="ld-note">
        <span class="ld-eyebrow ours">Alex’s note · Sun, Nov 1</span>
        Can we keep Sunday morning slow this week? I’ve been running on empty.
      </p>
      <div class="ld-prog">
        {steps.map(([s, ok]) => (
          <i class={ok ? 'ok' : undefined} key={s} />
        ))}
      </div>
      {steps.map(([s, ok], i) => (
        <div class={`ld-step${ok ? ' ok' : ''}`} key={s}>
          <span class="ld-num">{ok ? '✓' : i + 1}</span>
          {s}
          <span class="ld-btn">{ok ? 'Reopen' : 'Done'}</span>
        </div>
      ))}
    </div>
  );
}

/** The demo's November on a phone: who has what, and the evenings you're both free. */
function MonthPreview() {
  type Mark = Who | 'ask' | 'busy';
  const marks: Record<number, Mark[]> = {
    4: ['b', 'a'],
    5: ['a', 'both'],
    6: ['b', 'busy'],
    7: ['both', 'a', 'b'],
    8: ['both'],
    9: ['ask'],
    10: ['a'],
    12: ['ask', 'both'],
    13: ['b'],
    14: ['b', 'both'],
    15: ['both'],
    19: ['both'],
    21: ['both'],
    26: ['both'],
    27: ['both'],
    28: ['both'],
  };
  const free = new Set([6, 10, 11, 16, 17, 18, 20, 21, 22, 23, 24, 25, 28, 29, 30]);
  const away = new Set([13, 14, 27]);
  // November 2026 starts on a Sunday: six weeks, Monday Oct 26 to Sunday Dec 6.
  const cells = [
    ...[26, 27, 28, 29, 30, 31].map((n) => ({ n, out: true })),
    ...Array.from({ length: 30 }, (_, i) => ({ n: i + 1, out: false })),
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ n, out: true })),
  ];
  const december: Record<number, Mark[]> = { 3: ['both'], 5: ['both'] };
  return (
    <div class="ld-card ld-month" aria-hidden="true">
      <p class="ld-asktitle">November 2026</p>
      <div class="ld-grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <span class="ld-dow" key={d}>
            {d}
          </span>
        ))}
        {cells.map(({ n, out }) => (
          <span
            class={`ld-cell${out ? ' out' : ''}${!out && n === 4 ? ' today' : ''}`}
            key={`${out ? (n < 20 ? 'd' : 'o') : 'n'}${n}`}
          >
            <b>{n}</b>
            {!out && free.has(n) && <i class="ld-free-ring" />}
            {!out && n === 27 && (
              <span class="ld-flag">
                <LineIcon name="flag" size={9} />
              </span>
            )}
            <span class="ld-marks">
              {((out ? (n < 20 ? december[n] : undefined) : marks[n]) ?? []).map((m, j) =>
                m === 'ask' ? (
                  <Mk who="both" mode="dash" key={j} />
                ) : m === 'busy' ? (
                  <Mk who="b" mode="busy" key={j} />
                ) : (
                  <Mk who={m} key={j} />
                ),
              )}
            </span>
            {!out && away.has(n) && <i class="ld-away" />}
          </span>
        ))}
      </div>
    </div>
  );
}

function Feature({
  title,
  children,
  icon,
}: {
  title: string;
  children: ComponentChildren;
  icon: keyof typeof ICONS;
}) {
  return (
    <li class="ld-feature">
      <span class="ld-ficon" aria-hidden="true">
        <LineIcon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </li>
  );
}

function Cta() {
  return (
    <div class="cta">
      {HAS_API && (
        <a class="btn primary big" href="#start">
          Get started, free
        </a>
      )}
      <a class={HAS_API ? 'btn big' : 'btn primary big'} href="#demo">
        Try the demo
      </a>
    </div>
  );
}

export function Landing() {
  return (
    <>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <header class="lp-top">
        <div class="lp-wrap lp-nav">
          <span class="logo">
            <LogoMark />
            {APP_NAME.toLowerCase()}
          </span>
          <a class="btn sm" href="#demo">
            Try the demo
          </a>
        </div>
      </header>
      <main id="main">
        <section class="lp-wrap lp-hero" aria-labelledby="lp-h1">
          <div class="lp-copy">
            <p class="eyebrow">For couples · free and open source</p>
            <h1 id="lp-h1">The shared planner for the two of you.</h1>
            <p class="lp-lede">
              See both your weeks in one place, ask before you book, split the chores fairly and
              check in once a week. No more “wait, was that this Saturday?”
            </p>
            <Cta />
            <p class="lp-trust">
              <span>No ads, no tracking</span>
              <span>End-to-end encrypted</span>
              <span>Works offline</span>
              <span>Installs like an app</span>
            </p>
          </div>
          <PhonePreview />
        </section>

        <section class="lp-band" aria-labelledby="lp-features">
          <div class="lp-wrap">
            <h2 id="lp-features" class="lp-h2">
              Everything a couple plans, together
            </h2>
            <ul class="ld-features">
              <Feature icon="cal" title="Both your weeks at once">
                Agenda, week and month views show whose plan is whose at a glance, and point out the
                evenings you’re both free.
              </Feature>
              <Feature icon="type" title="Type it the way you’d say it">
                “Dinner fri 7:30pm @ Vic’s”, “gym every mon & thu 7am”, “bins every monday”: the
                day, time, place and repeat are picked out for you, plans and to-dos alike.
              </Feature>
              <Feature icon="chat" title="Ask, don’t assume">
                Propose a plan and it stays tentative until your partner says yes. One tap to
                answer, with a note if you need one.
              </Feature>
              <Feature icon="list" title="Chores that share themselves">
                Lists with owners, due dates and repeating tasks that take turns, so the bins aren’t
                always one person’s job.
              </Feature>
              <Feature icon="heart" title="Lists for anything">
                Start from groceries, packing or date ideas, or a blank list. Heart what you both
                want, let Ours pick one for date night, and remember what you’ve done together.
              </Feature>
              <Feature icon="link" title="Your other calendars, included">
                Add your work or personal calendar by link; your partner sees just “busy”, or the
                details, as you choose. Any plan goes into your phone’s calendar in one tap.
              </Feature>
              <Feature icon="inbox" title="Waiting on you">
                Everything that needs your answer or a hand, in one place, and what your partner
                changed since you last looked.
              </Feature>
              <Feature icon="search" title="Find anything">
                Search plans, notes and lists. It runs on your device, so your words never leave it.
              </Feature>
              <Feature icon="flag" title="Countdowns and reminders">
                Count down to trips and anniversaries, and get reminded when you want, not just when
                an app decides.
              </Feature>
            </ul>
          </div>
        </section>

        <section class="lp-wrap lp-spot" aria-labelledby="lp-s1">
          <div class="lp-spot-copy">
            <p class="eyebrow">Plan together</p>
            <h2 id="lp-s1" class="lp-h2">
              Find the time, without the back and forth
            </h2>
            <p>
              Your plans, your partner’s and the ones you share sit side by side, each marked as
              whose. Ours points out the evenings you’re both free, and your work calendar can join
              in as busy blocks, so nothing gets double-booked.
            </p>
          </div>
          <MonthPreview />
        </section>

        <section class="lp-wrap lp-spot flip" aria-labelledby="lp-s2">
          <div class="lp-spot-copy">
            <p class="eyebrow">Share the load</p>
            <h2 id="lp-s2" class="lp-h2">
              Lists you both keep, and some you don’t
            </h2>
            <p>
              Groceries, chores, packing, date ideas, or anything else. Give each thing an owner,
              set it to repeat and let it take turns, or pick a few and give them the same date at
              once. Heart the ideas you both want and keep the ones you’ve done. Gift ideas stay
              private, so surprises stay surprises.
            </p>
          </div>
          <ListPreview />
        </section>

        <section class="lp-wrap lp-spot" aria-labelledby="lp-s3">
          <div class="lp-spot-copy">
            <p class="eyebrow">Stay on the same page</p>
            <h2 id="lp-s3" class="lp-h2">
              A ten-minute weekly check-in
            </h2>
            <p>
              Once a week, side by side: look at the week ahead, share out what needs doing, plan
              some time together and say what’s on your mind. It takes ten minutes and saves a lot
              of “I thought you were doing that.”
            </p>
          </div>
          <CheckinPreview />
        </section>

        <section class="lp-band" aria-labelledby="lp-how">
          <div class="lp-wrap">
            <h2 id="lp-how" class="lp-h2">
              Set up in two minutes
            </h2>
            <ol class="lp-steps">
              <li>
                <p>
                  <b>Make your space.</b> Sign in with your email or a passkey. No password to
                  remember.
                </p>
              </li>
              <li>
                <p>
                  <b>Invite your partner.</b> Send them a link. You can check a short safety code
                  together to be sure it’s really them.
                </p>
              </li>
              <li>
                <p>
                  <b>Plan together.</b> On your phones, tablets and computers, online or off.
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section class="lp-wrap lp-private" aria-labelledby="lp-priv">
          <p class="eyebrow">Private by design</p>
          <h2 id="lp-priv" class="lp-h2">
            Your plans are yours. Not even we can read them.
          </h2>
          <div class="cards">
            <section class="card">
              <h3>What the server can’t read</h3>
              <p>
                Plan titles, times, places, notes, lists, check-ins and your names. They are
                encrypted with keys that never leave your devices.
              </p>
            </section>
            <section class="card">
              <h3>What it can see</h3>
              <ul>
                <li>Your email address, and which passkey app you use, if you add a passkey</li>
                <li>
                  How many records you have, roughly how large, when they change and which of you
                  changed them
                </li>
                <li>When reminders fire and when notifications are sent</li>
                <li>Busy times, only if you turn on the calendar feed</li>
                <li>
                  Outside calendars you subscribe to by link, while it fetches them for you (never
                  stored)
                </li>
              </ul>
            </section>
            <section class="card">
              <h3>If you lose a phone, or everything</h3>
              <p>
                Lose a phone and you can sign it out and change your keys from another device. A new
                phone gets your keys from one of your devices, your 12-word recovery phrase, or a
                passkey you’ve set up to unlock them.
              </p>
              <p>
                Lose all of those, and your data is gone for good. Not even we can get it back.
                That’s the price of real privacy, and we say it up front.
              </p>
            </section>
          </div>
        </section>

        <section class="lp-wrap lp-end" aria-labelledby="lp-end">
          <h2 id="lp-end" class="lp-h2">
            Try it with sample data
          </h2>
          <p>
            The demo runs entirely in your browser, with no account. See a week as Sam, then switch
            to Alex’s side.
          </p>
          <Cta />
        </section>
      </main>
      <footer class="lp-wrap lp-foot">
        <p>
          {HAS_API ? 'Early build.' : 'Early build: accounts and sync are not live here yet.'} Free
          and open source.
        </p>
        <p>
          <a href="legal/privacy/">Privacy</a> · <a href="legal/terms/">Terms</a> ·{' '}
          <a href="legal/accessibility/">Accessibility</a> ·{' '}
          <a href="https://github.com/jackhale98/ours">Source code</a>
        </p>
      </footer>
    </>
  );
}
