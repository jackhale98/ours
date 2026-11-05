// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the partner is told, and when. Only things that need an answer or
 * answer a question: proposals, yes/no, and notes on a shared plan (unless
 * the partner turned those off). Private plans never notify. Text is sealed on this device (account/notify).
 */
import { notifyPartner } from '../account/notify';
import { findEntry, nameOf, partner, settings, viewer } from './model';
import { whenText } from './select';

function eventOf(id: string) {
  const e = findEntry(id);
  return e?.rec.kind === 'event' && e.rec.data.privacy === 'full' ? e.rec.data : null;
}

function when(d: NonNullable<ReturnType<typeof eventOf>>): string {
  return whenText(d.start.slice(0, 10), d.all_day, d.start.slice(11), d.end.slice(11));
}

export function noticeProposal(id: string): void {
  const d = eventOf(id);
  if (d?.status !== 'proposed') return;
  notifyPartner({
    title: `${nameOf(viewer.value)} asked: ${d.title}`,
    body: when(d),
    record_id: id,
    kind: 'proposal',
  });
}

export function noticeAnswer(id: string, yes: boolean): void {
  const d = eventOf(id);
  if (!d) return;
  notifyPartner({
    title: yes
      ? `${nameOf(viewer.value)} said yes: ${d.title}`
      : `${nameOf(viewer.value)} can’t make it: ${d.title}`,
    body: when(d),
    record_id: id,
    kind: 'answer',
  });
}

export function noticeNote(id: string, text: string): void {
  const d = eventOf(id);
  if (!d) return;
  // The partner chose not to hear about notes (Privacy → Notifications).
  if (settings.value.notify_notes?.[partner.value] === false) return;
  notifyPartner({
    title: `${nameOf(viewer.value)} added a note: ${d.title}`,
    body: text,
    record_id: id,
    kind: 'note',
  });
}

/*
 * Changes to a shared plan (review 0009, P-4). Sent without a kind, so
 * versions of the app that don't know these yet still show them.
 */

/** Asked to move a plan: "Sam wants to move: Dinner", from → to. */
export function noticeMove(id: string): void {
  const d = eventOf(id);
  if (d?.status !== 'proposed' || !d.was?.start || !d.was.end) return;
  const from = whenText(
    d.was.start.slice(0, 10),
    d.all_day,
    d.was.start.slice(11),
    d.was.end.slice(11),
  );
  notifyPartner({
    title: `${nameOf(viewer.value)} wants to move: ${d.title}`,
    body: `${from} → ${when(d)}`,
    record_id: id,
  });
}

/** Changed without asking: moved, renamed or a new place. */
export function noticeChange(id: string): void {
  const d = eventOf(id);
  if (!d?.was || d.status === 'declined') return;
  const what = d.was.start
    ? 'moved'
    : d.was.title !== undefined
      ? `renamed “${d.was.title}”`
      : 'changed the place for';
  notifyPartner({
    title: `${nameOf(viewer.value)} ${what}: ${d.title}`,
    body: when(d) + (d.location ? ` · ${d.location}` : ''),
    record_id: id,
  });
}

/** A shared plan removed: said before it goes, while its title is known. */
export function noticeRemoved(id: string): void {
  const d = eventOf(id);
  if (!d || d.status === 'declined') return;
  notifyPartner({
    title: `${nameOf(viewer.value)} removed: ${d.title}`,
    body: when(d),
    record_id: id,
  });
}
