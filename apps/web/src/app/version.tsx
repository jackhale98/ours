// SPDX-License-Identifier: AGPL-3.0-or-later
/** "A new version is ready" (banner) and "This version" (Privacy). See ../update.ts. */
import { useState } from 'preact/hooks';
import { BUILD } from '../config';
import { applyUpdate, checkForUpdate, updateReady } from '../update';
import { Icon, toast } from './ui';

export function UpdateBanner() {
  if (!updateReady.value) return null;
  return (
    <div class="keybanner update" role="status">
      <Icon name="download" size={16} />
      <span>A new version of Ours is ready.</span>
      <button type="button" class="btn sm primary" onClick={applyUpdate}>
        Update
      </button>
    </div>
  );
}

export function VersionCard() {
  const [busy, setBusy] = useState(false);
  const ready = updateReady.value;
  return (
    <section class="card" aria-labelledby="ver-h">
      <h2 class="h3" id="ver-h">
        This version
      </h2>
      <p class="d">
        Built {BUILD.date} from <code>{BUILD.commit}</code>. Ours looks for a new version each time
        you come back to it, and offers it at the top of the screen.
      </p>
      {ready ? (
        <button type="button" class="btn sm primary" onClick={applyUpdate}>
          <Icon name="download" size={15} />
          Update to the new version
        </button>
      ) : (
        <button
          type="button"
          class="btn sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await checkForUpdate();
            setBusy(false);
            if (r === 'latest') toast('You have the latest version.');
            if (r === 'offline') toast('Couldn’t check: you seem to be offline.');
          }}
        >
          {busy ? 'Checking…' : 'Check for updates'}
        </button>
      )}
    </section>
  );
}
