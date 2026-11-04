// SPDX-License-Identifier: AGPL-3.0-or-later
/** Privacy-screen cards for a signed-in account: devices, linking, recovery, sign-out, deletion. */
import {
  checkConfirmation,
  generateRecoveryPhrase,
  pickConfirmationIndices,
} from '@ours/core/crypto';
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
import {
  abandonRotation,
  account,
  commitRotation,
  comparedVersion,
  confirmItsYou,
  currentSafetyCode,
  keyUpdateLink,
  linkDevice,
  markCompared,
  me,
  needsConfirm,
  partnerNeedsKeyLink,
  prepareRotation,
  replacedFeed,
  retryRotation,
  rotation,
  rotationBlocked,
  saveBackup,
  signOut,
} from '../../account/session';
import { needsNewKeys } from '../../account/sync';
import { nameOf, partner } from '../model';
import { PhraseWords } from '../phrase';
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
        Removing a device signs it out immediately. It may still hold a copy of the keys for what it
        already downloaded.
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
        device. We never store them. Lost them? Make a new phrase; the old one stops working.
      </p>
      {words ? (
        <>
          <PhraseWords words={words} label="New recovery phrase" />
          <button
            type="button"
            class="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await saveBackup(words);
                setWords(null);
                toast('New recovery phrase saved. Keep your copy safe.');
              } catch (err) {
                toast(err instanceof ApiError ? err.message : 'Couldn’t save the new phrase.');
              } finally {
                setBusy(false);
              }
            }}
          >
            I’ve saved these
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

/**
 * After losing a device (or a partner leaving): new keys, old ones
 * decrypt-only, everything re-encrypted (ADR 0013). In this order, so an
 * interruption never loses data (review 0005, H2): new keys made and kept
 * apart; a new recovery phrase shown and two words checked; the backup saved
 * over old and new keys; only then the server makes the new keys current.
 * Then the partner gets a key update link (which can be made again until
 * they have the keys, M3), and both compare the new safety code (I3).
 */
