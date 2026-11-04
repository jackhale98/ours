// SPDX-License-Identifier: AGPL-3.0-or-later
/** Privacy-screen cards for a signed-in account: devices, linking, recovery, sign-out, deletion. */
import {
  checkConfirmation,
  generateRecoveryPhrase,
  pickConfirmationIndices,
} from '@ours/core/crypto';
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api } from '../../account/api';
import { kvGet } from '../../account/db';
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
import { providerName, type UnlockStatus, unlockStatus } from '../../account/passkeys';
import {
  abandonRotation,
  account,
  addPasskey,
  commitRotation,
  comparedVersion,
  confirmItsYou,
  currentSafetyCode,
  currentVersions,
  disablePasskeyUnlock,
  dismissPhraseKept,
  enablePasskeyUnlock,
  keyUpdateLink,
  linkDevice,
  loadPasskeys,
  markCompared,
  me,
  needsConfirm,
  partnerNeedsKeyLink,
  passkeyList,
  passkeyUnlocks,
  phraseKept,
  prepareRotation,
  removePasskey,
  replacedFeed,
  retryRotation,
  rotation,
  rotationBlocked,
  saveBackup,
  signOut,
  unlocksMadeHere,
} from '../../account/session';
import { needsNewKeys } from '../../account/sync';
import { nameOf, partner, settings, updateSettings, viewer } from '../model';
import { PhraseWords } from '../phrase';
import { QrCode } from '../qr';
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
        <div class="stack gap">
          <div class="qrbox">
            <QrCode text={link} label="QR code of the device link" />
            <p class="d small">
              On your new device, sign in, then choose <b>Scan a code</b> on the Welcome back
              screen, or point its camera here. Only your own account can use it, once, within 24
              hours. Don’t show it to anyone else.
            </p>
          </div>
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

/**
 * Passkeys, and letting one unlock your keys on a new device (ADR 0015).
 * Off unless turned on, with the trade-off said plainly. Each passkey says
 * who made it and what it can do; passkeys added before the latest change of
 * keys can't unlock (review 0006, M1).
 */
