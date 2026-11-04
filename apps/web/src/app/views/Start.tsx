// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Onboarding: sign in or up, name, create or join a space, recovery phrase,
 * invite the partner and compare safety codes; or restore keys on a new device.
 */
import {
  checkConfirmation,
  generateRecoveryPhrase,
  normalizePhrase,
  pickConfirmationIndices,
} from '@ours/core/crypto';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../account/api';
import {
  acceptDeviceLink,
  acceptInvite,
  account,
  addPasskey,
  checkPartner,
  createSpace,
  currentSafetyCode,
  invitePartner,
  pendingInvite,
  restoreFromPhrase,
  saveBackup,
  signInWithPasskey,
  startEmail,
} from '../../account/session';
import { mountTurnstile, turnstileEnabled } from '../../account/turnstile';
import { HAS_API } from '../../config';
import { PhraseWords } from '../phrase';
import { Icon, toast } from '../ui';

const errorText = (err: unknown) =>
  err instanceof ApiError
    ? err.message
    : err instanceof Error && err.name === 'NotAllowedError'
      ? 'Cancelled.'
      : 'Something went wrong. Try again.';

function Busy({ busy, children }: { busy: boolean; children: preact.ComponentChildren }) {
  return <span aria-live="polite">{busy ? 'Working…' : children}</span>;
}

/* ---------- sign in / up ---------- */

function SignIn() {
  const [email, setEmail] = useState('');
  const [terms, setTerms] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bot, setBot] = useState<string | null>(null);
  const botEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!turnstileEnabled || sent || !botEl.current) return;
    let remove: (() => void) | undefined;
    let gone = false;
    void mountTurnstile(botEl.current, setBot)
      .then((r) => {
        if (gone) r();
        else remove = r;
      })
      .catch((err: Error) => toast(err.message));
    return () => {
      gone = true;
      remove?.();
    };
  }, [sent]);
  const joining = !!pendingInvite();
  const legal = new URL('legal/', location.href.split('#')[0]).href;
  if (sent) {
    return (
      <section class="card">
        <h2 class="h3">Check your email</h2>
        <p class="d">
          We sent a sign-in link to <b class="ink">{email}</b>. Open it on this device. It works
          once and expires in 15 minutes.
        </p>
        <button type="button" class="linkbtn" onClick={() => setSent(false)}>
          Use a different address
        </button>
      </section>
    );
  }
  return (
    <>
      <section class="card">
        <h2 class="h3">{joining ? 'Join your partner' : 'Sign in or create an account'}</h2>
        <form
          class="stack gap"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              if (turnstileEnabled && !bot) {
                toast('One moment: checking you’re not a bot.');
                return;
              }
              await startEmail(email.trim(), terms, bot ?? undefined);
              setSent(true);
            } catch (err) {
              toast(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div class="field">
            <label for="si-email">Email</label>
            <input
              id="si-email"
              class="txt"
              type="email"
              autocomplete="email"
              required
              value={email}
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
          </div>
          <label class="chkline">
            <input
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.currentTarget.checked)}
            />
            <span>
              New here? I’m 16 or older and accept the <a href={`${legal}terms/`}>terms</a> and{' '}
              <a href={`${legal}privacy/`}>privacy policy</a>.
            </span>
          </label>
          <p class="d small">
            We email you a one-time link. Your address is the one thing about you we can read;
            everything you plan is encrypted before it leaves your device.
          </p>
          {turnstileEnabled && <div ref={botEl} />}
          <button class="btn primary big" type="submit" disabled={busy}>
            <Busy busy={busy}>Email me a link</Busy>
          </button>
        </form>
      </section>
      {'PublicKeyCredential' in window && (
        <button
          type="button"
          class="btn"
          onClick={async () => {
            try {
              await signInWithPasskey();
            } catch (err) {
              toast(errorText(err));
            }
          }}
        >
          Sign in with a passkey
        </button>
      )}
    </>
  );
}

/* ---------- recovery phrase ---------- */

