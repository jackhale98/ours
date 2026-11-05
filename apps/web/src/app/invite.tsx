// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Inviting your partner after sign-up: a new link whenever one is needed
 * (the first was ignored, expired after 24 hours, or went to the wrong
 * place). The server keeps one open partner invite per person and space, so
 * making a new link stops the old one working.
 */
import { useEffect, useState } from 'preact/hooks';
import { account, checkPartner, invitePartner } from '../account/session';
import { Icon, toast } from './ui';

/** Signed in, and nobody has joined the space yet. */
export const partnerMissing = () => {
  const a = account.value;
  return a.status === 'ready' && !a.partnerJoined;
};

export function PartnerInvite() {
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // While a link is out, notice when they join.
  useEffect(() => {
    if (!link) return;
    const t = setInterval(async () => {
      if (await checkPartner().catch(() => false)) {
        toast('They’ve joined. Compare your safety codes in Settings.');
      }
    }, 5000);
    return () => clearInterval(t);
  }, [link]);

  const make = async () => {
    setBusy(true);
    try {
      setLink(await invitePartner());
    } catch {
      toast('Couldn’t make a link. Check you’re online and try again.');
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    if (!link) return;
    try {
      if (navigator.share) await navigator.share({ title: 'Join me on Ours', url: link });
      else {
        await navigator.clipboard.writeText(link);
        toast('Link copied.');
      }
    } catch {
      // Share sheet closed.
    }
  };

  return (
    <div class="stack gap">
      <p class="d">
        Send your partner a link to join. It works once, for 24 hours, and anyone with it can join,
        so send it only to them. Making a new link stops the last one working.
      </p>
      {link && (
        <div class="url">
          <code>{link}</code>
          <button type="button" class="btn sm" onClick={share}>
            {'share' in navigator ? 'Share' : 'Copy'}
          </button>
        </div>
      )}
      <button
        type="button"
        class={`btn sm${link ? '' : ' primary'}`}
        disabled={busy}
        onClick={make}
      >
        <Icon name={link ? 'repeat' : 'send'} size={15} />
        {link ? 'Make a new link' : 'Make an invite link'}
      </button>
      {link && (
        <p class="small muted" aria-live="polite">
          Waiting for them to join. On an iPhone with Ours on the Home Screen, they can paste the
          link into Ours instead of opening it.
        </p>
      )}
    </div>
  );
}

export function PartnerInviteCard() {
  if (!partnerMissing()) return null;
  return (
    <section class="card" aria-labelledby="pi-h">
      <h2 class="h3" id="pi-h">
        Invite your partner
      </h2>
      <PartnerInvite />
    </section>
  );
}
