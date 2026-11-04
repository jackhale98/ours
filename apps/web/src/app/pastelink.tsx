// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Paste a link": for the links Ours sends (sign-in emails, partner invites,
 * device links) when tapping them can't reach this app. An iPhone or iPad
 * opens every link in Safari, never in an app added to the Home Screen, and
 * the two keep separate storage; the Home Screen app has no address bar
 * either. Copying the link and pasting it here is the way in.
 *
 * The link's secret is read here and used as if the link had been opened; it
 * isn't stored beyond what opening the link would store.
 */
import { parseInviteFragment } from '@ours/core/crypto';
import { useId, useState } from 'preact/hooks';
import { toast } from './ui';

export type PastedLink = { kind: 'signin'; token: string } | { kind: 'join'; fragment: string };

/** A sign-in link (…#signin=<token>) or an invite/device link (…/join/#<id>.<secret>). */
export function parseLink(text: string): PastedLink | null {
  const t = text.trim();
  const hash = t.includes('#') ? t.slice(t.indexOf('#') + 1) : t;
  const signin = /^signin=([A-Za-z0-9_-]{43})$/.exec(hash);
  if (signin?.[1]) return { kind: 'signin', token: signin[1] };
  try {
    parseInviteFragment(`#${hash}`);
    return { kind: 'join', fragment: hash };
  } catch {
    return null;
  }
}

export function PasteLink({
  label,
  hint,
  accept,
  onLink,
}: {
  label: string;
  hint: string;
  accept: PastedLink['kind'][];
  onLink: (link: PastedLink) => Promise<void> | void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button type="button" class="linkbtn" aria-expanded={false} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <form
      class="stack gap paste"
      onSubmit={async (e) => {
        e.preventDefault();
        const link = parseLink(text);
        if (!link || !accept.includes(link.kind)) {
          toast('That isn’t a link Ours can use here. Copy the whole link and try again.');
          return;
        }
        setBusy(true);
        try {
          await onLink(link);
          setText('');
          setOpen(false);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div class="field">
        <label for={id}>{label}</label>
        <input
          id={id}
          class="txt"
          type="url"
          inputMode="url"
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          data-autofocus
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <p class="small muted">{hint}</p>
      </div>
      <div class="btnrow">
        <button class="btn sm primary" type="submit" disabled={busy || !text.trim()}>
          Use this link
        </button>
        <button type="button" class="btn sm ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
