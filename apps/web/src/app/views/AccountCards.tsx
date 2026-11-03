// SPDX-License-Identifier: AGPL-3.0-or-later
/** Privacy-screen cards for a signed-in account: devices, linking, recovery, sign-out, deletion. */
import { generateRecoveryPhrase } from '@ours/core/crypto';
import { useState } from 'preact/hooks';
import { ApiError, api } from '../../account/api';
import {
  disablePush,
  enablePush,
  type PushState,
  pushState,
  type QuietHours,
  quietHours,
  sendTest,
  setQuietHours,
} from '../../account/notify';
import { linkDevice, me, saveBackup, signOut } from '../../account/session';
import { Icon, Switch, toast } from '../ui';

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : 'never');

export function DevicesCard() {
  const info = me.value;
  const [link, setLink] = useState<string | null>(null);
  if (!info) return null;
  return (
    <section class="card" aria-labelledby="dev-h">
      <h2 class="h3" id="dev-h">
        Devices with your keys
      </h2>
      <ul class="devs">
        {info.devices.map((d) => (
          <li key={d.id}>
            <Icon name={/iPhone|Android/.test(d.label) ? 'phone' : 'laptop'} />
            <span>{d.label}</span>
            <span class="when">
              {d.id === info.device_id ? 'This device' : `Last seen ${when(d.last_seen)}`}
            </span>
            {d.id !== info.device_id && (
              <button
                type="button"
                class="iconbtn"
                aria-label={`Remove ${d.label}`}
                onClick={async () => {
                  try {
                    await api(`/devices/${d.id}`, { method: 'DELETE' });
                    me.value = { ...info, devices: info.devices.filter((x) => x.id !== d.id) };
                    toast(`${d.label} signed out.`);
                  } catch (err) {
                    toast(err instanceof ApiError ? err.message : 'Couldn’t remove that device.');
                  }
                }}
              >
                <Icon name="x" size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <p class="d small">
        Removing a device signs it out. It may still hold a copy of the keys until key rotation
        arrives in a later version.
      </p>
      {link ? (
        <div class="url">
          <code>{link}</code>
          <button
            type="button"
            class="btn sm"
            onClick={async () => {
              await navigator.clipboard?.writeText(link).catch(() => {});
              toast('Link copied. Open it on your new device within 24 hours.');
            }}
          >
            Copy
          </button>
        </div>
      ) : (
        <button
          type="button"
          class="btn sm"
          onClick={async () => {
            try {
              setLink(await linkDevice());
            } catch (err) {
              toast(err instanceof ApiError ? err.message : 'Couldn’t make a link.');
            }
          }}
        >
          Link a new device
        </button>
      )}
    </section>
  );
}

export function RecoveryCard() {
  const [words, setWords] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section class="card" aria-labelledby="rec-h">
      <h2 class="h3" id="rec-h">
        Recovery phrase
      </h2>
      <p class="d">
        Your 12 words are the only way back to your private plans and lists if you lose every
        device. We never store them. Lost the paper? Make a new phrase; the old one stops working.
      </p>
      {words ? (
        <>
          <ol class="words" aria-label="New recovery phrase">
            {words.map((w, i) => (
              <li key={`${i}-${w}`}>{w}</li>
            ))}
          </ol>
          <button
            type="button"
            class="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await saveBackup(words);
                setWords(null);
                toast('New recovery phrase saved. Keep the paper safe.');
              } catch (err) {
                toast(err instanceof ApiError ? err.message : 'Couldn’t save the new phrase.');
              } finally {
                setBusy(false);
              }
            }}
          >
            I’ve written these down
          </button>
        </>
      ) : (
        <button type="button" class="btn sm" onClick={() => setWords(generateRecoveryPhrase())}>
          Make a new phrase
        </button>
      )}
    </section>
  );
}

export function AccountCard() {
  const [armed, setArmed] = useState<'signout' | 'delete' | null>(null);
  const info = me.value;
  return (
    <section class="card" aria-labelledby="acct-h">
      <h2 class="h3" id="acct-h">
        Account
      </h2>
      {info && <p class="d">Signed in as {info.user.email}.</p>}
      <p class="d small">
        Signing out removes your plans and keys from this device. To get them back you’ll need your
        recovery phrase or another signed-in device.
      </p>
      <div class="btnrow">
        <button
          type="button"
          class="btn sm"
          onClick={async () => {
            if (armed !== 'signout') {
              setArmed('signout');
              return;
            }
            await signOut();
            location.hash = '';
          }}
        >
          {armed === 'signout' ? 'Tap again to sign out' : 'Sign out'}
        </button>
        <button
          type="button"
          class="btn sm ghost danger"
          onClick={async () => {
            if (armed !== 'delete') {
              setArmed('delete');
              return;
            }
            try {
              await api('/me', { method: 'DELETE' });
              await signOut(false);
              location.hash = '';
            } catch (err) {
              toast(err instanceof ApiError ? err.message : 'Couldn’t delete the account.');
            }
          }}
        >
          {armed === 'delete' ? 'Tap again: delete everything' : 'Delete account'}
        </button>
      </div>
      {armed === 'delete' && (
        <p class="note" role="alert">
          <Icon name="lock" size={15} />
          <span>
            This deletes your account and everything only you can read, now and for good. Shared
            plans stay with your partner.
          </span>
        </p>
      )}
    </section>
  );
}

const QUIET_OPTIONS: { label: string; value: QuietHours | null }[] = [
  { label: 'Off', value: null },
  { label: '9 PM to 7 AM', value: { start: 21 * 60, end: 7 * 60 } },
  { label: '10 PM to 7 AM', value: { start: 22 * 60, end: 7 * 60 } },
  { label: '10 PM to 8 AM', value: { start: 22 * 60, end: 8 * 60 } },
  { label: '11 PM to 8 AM', value: { start: 23 * 60, end: 8 * 60 } },
];

const PUSH_HINT: Record<PushState, string> = {
  unsupported: 'This browser can’t receive notifications.',
  'needs-install':
    'On iPhone and iPad, add Ours to your Home Screen first (Share, then “Add to Home Screen”), then open it from there.',
  unavailable: 'Notifications aren’t set up on this server yet.',
  denied: 'Notifications are blocked for this site. Allow them in your browser settings.',
  off: 'Get a heads-up when your partner asks about a plan or answers yours, and reminders you set.',
  on: 'On for this device. The text is encrypted: the server only knows when to send.',
};

export function NotificationsCard() {
  const state = pushState.value;
  const quiet = quietHours.value;
  const [busy, setBusy] = useState(false);
  const can = state === 'on' || state === 'off';
  const current = QUIET_OPTIONS.findIndex(
    (o) =>
      (o.value === null && quiet === null) ||
      (o.value && quiet && o.value.start === quiet.start && o.value.end === quiet.end),
  );
  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card" aria-labelledby="notif-h">
      <h2 class="h3" id="notif-h">
        Notifications
      </h2>
      {can ? (
        <Switch
          checked={state === 'on'}
          onChange={(on) =>
            void run(on ? enablePush : disablePush, on ? 'Notifications on.' : 'Notifications off.')
          }
          label="Notifications on this device"
          hint={PUSH_HINT[state]}
        />
      ) : (
        <p class="d">{PUSH_HINT[state]}</p>
      )}
      {state === 'on' && (
        <>
          <div class="field">
            <label for="quiet">Quiet hours</label>
            <select
              id="quiet"
              class="txt"
              value={String(Math.max(current, 0))}
              disabled={busy}
              onChange={(e) => {
                const o = QUIET_OPTIONS[Number(e.currentTarget.value)];
                void run(() => setQuietHours(o?.value ?? null), 'Quiet hours saved.');
              }}
            >
              {QUIET_OPTIONS.map((o, i) => (
                <option key={o.label} value={String(i)}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <p class="d small">
            Your partner’s messages wait until quiet hours end. Reminders you set still arrive on
            time.
          </p>
          <div class="btnrow">
            <button
              type="button"
              class="btn sm"
              disabled={busy}
              onClick={() => void run(sendTest, 'Test sent. It should arrive in a few seconds.')}
            >
              Send a test
            </button>
          </div>
        </>
      )}
    </section>
  );
}
