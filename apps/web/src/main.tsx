// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from 'preact';
import './styles/base.css';
import { APP_NAME } from './config';

function Landing() {
  return (
    <>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <main id="main" class="page">
        <p class="dots" aria-hidden="true">
          <span class="dot dot-a" />
          <span class="dot dot-b" />
        </p>
        <h1>{APP_NAME}: a private planner for two</h1>
        <p>
          A shared calendar, proposals, lists and a weekly check-in. Everything you write is
          end-to-end encrypted on your devices before it is synced.
        </p>
        <p>
          <strong>What is not hidden:</strong> your email address, when you sync, and how many and
          how large your records are. See the threat model in the project documentation.
        </p>
        <p>This is an early build. Sign-up is not available yet.</p>
      </main>
    </>
  );
}

const root = document.getElementById('app');
if (root) render(<Landing />, root);
