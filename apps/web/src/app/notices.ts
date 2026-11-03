// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the partner is told, and when. Only things that need an answer or
 * answer a question: proposals, yes/no, and notes on a shared plan. Private
 * plans never notify. Text is sealed on this device (account/notify).
 */
import { notifyPartner } from '../account/notify';
import { findEntry, nameOf, viewer } from './model';
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
  notifyPartner({
    title: `${nameOf(viewer.value)} added a note: ${d.title}`,
    body: text,
    record_id: id,
    kind: 'note',
  });
}
