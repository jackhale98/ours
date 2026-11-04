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
  list: '<path d="M9.5 6.5h10.5M9.5 12h10.5M9.5 17.5h10.5"/><path d="M4 6.5l1.2 1.2L7.2 5.5M4 12l1.2 1.2L7.2 11"/><circle cx="5.5" cy="17.5" r="1.2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  inbox:
    '<path d="M3.5 13.5 6 5.5h12l2.5 8v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/>',
  flag: '<path d="M6 21V4.5M6 5h11l-2.5 4 2.5 4H6"/>',
} as const;

function LineIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      width="20"
      height="20"
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

function Dot({ who, dashed }: { who: Who; dashed?: boolean }) {
  return <i class={`ld-dot ${who}${dashed ? ' dashed' : ''}`} />;
}

function Row({ time, who, title, meta }: { time: string; who: Who; title: string; meta?: string }) {
  return (
    <div class="ld-row">
      <span class="ld-time">{time}</span>
      <Dot who={who} />
      <span class="ld-title">
        {title}
        {meta && <span class="ld-meta">{meta}</span>}
      </span>
    </div>
  );
}

/** The hero preview: a phone showing this week. */
function PhonePreview() {
  return (
    <div class="ld-phone" aria-hidden="true">
      <div class="ld-screen">
        <div class="ld-bar">
          <span class="ld-logo">
            <LogoMark size={18} />
            ours
          </span>
          <span class="ld-badge">2</span>
        </div>
        <p class="ld-eyebrow">Nov 4 – Nov 10</p>
        <p class="ld-h">This week</p>
        <div class="ld-cds">
          <span class="ld-cd">
            <b>23</b> days to <em>Lisbon</em>
          </span>
          <span class="ld-cd">
            <b>41</b> days to <em>our anniversary</em>
          </span>
        </div>
        <div class="ld-ask">
          <p class="ld-eyebrow ours">Alex asked · needs your answer</p>
          <p class="ld-asktitle">Dinner at my parents’</p>
          <p class="ld-meta">Monday · 6 – 9 PM</p>
          <div class="ld-btns">
            <span class="ld-btn primary">Yes, add it</span>
            <span class="ld-btn">Reply</span>
          </div>
        </div>
        <p class="ld-day">Today</p>
        <Row time="4:30 PM" who="a" title="Dentist" meta="Dr. Okafor" />
        <Row time="7 PM" who="both" title="Date night" meta="Booked for two" />
        <p class="ld-day">Thursday</p>
        <Row time="7 PM" who="b" title="Book club" />
        <div class="ld-free">
          <Dot who="both" dashed /> Both free this evening
          <span>Plan something</span>
        </div>
      </div>
    </div>
  );
}

function ListPreview() {
  const items: [string, string, Who | null, boolean][] = [
    ['Take out the bins', 'Every Monday · taking turns', 'a', false],
    ['Water the plants', 'Due today', null, false],
    ['Book furnace service', 'Due Friday', 'b', false],
    ['Oat milk', '', 'a', true],
  ];
  return (
    <div class="ld-card ld-list" aria-hidden="true">
      <div class="ld-tabs">
        <span class="on">Home 6</span>
        <span>Groceries 5</span>
        <span>Gift ideas 3</span>
      </div>
      {items.map(([text, sub, who, done]) => (
        <div class={`ld-item${done ? ' done' : ''}`} key={text}>
          <span class="ld-box" />
          <span class="ld-title">
            {text}
            {sub && <span class="ld-meta">{sub}</span>}
          </span>
          <span class={`ld-av ${who ?? 'none'}`}>
            {who === 'a' ? 'S' : who === 'b' ? 'A' : '+'}
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
        <span class="ld-eyebrow ours">Alex’s note</span>
        Can we keep Sunday morning slow this week?
      </p>
      {steps.map(([s, ok], i) => (
        <div class={`ld-step${ok ? ' ok' : ''}`} key={s}>
          <span class="ld-num">{ok ? '✓' : i + 1}</span>
          {s}
        </div>
      ))}
    </div>
  );
}

function MonthPreview() {
  // A month at a glance: who has what, and the evenings you're both free.
  const marks: Record<number, Who[]> = {
    2: ['a'],
    4: ['a', 'b'],
    5: ['b', 'both'],
    7: ['both', 'a'],
    9: ['both'],
    12: ['b'],
    13: ['a'],
    14: ['both', 'b'],
    16: ['a'],
    19: ['both'],
    21: ['b', 'a'],
    23: ['both'],
    26: ['a'],
    27: ['both'],
    28: ['b'],
  };
  const free = new Set([3, 10, 11, 17, 18, 24, 25]);
  return (
    <div class="ld-card ld-month" aria-hidden="true">
      <p class="ld-asktitle">November</p>
      <div class="ld-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span class="ld-dow" key={i}>
            {d}
          </span>
        ))}
        {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
          <span class={`ld-cell${n === 4 ? ' today' : ''}`} key={n}>
            {n}
            <span class="ld-marks">
              {(marks[n] ?? []).map((w, j) => (
                <Dot who={w} key={j} />
              ))}
              {free.has(n) && <Dot who="both" dashed />}
            </span>
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
      <a class={HAS_API ? 'btn big' : 'btn primary big'} href="#plan">
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
          <a class="btn sm" href="#plan">
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
              <Feature icon="chat" title="Ask, don’t assume">
                Propose a plan and it stays tentative until your partner says yes. One tap to
                answer, with a note if you need one.
              </Feature>
              <Feature icon="list" title="Chores that share themselves">
                Lists with owners, due dates and repeating tasks that take turns, so the bins aren’t
                always one person’s job.
              </Feature>
              <Feature icon="link" title="Your other calendars, included">
                Add your work or personal calendar by link. Your partner sees just “busy”, or the
                details, as you choose.
              </Feature>
              <Feature icon="inbox" title="Waiting on you">
                Everything that needs your answer or a hand, in one place, one thing at a time.
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
              Groceries, chores, packing, date ideas. Give each thing an owner, set it to repeat and
              let it take turns. Gift ideas stay private, so surprises stay surprises.
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
                  <b>Make your space.</b> Sign in with your email. No password to remember.
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
                <li>Your email address</li>
                <li>How many records you have, roughly how large, and when they change</li>
                <li>When reminders fire and when notifications are sent</li>
                <li>Busy times, only if you turn on the calendar feed</li>
              </ul>
            </section>
            <section class="card">
              <h3>If you lose everything</h3>
              <p>
                Lose every device and your 12-word recovery phrase, and your data is gone for good.
                Not even we can get it back. That’s the price of real privacy, and we say it up
                front.
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