export function SecureCard() {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [ask, setAsk] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(['', '']);
  const [link, setLink] = useState<string | null>(null);
  const partnerName = nameOf(partner.value);
  const st = rotation.value;
  const blocked = rotationBlocked();
  const info = me.value;
  const code = currentSafetyCode();
  const space = info?.spaces[0];
  const toCompare =
    account.value.status === 'ready' &&
    account.value.partnerJoined &&
    (space?.key_version ?? 1) > comparedVersion.value &&
    !needsNewKeys.value;

  const start = async () => {
    setBusy(true);
    try {
      if (needsConfirm()) await confirmItsYou();
      const w = await prepareRotation();
      setWords(w);
      setAsk(pickConfirmationIndices(2));
      setAnswers(['', '']);
      setChecking(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Couldn’t start. Try again.');
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  const commit = async (e: Event) => {
    e.preventDefault();
    if (!words) return;
    const ok = checkConfirmation(
      words,
      ask.map((index, i) => ({ index, word: answers[i] ?? '' })),
    );
    if (!ok) {
      toast('Those don’t match. Check your copy and try again.');
      return;
    }
    setBusy(true);
    try {
      if (needsConfirm()) await confirmItsYou();
      await commitRotation(words);
      setWords(null);
      toast('Done. Your space has new keys.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reauth_required') {
        toast('Confirm it’s you with your passkey, then press Save again.');
        if (me.value) me.value = { ...me.value, signed_in_at: 0 };
      } else {
        toast(err instanceof Error ? err.message : 'Couldn’t change the keys. Try again.');
      }
      if (rotation.value?.stage !== 'staged') setWords(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card" aria-labelledby="secure-h">
      <h2 class="h3" id="secure-h">
        Secure your space
      </h2>

      {words ? (
        checking ? (
          <form class="stack gap" onSubmit={commit}>
            <p class="d">Check two words from your new phrase, then the new keys go live.</p>
            <div class="confirmwords">
              {ask.map((index, i) => (
                <div class="field" key={index}>
                  <label for={`rot-${index}`}>Word {index + 1}</label>
                  <input
                    id={`rot-${index}`}
                    class="txt"
                    type="text"
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck={false}
                    value={answers[i]}
                    onInput={(ev) => {
                      const next = [...answers];
                      next[i] = ev.currentTarget.value;
                      setAnswers(next);
                    }}
                  />
                </div>
              ))}
            </div>
            <div class="btnrow">
              <button type="submit" class="btn sm primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save and use the new keys'}
              </button>
              <button type="button" class="btn sm ghost" onClick={() => setChecking(false)}>
                Show the words again
              </button>
            </div>
          </form>
        ) : (
          <>
            <p class="d">
              Your old recovery phrase can’t restore the new keys. Write down these 12 words
              instead. Nothing changes until you’ve checked them.
            </p>
            <PhraseWords words={words} label="New recovery phrase" />
            <div class="btnrow">
              <button type="button" class="btn sm primary" onClick={() => setChecking(true)}>
                I’ve saved these
              </button>
              <button
                type="button"
                class="btn sm ghost"
                onClick={async () => {
                  await abandonRotation();
                  setWords(null);
                }}
              >
                Cancel
              </button>
            </div>
          </>
        )
      ) : st?.stage === 'staged' && st.backup ? (
        <>
          <p class="d">
            Your new phrase is saved, but the server didn’t confirm the new keys. Nothing is lost.
          </p>
          <div class="btnrow">
            <button
              type="button"
              class="btn sm primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await retryRotation();
                  toast('Done. Your space has new keys.');
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Still couldn’t. Try again later.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Try again
            </button>
          </div>
        </>
      ) : (
        <>
          <p class="d">
            Lost a phone, or removed a device you don’t trust? Make new keys. Nothing written from
            then on can be read with the old ones. You’ll write down a new recovery phrase, and send{' '}
            {partnerName} a one-time link.
          </p>
          <p class="d small">
            Remove the device in Devices above first. If it could still sign in (a passkey saved on
            it, or your email open on it), remove that passkey and secure your email too, or it
            could sign in again.
          </p>
          {blocked && armed && <p class="d small">{blocked}</p>}
          <button
            type="button"
            class={`btn sm${armed ? ' primary' : ''}`}
            disabled={busy || (armed && !!blocked)}
            onClick={() => (armed ? void start() : setArmed(true))}
          >
            {busy ? 'Making new keys…' : armed ? 'Yes, make new keys' : 'Make new keys'}
          </button>
        </>
      )}

      {!words && partnerNeedsKeyLink() && (
        <div class="stack gap">
          <p class="d">
            {partnerName} still needs the new keys. Send them a one-time link, ideally in person or
            in a private chat. It works once, for 24 hours; you can make another here.
          </p>
          {link ? (
            <div class="url">
              <code>{link}</code>
              <button
                type="button"
                class="btn sm"
                onClick={async () => {
                  if (navigator.share) {
                    await navigator.share({ url: link }).catch(() => {});
                  } else {
                    await navigator.clipboard?.writeText(link).catch(() => {});
                    toast('Link copied.');
                  }
                }}
              >
                Share
              </button>
            </div>
          ) : (
            <button
              type="button"
              class="btn sm"
              onClick={async () => {
                try {
                  setLink(await keyUpdateLink());
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Couldn’t make a link.');
                }
              }}
            >
              Make key update link
            </button>
          )}
        </div>
      )}

      {!words && toCompare && code && (
        <div class="stack gap">
          <p class="d">
            Your keys changed. Compare your safety code with {partnerName}’s, in person or on a
            call: <span class="code">{code}</span>
          </p>
          <button type="button" class="btn sm" onClick={() => void markCompared()}>
            We compared, they match
          </button>
        </div>
      )}

      {replacedFeed.value && (
        <p class="d small">
          Your calendar feed has a new link (the old one stopped working). Update it in your
          calendar app from Calendars below.
        </p>
      )}
    </section>
  );
}
