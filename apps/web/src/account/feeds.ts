// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Calendar links, both directions (phase 6, ADR 0011).
 *
 * In: calendars added by subscription link are fetched through the Worker's
 * relay (browsers can't fetch most calendar URLs directly), parsed here and
 * stored encrypted. They refresh when the app opens and every few hours
 * while it stays open, on whichever of the importer's devices is active.
 *
 * Out: the opt-in busy feed. This device publishes busy blocks (start and
 * end only) for the next 60 days and replaces them when plans change. The
 * feed link is shown once when made; this device remembers it.
 */
import { type FeedOccurrence, feedBlocks } from '@ours/core/feed';
import { normalizeFeedUrl } from '@ours/core/ics';
import { computed, effect, signal } from '@preact/signals';
import {
  type ImportOptions,
  type ImportResult,
  importCalendar,
  myCalendars,
  refreshCalendar,
} from '../app/calendars';
import { partner, settings, store, updateSettings, viewer } from '../app/model';
import { agenda } from '../app/select';
import { api } from './api';
import { kvGet, kvSet } from './db';

const REFRESH_EVERY_MS = 6 * 3_600_000;
const FEED_DAYS = 60;

let active = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

/* ---------- subscription links ---------- */

async function fetchText(url: string): Promise<string> {
  return api<string>('/calendars/fetch', { body: { url }, raw: true });
}

/** Adds a calendar from a link (webcal:// or https://). */
export async function subscribeCalendar(
  link: string,
  opts: Omit<ImportOptions, 'url'>,
): Promise<ImportResult> {
  const url = normalizeFeedUrl(link);
  if (!url) throw new Error('That doesn’t look like a calendar link.');
  return importCalendar(await fetchText(url), { ...opts, url });
}

/** Refreshes this person's linked calendars that are due (or all, if forced). */
export async function refreshCalendars(force = false): Promise<number> {
  const now = Date.now();
  let refreshed = 0;
  for (const cal of myCalendars()) {
    const d = cal.rec.data;
    if (!d.url) continue;
    if (!force && d.fetched_at && now - d.fetched_at < REFRESH_EVERY_MS) continue;
    try {
      if (refreshCalendar(cal.id, await fetchText(d.url))) refreshed++;
    } catch {
      // Offline or the source is down: try again next time.
    }
  }
  return refreshed;
}

/* ---------- busy feed ---------- */

export const feedOn = signal(false);
/** Whether the partner is in the space now (from the server's member list). */
const partnerPresent = signal(true);

/**
 * Called with the server's member list. A partner who has left takes their
 * consent with them (review 0004, R5): their busy times leave this person's
 * feed at once, and the flag is cleared so a later partner starts unasked.
 */
export function setPartnerPresent(present: boolean): void {
  partnerPresent.value = present;
  const shares = settings.value.feed_share_busy;
  if (!present && shares?.[partner.value]) {
    updateSettings({ feed_share_busy: { ...shares, [partner.value]: false } });
  }
}
export const feedUrl = signal<string | null>(null);
/**
 * The partner's busy times go into this person's feed only if they chose to
 * include them and the partner agreed (review 0004, L4). Both choices live in
 * the shared settings, so every device of both people sees the same.
 */
export const partnerAllows = computed(
  () => partnerPresent.value && !!settings.value.feed_share_busy?.[partner.value],
);
export const includePartner = computed(
  () => partnerAllows.value && !!settings.value.feed_include?.[viewer.value],
);
export const iInclude = computed(() => !!settings.value.feed_include?.[viewer.value]);
export const iShare = computed(() => !!settings.value.feed_share_busy?.[viewer.value]);

export function setIncludePartner(on: boolean): void {
  updateSettings({ feed_include: { ...settings.value.feed_include, [viewer.value]: on } });
}
export function setShareMyBusy(on: boolean): void {
  updateSettings({ feed_share_busy: { ...settings.value.feed_share_busy, [viewer.value]: on } });
}

/** Busy blocks this person's feed should hold: the same rules as the preview. */
export function feedBusyBlocks(now = Date.now()): { start: number; end: number }[] {
  const me = viewer.value;
  const occurrences: FeedOccurrence[] = agenda(FEED_DAYS).flatMap((d) =>
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
  return feedBlocks(occurrences, me, now, now + FEED_DAYS * 86_400_000, {
    includePartner: includePartner.value,
  }).map((b) => ({ start: b.start, end: b.end }));
}

let lastFeedSig: string | null = null;
let feedTimer: ReturnType<typeof setTimeout> | undefined;

async function publishBusy(): Promise<void> {
  if (!active || !feedOn.value) return;
  const blocks = feedBusyBlocks();
  const sig = JSON.stringify(blocks);
  lastFeedSig ??= (await kvGet<string>('feed-sig')) ?? null;
  if (sig === lastFeedSig) return;
  try {
    await api('/feed/busy', { method: 'PUT', body: { blocks } });
    lastFeedSig = sig;
    await kvSet('feed-sig', sig);
  } catch {
    // Retried on the next change.
  }
}

export async function turnFeedOn(): Promise<string> {
  const { url } = await api<{ url: string }>('/feed', { body: {} });
  feedOn.value = true;
  feedUrl.value = url;
  await kvSet('feed-url', url);
  lastFeedSig = null;
  await kvSet('feed-sig', null);
  await publishBusy();
  return url;
}

/** A new link; the old one stops working at once. */
export const newFeedLink = turnFeedOn;

export async function turnFeedOff(): Promise<void> {
  await api('/feed', { method: 'DELETE' });
  feedOn.value = false;
  feedUrl.value = null;
  lastFeedSig = null;
  await kvSet('feed-url', null);
  await kvSet('feed-sig', null);
}

/* ---------- lifecycle ---------- */

export async function startFeeds(): Promise<void> {
  active = true;
  feedUrl.value = (await kvGet<string>('feed-url')) ?? null;
  try {
    feedOn.value = (await api<{ on: boolean }>('/feed/status')).on;
  } catch {
    feedOn.value = !!feedUrl.value;
  }
  if (!feedOn.value) feedUrl.value = null;
  void refreshCalendars();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void refreshCalendars();
  }, REFRESH_EVERY_MS / 6);
  void publishBusy();
}

export function stopFeeds(): void {
  active = false;
  clearInterval(refreshTimer);
  feedOn.value = false;
  feedUrl.value = null;
  lastFeedSig = null;
}

effect(() => {
  void store.value;
  void includePartner.value;
  if (!active || !feedOn.value) return;
  clearTimeout(feedTimer);
  feedTimer = setTimeout(() => void publishBusy(), 2000);
});
