// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Separate entry for invite links (partner invites and device links). The
 * secret lives in the URL fragment, which browsers never send to a server.
 * We read it once, drop it from the address bar and history, keep it in this
 * tab (asking for a sign-in link keeps it for that address too: see
 * pendingInvite in account/session.ts), and continue in the app's onboarding.
 */
import { parseInviteFragment } from '@ours/core/crypto';
import { render } from 'preact';
import './styles/base.css';
import './styles/landing.css';
import { APP_NAME, HAS_API } from './config';

function readInvite(): string | null {
  const hash = window.location.hash;
  if (!hash) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    parseInviteFragment(hash);
    return hash.slice(1);
  } catch {
    return null;
  }
}

const fragment = readInvite();
if (fragment && HAS_API) {
  try {
    sessionStorage.setItem('ours-pending-invite', fragment);
  } catch {
    // Storage blocked: fall through to the message below.
  }
  location.replace(new URL('../#start', location.href).href);
}

function Join() {
  return (
    <main id="main" class="page">
      <h1>Join your partner on {APP_NAME}</h1>
      {!fragment ? (
        <p role="alert">
          This invite link is incomplete or damaged. Ask your partner for a new one.
        </p>
      ) : HAS_API ? (
        <p>Opening your invite…</p>
      ) : (
        <p>Your invite link looks valid, but accounts aren’t switched on for this site yet.</p>
      )}
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<Join />, root);
