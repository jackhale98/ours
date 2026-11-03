// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Separate entry for invite links. The invite secret lives in the URL
 * fragment, which browsers never send to a server. We read it once, then
 * remove it from the address bar and history.
 */
import { parseInviteFragment } from '@ours/core/crypto';
import { render } from 'preact';
import './styles/base.css';
import { APP_NAME } from './config';

function readInvite(): { inviteId: string } | null {
  const hash = window.location.hash;
  if (!hash) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    const { inviteId } = parseInviteFragment(hash);
    return { inviteId };
  } catch {
    return null;
  }
}

function Join({ invite }: { invite: { inviteId: string } | null }) {
  return (
    <main id="main" class="page">
      <h1>Join your partner on {APP_NAME}</h1>
      {invite ? (
        <p>Your invite link looks valid. Accepting invites arrives in a later build.</p>
      ) : (
        <p role="alert">
          This invite link is incomplete or damaged. Ask your partner for a new one.
        </p>
      )}
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<Join invite={readInvite()} />, root);