function Recovery({ onDone }: { onDone: () => void }) {
  const [words] = useState(() => generateRecoveryPhrase());
  const [step, setStep] = useState<'show' | 'confirm'>('show');
  const [ask] = useState(() => pickConfirmationIndices(2));
  const [answers, setAnswers] = useState<string[]>(['', '']);
  const [busy, setBusy] = useState(false);
  if (step === 'show') {
    return (
      <section class="card">
        <h2 class="h3">Save your recovery phrase</h2>
        <p class="d">
          These 12 words are the only way back to your private plans and lists if you lose all your
          devices. We don’t keep them, so we can’t show them again. Write them on paper or save them
          in a password manager, and keep them somewhere safe.
        </p>
        <PhraseWords words={words} label="Recovery phrase" />
        <p class="note">
          <Icon name="lock" size={15} />
          <span>
            Lose your devices and these words, and nobody, including us, can recover your data.
          </span>
        </p>
        <button type="button" class="btn primary big" onClick={() => setStep('confirm')}>
          I’ve saved them
        </button>
      </section>
    );
  }
  return (
    <section class="card">
      <h2 class="h3">Check two words</h2>
      <form
        class="stack gap"
        onSubmit={async (e) => {
          e.preventDefault();
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
            await saveBackup(words);
            onDone();
          } catch (err) {
            toast(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {ask.map((index, i) => (
          <div class="field" key={index}>
            <label for={`rc-${index}`}>Word {index + 1}</label>
            <input
              id={`rc-${index}`}
              class="txt"
              type="text"
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              value={answers[i]}
              onInput={(e) => {
                const next = [...answers];
                next[i] = e.currentTarget.value;
                setAnswers(next);
              }}
            />
          </div>
        ))}
        <button class="btn primary big" type="submit" disabled={busy}>
          <Busy busy={busy}>Confirm</Busy>
        </button>
        <button type="button" class="linkbtn" onClick={() => setStep('show')}>
          Show the words again
        </button>
      </form>
    </section>
  );
}

/* ---------- invite + safety code ---------- */

function SafetyCode({ partner }: { partner: string }) {
  const code = currentSafetyCode();
  return (
    <section class="card">
      <h2 class="h3">Compare your safety code</h2>
      <p class="fp">
        <span class="code big">{code}</span>
      </p>
      <p class="d">
        Look at {partner}’s phone. If you both see the same numbers, nobody tampered with your
        invite. If they differ, don’t use this space: make a new invite in person.
      </p>
    </section>
  );
}

function Invite({ onDone }: { onDone: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  useEffect(() => {
    invitePartner()
      .then(setLink)
      .catch((err) => toast(errorText(err)));
  }, []);
  useEffect(() => {
    if (joined) return;
    const t = setInterval(async () => {
      if (await checkPartner().catch(() => false)) setJoined(true);
    }, 5000);
    return () => clearInterval(t);
  }, [joined]);
  if (joined) {
    return (
      <>
        <SafetyCode partner="your partner" />
        <button type="button" class="btn primary big" onClick={onDone}>
          Done
        </button>
      </>
    );
  }
  return (
    <section class="card">
      <h2 class="h3">Invite your partner</h2>
      <p class="d">
        Send this link however you like, or open it on their phone. It works once, for 24 hours.
        Anyone with the link can join, so send it only to them.
      </p>
      {link ? (
        <div class="url">
          <code>{link}</code>
          <button
            type="button"
            class="btn sm"
            onClick={async () => {
              try {
                const nav: { share?: (d: ShareData) => Promise<void>; clipboard: Clipboard } =
                  navigator;
                if (nav.share) await nav.share({ title: 'Join me on Ours', url: link });
                else {
                  await nav.clipboard.writeText(link);
                  toast('Link copied.');
                }
              } catch {
                // share cancelled
              }
            }}
          >
            {'share' in navigator ? 'Share' : 'Copy'}
          </button>
        </div>
      ) : (
        <p class="d">Making a link…</p>
      )}
      <p class="d small" aria-live="polite">
        Waiting for them to join. When they do, you’ll both see a safety code to compare.
      </p>
      <button type="button" class="linkbtn" onClick={onDone}>
        Do this later
      </button>
    </section>
  );
}

/* ---------- name + create / join ---------- */

function Profile({ onCreated }: { onCreated: (joined: boolean) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const joining = !!pendingInvite();
  return (
    <section class="card">
      <h2 class="h3">{joining ? 'Join the space' : 'Set up your space'}</h2>
      <form
        class="stack gap"
        onSubmit={async (e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          setBusy(true);
          try {
            if (joining) await acceptInvite(n);
            else await createSpace(n);
            onCreated(joining);
          } catch (err) {
            toast(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div class="field">
          <label for="pf-name">Your first name</label>
          <input
            id="pf-name"
            class="txt"
            type="text"
            maxLength={40}
            autocomplete="given-name"
            required
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </div>
        <p class="d small">Shown to your partner. It’s encrypted like everything else.</p>
        <button class="btn primary big" type="submit" disabled={busy}>
          <Busy busy={busy}>{joining ? 'Join' : 'Create our space'}</Busy>
        </button>
      </form>
    </section>
  );
}

function RestoreKeys() {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const link = pendingInvite();
  return (
    <section class="card">
      <h2 class="h3">Welcome back</h2>
      <p class="d">
        This device doesn’t have your keys yet. Open a link from another of your devices (Privacy →
        Link a device), or enter your recovery phrase.
      </p>
      {link && (
        <button
          type="button"
          class="btn primary"
          onClick={async () => {
            try {
              await acceptDeviceLink(link);
            } catch (err) {
              toast(errorText(err));
            }
          }}
        >
          Use the device link
        </button>
      )}
      <form
        class="stack gap"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const words = normalizePhrase(phrase);
            if (words.some((w) => w === null) || words.length !== 12) {
              toast('That doesn’t look like a 12-word phrase.');
              return;
            }
            await restoreFromPhrase(words as string[]);
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'That phrase didn’t unlock your backup.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div class="field">
          <label for="rs-phrase">Recovery phrase</label>
          <textarea
            id="rs-phrase"
            class="txt"
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            value={phrase}
            onInput={(e) => setPhrase(e.currentTarget.value)}
          />
        </div>
        <button class="btn primary big" type="submit" disabled={busy}>
          <Busy busy={busy}>Unlock</Busy>
        </button>
      </form>
    </section>
  );
}

/* ---------- the flow ---------- */

type Step = 'auto' | 'recovery' | 'invite' | 'joined' | 'passkey';

export function StartView({ onFinished }: { onFinished: () => void }) {
  const [step, setStep] = useState<Step>('auto');
  const [joined, setJoined] = useState(false);
  const state = account.value;

  let body: preact.ComponentChildren;
  if (!HAS_API) {
    body = (
      <section class="card">
        <h2 class="h3">Accounts aren’t switched on here yet</h2>
        <p class="d">
          This site is running the demo only. Try it with sample data in the meantime.
        </p>
        <a class="btn primary" href="#plan">
          Try the demo
        </a>
      </section>
    );
  } else if (step === 'recovery') {
    body = <Recovery onDone={() => setStep(joined ? 'joined' : 'invite')} />;
  } else if (step === 'invite') {
    body = <Invite onDone={() => setStep('passkey')} />;
  } else if (step === 'joined') {
    body = (
      <>
        <SafetyCode partner="your partner" />
        <button type="button" class="btn primary big" onClick={() => setStep('passkey')}>
          Done
        </button>
      </>
    );
  } else if (step === 'passkey') {
    body = (
      <section class="card">
        <h2 class="h3">Sign in faster next time</h2>
        <p class="d">
          Add a passkey to sign in with your fingerprint, face or screen lock instead of an email
          link.
        </p>
        <div class="btnrow">
          <button
            type="button"
            class="btn primary"
            onClick={async () => {
              try {
                await addPasskey();
                toast('Passkey added.');
                onFinished();
              } catch (err) {
                toast(errorText(err));
              }
            }}
          >
            Add a passkey
          </button>
          <button type="button" class="btn ghost" onClick={onFinished}>
            Not now
          </button>
        </div>
      </section>
    );
  } else if (state.status === 'loading') {
    body = <p class="nothing">Loading…</p>;
  } else if (state.status === 'none') {
    body = <SignIn />;
  } else if (state.status === 'needs-profile') {
    body = (
      <Profile
        onCreated={(wasJoin) => {
          setJoined(wasJoin);
          setStep('recovery');
        }}
      />
    );
  } else if (state.status === 'needs-keys') {
    body = <RestoreKeys />;
  } else {
    body = (
      <section class="card">
        <h2 class="h3">You’re all set</h2>
        <button type="button" class="btn primary" onClick={onFinished}>
          Go to this week
        </button>
      </section>
    );
  }

  return (
    <>
      <header class="vhead">
        <div>
          <p class="eyebrow">Ours</p>
          <h1>{step === 'recovery' ? 'Keep it safe' : 'Get started'}</h1>
        </div>
      </header>
      <div class="cards">{body}</div>
    </>
  );
}