export function PasskeysCard() {
  const info = me.value;
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const changedAt = info?.user.keys_changed_at ?? null;
  const clearedKey = `ours-lost-device-removed-${changedAt}`;
  const [cleared, setCleared] = useState(() => {
    try {
      return !!changedAt && localStorage.getItem(clearedKey) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    void loadPasskeys().catch(() => {});
  }, []);
  if (!info) return null;
  const list = passkeyList.value ?? [];
  const copies = new Map((passkeyUnlocks.value ?? []).map((u) => [u.passkey_id, u]));
  const now = currentVersions() ?? { space: 1, personal: 1 };
  const status = (p: (typeof list)[number]) =>
    unlockStatus(p, copies.get(p.id), now, unlocksMadeHere.value);
  const on = !!info.passkey_unlock;
  const anyEligible = list.some((p) => p.can_unlock && p.prf !== false && !copies.has(p.id));
  const anyUnsupported = on && list.some((p) => status(p) === 'unsupported');
  const anyTooOld = on && list.some((p) => !p.can_unlock);
  const partnerName = nameOf(partner.value);
  // After a change of keys, a new passkey is only safe once the lost device
  // is out of the account it would sync through (review 0006, N3). Asked only
  // while unlocking is on, and only until a passkey is added after the change
  // (F3); the answer is kept on this device for that change of keys.
  const addedSince = list.some((p) => p.can_unlock);
  const askCleared = on && !!changedAt && !cleared && !addedSince;
  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reauth_required')
        toast(
          'For safety, adding a passkey needs a fresh sign-in. Sign out and in, then try again.',
        );
      else toast(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };
  const WHAT: Record<UnlockStatus, string> = {
    unsupported: 'signs in only: its app can’t unlock keys',
    'too-old': 'signs in only: added before you changed your keys',
    off: 'signs in',
    current: 'signs in and unlocks your keys',
    behind: 'unlocks your older keys only',
    'behind-elsewhere': 'unlocks older keys only; set up on another device',
  };
  return (
    <section class="card" aria-labelledby="pk-h">
      <h2 class="h3" id="pk-h">
        Passkeys
      </h2>
      <p class="d">
        A passkey signs you in with your face, fingerprint or device passcode.
        {on
          ? ' It can also unlock your keys on a new device, so you don’t need a device link or your recovery phrase.'
          : ''}
      </p>
      {list.length ? (
        <ul class="devs">
          {list.map((p, i) => {
            const st = status(p);
            const name = providerName(p.aaguid) ?? `Passkey ${i + 1}`;
            return (
              <li key={p.id}>
                <Icon name="lock" />
                <span>
                  {name}
                  <span class="small muted">
                    {' '}
                    · added {when(p.created_at)} · {on ? WHAT[st] : 'signs in'}
                  </span>
                </span>
                <span class="btnrow">
                  {on && st === 'behind' && (
                    <button
                      type="button"
                      class="linkbtn"
                      disabled={busy}
                      onClick={() => void run(() => enablePasskeyUnlock(p.id), 'Updated.')}
                    >
                      Update
                    </button>
                  )}
                  {on && st !== 'off' && st !== 'too-old' && st !== 'unsupported' && (
                    <button
                      type="button"
                      class="linkbtn"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => disablePasskeyUnlock(p.id),
                          'It no longer unlocks your keys.',
                        )
                      }
                    >
                      Stop unlocking
                    </button>
                  )}
                  <button
                    type="button"
                    class="iconbtn"
                    aria-label={`Remove ${name}, added ${when(p.created_at)}`}
                    disabled={busy}
                    onClick={() => void run(() => removePasskey(p.id), 'Passkey removed.')}
                  >
                    <Icon name="x" size={16} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="d small">No passkeys yet.</p>
      )}
      {on && list.some((p) => status(p) === 'behind-elsewhere') && (
        <p class="note">
          <Icon name="lock" size={15} />
          <span>
            A passkey’s unlocking was set up on another device and holds older keys. If you don’t
            recognise it, remove that passkey.
          </span>
        </p>
      )}
      {anyUnsupported && (
        <p class="d small">
          Some passkey apps can sign you in but can’t unlock keys. Passkeys saved in iCloud Keychain
          (iOS 18 or later) or Google Password Manager can. To use one, choose it when you add a
          passkey.
        </p>
      )}
      {anyTooOld && (
        <p class="d small">
          Passkeys added before you last changed your keys can still sign you in, but can’t unlock:
          the lost device may have them. Remove them, and add a new passkey once the lost device is
          out of your Apple, Google or password manager account.
        </p>
      )}
      {on && changedAt && !addedSince && (
        <label class="chkline">
          <input
            type="checkbox"
            checked={cleared}
            onChange={(e) => {
              const v = e.currentTarget.checked;
              setCleared(v);
              try {
                if (v) localStorage.setItem(clearedKey, '1');
                else localStorage.removeItem(clearedKey);
              } catch {
                // Private mode: asked again next time.
              }
            }}
          />
          <span>
            I’ve removed the lost device from my Apple, Google or password manager account, so a new
            passkey won’t sync to it.
          </span>
        </label>
      )}
      {on &&
        anyEligible &&
        (armed ? (
          <div class="stack gap">
            <p class="d small">
              Turning this on means anyone who can use this passkey can read your plans on a new
              device. With iCloud Keychain or Google Password Manager, that’s someone with your
              account and one of your device passcodes, or your phone and its passcode; with a
              password manager, its master password may be enough. Leave it off if someone close to
              you knows your passcode. Don’t share this passkey with {partnerName} (a shared
              passwords group): it would open your private plans too.
            </p>
            <div class="btnrow">
              <button
                type="button"
                class="btn sm primary"
                disabled={busy || askCleared}
                onClick={() =>
                  void run(
                    () => enablePasskeyUnlock(),
                    'Done. That passkey can now unlock your keys.',
                  )
                }
              >
                Choose a passkey
              </button>
              <button type="button" class="btn sm ghost" onClick={() => setArmed(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" class="btn sm" disabled={busy} onClick={() => setArmed(true)}>
            Let a passkey unlock my keys
          </button>
        ))}
      <button
        type="button"
        class="btn sm"
        disabled={busy || askCleared}
        onClick={() =>
          void run(async () => {
            // A recent sign-in, or a fresh check with a passkey you have.
            if (needsConfirm()) await confirmItsYou();
            await addPasskey();
            await loadPasskeys();
          }, 'Passkey added.')
        }
      >
        Add a passkey
      </button>
      {on && (
        <p class="d small">
          Changing your keys (Secure your space) turns unlocking off for all your passkeys, and
          older passkeys can’t unlock again. Before adding a new one after losing a device, remove
          that device from your Apple, Google or password manager account: until then, any passkey
          you make syncs to it too.
        </p>
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

/** Why this device's last notification was or wasn't shown in full (from the service worker). */
const PUSH_OUTCOME: Record<string, string> = {
  shown: 'shown in full.',
  'keys-unreadable':
    'it could only say “Something changed”: this browser wouldn’t let notifications read your keys in the background. Open Ours to see what changed: it’s listed at the top of the plan.',
  'no-keys': 'it could only say “Something changed”: this device didn’t have your keys yet.',
  'key-missing':
    'it could only say “Something changed”: it was sealed with keys this device doesn’t have yet.',
  'not-authentic': 'it didn’t check out, so only “Something changed” was shown.',
  early: 'it could only say “Something changed”: its time didn’t fit. Check this device’s clock.',
  expired:
    'it could only say “Something changed”: it arrived too late (or check this device’s clock).',
  duplicate: 'it arrived twice; the copy said “Something changed”.',
  'no-payload': 'it could only say “Something changed”.',
};

function LastPush() {
  const [last, setLast] = useState<{ at: number; outcome: string } | null>(null);
  useEffect(() => {
    const read = () =>
      void kvGet<{ at: number; outcome: string }>('push-last')
        .then((v) => setLast(v ?? null))
        .catch(() => {});
    read();
    // Read again when a push arrives (the service worker says so) or the app comes back.
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'ours-sync') read();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVisible);
    // And now and then while shown: a local read, nothing is sent.
    const every = setInterval(() => {
      if (document.visibilityState === 'visible') read();
    }, 5_000);
    return () => {
      clearInterval(every);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  if (!last) return null;
  const mins = Math.round((Date.now() - last.at) / 60_000);
  const ago =
    mins < 1
      ? 'just now'
      : mins < 60
        ? `${mins} min ago`
        : mins < 48 * 60
          ? `${Math.round(mins / 60)} h ago`
          : `${Math.round(mins / 1440)} days ago`;
  return (
    <p class="d small">
      Last notification here ({ago}): {PUSH_OUTCOME[last.outcome] ?? 'unknown.'}
    </p>
  );
}

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
          <LastPush />
          <Switch
            checked={settings.value.notify_notes?.[viewer.value] !== false}
            onChange={(on) =>
              updateSettings({
                notify_notes: { ...settings.value.notify_notes, [viewer.value]: on },
              })
            }
            label={`When ${nameOf(partner.value)} adds a note to a plan`}
            hint="Plans they ask you about, and their answers, always come through."
          />
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

      {phraseKept.value && !words && (
        <div class="stack gap">
          <p class="d">
            The keys didn’t change, but your new recovery phrase was saved. Keep it: it’s now the
            one that restores your keys, and the old one no longer does.
          </p>
          <button type="button" class="btn sm" onClick={() => void dismissPhraseKept()}>
            Got it
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
