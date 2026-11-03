// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 3 acceptance: two people sign up, pair with an invite link, compare
 * safety codes, and a plan created on one device appears on the other.
 * Private plans reach the partner only as "Busy".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';

const STATE_DIR = new URL('../../api/.wrangler/state/e2e', import.meta.url).pathname;

const API = 'http://localhost:8788';

async function magicLink(page: Page, email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const res = await page.request.get(`${API}/dev/outbox?to=${encodeURIComponent(email)}`);
    const mails = (await res.json()) as { text: string }[];
    const link = mails.at(-1)?.text.match(/(http\S+#signin=[A-Za-z0-9_-]{43})/)?.[1];
    if (link) return link;
    await page.waitForTimeout(100);
  }
  throw new Error(`no magic link for ${email}`);
}

async function signUp(page: Page, email: string) {
  await expect(
    page.getByRole('heading', { name: /Sign in or create an account|Join your partner/ }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('checkbox', { name: /16 or older/ }).check();
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await magicLink(page, email));
}

async function recoveryPhrase(page: Page) {
  await expect(
    page.getByRole('heading', { name: 'Write down your recovery phrase' }),
  ).toBeVisible();
  const words = await page
    .getByRole('list', { name: 'Recovery phrase' })
    .getByRole('listitem')
    .allTextContents();
  expect(words).toHaveLength(12);
  await page.getByRole('button', { name: 'I’ve written them down' }).click();
  for (const label of await page.locator('label[for^="rc-"]').allTextContents()) {
    const n = Number(label.replace(/\D/g, ''));
    await page.getByRole('textbox', { name: label, exact: true }).fill(words[n - 1] ?? '');
  }
  await page.getByRole('button', { name: 'Confirm' }).click();
  return words;
}

async function newPage(browser: Browser) {
  const context = await browser.newContext();
  return context.newPage();
}

/**
 * Headless browsers can't reach a real push service, so this stands in for
 * the browser's PushManager: a subscription with real P-256 keys on an
 * allowed push-service address. The private key stays in the test, which
 * plays the push service and the browser's decryption step.
 */
async function fakePushManager(page: Page) {
  await page.context().grantPermissions(['notifications'], { origin: 'http://localhost:4174' });
  await page.addInitScript(() => {
    const b64 = (b: ArrayBuffer | Uint8Array) =>
      btoa(String.fromCharCode(...new Uint8Array(b)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const load = () => {
      const raw = localStorage.getItem('e2e-push');
      return raw ? (JSON.parse(raw) as { endpoint: string; p256dh: string; auth: string }) : null;
    };
    const asSub = (s: { endpoint: string; p256dh: string; auth: string }) => ({
      endpoint: s.endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }),
      unsubscribe: async () => {
        localStorage.removeItem('e2e-push');
        return true;
      },
    });
    PushManager.prototype.getSubscription = async () => {
      const s = load();
      return (s ? asSub(s) : null) as unknown as PushSubscription;
    };
    PushManager.prototype.subscribe = async () => {
      const keys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits',
      ])) as CryptoKeyPair;
      const s = {
        endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${Date.now()}`,
        p256dh: b64(await crypto.subtle.exportKey('raw', keys.publicKey)),
        auth: b64(crypto.getRandomValues(new Uint8Array(16))),
        jwk: await crypto.subtle.exportKey('jwk', keys.privateKey),
      };
      localStorage.setItem('e2e-push', JSON.stringify(s));
      return asSub(s) as unknown as PushSubscription;
    };
  });
}

const unb64 = (t: string) => Buffer.from(t, 'base64url');

/** RFC 8291 decryption, as the receiving browser does it. */
async function openWebPush(
  pushBody: Buffer,
  sub: { p256dh: string; auth: string; jwk: JsonWebKey },
): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const u8 = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);
  const body = u8(pushBody);
  const salt = body.slice(0, 16);
  const idlen = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idlen);
  const ecdhAlg = { name: 'ECDH', namedCurve: 'P-256' };
  const priv = await subtle.importKey('jwk', sub.jwk, ecdhAlg, false, ['deriveBits']);
  const sender = await subtle.importKey('raw', asPublic, ecdhAlg, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: sender }, priv, 256));
  const hkdf = async (
    s: Uint8Array<ArrayBuffer>,
    ikm: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>,
    bits: number,
  ) =>
    new Uint8Array(
      await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: s, info },
        await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
        bits,
      ),
    );
  const text = (t: string) => u8(Buffer.from(t));
  const ua = u8(unb64(sub.p256dh));
  const info = u8(Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic]));
  const ikm = await hkdf(u8(unb64(sub.auth)), ecdh, info, 256);
  const cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 96);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = Buffer.from(
    await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)),
  );
  return plain.subarray(0, -1).toString('utf8');
}

test('sign up, pair, compare safety codes, and sync plans both ways', async ({ browser }) => {
  const stamp = Date.now();
  const sam = await newPage(browser);
  const alex = await newPage(browser);
  await fakePushManager(alex);

  // Sam creates the space.
  await sam.goto('/#start');
  await signUp(sam, `sam-${stamp}@example.com`);
  await sam.getByRole('textbox', { name: 'Your first name' }).fill('Sam');
  await sam.getByRole('button', { name: 'Create our space' }).click();
  await recoveryPhrase(sam);
  await expect(sam.getByRole('heading', { name: 'Invite your partner' })).toBeVisible();
  const invite = (await sam.locator('.url code').textContent()) ?? '';
  expect(invite).toMatch(/\/join\/#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);

  // Alex joins with the link.
  await alex.goto(invite);
  await expect(alex).toHaveURL(/#start$/);
  await signUp(alex, `alex-${stamp}@example.com`);
  await alex.getByRole('textbox', { name: 'Your first name' }).fill('Alex');
  await alex.getByRole('button', { name: 'Join' }).click();
  await recoveryPhrase(alex);
  await expect(alex.getByRole('heading', { name: 'Compare your safety code' })).toBeVisible();
  const alexCode = await alex.locator('.code').textContent();

  // Sam's invite screen notices Alex joined; the codes match.
  await expect(sam.getByRole('heading', { name: 'Compare your safety code' })).toBeVisible({
    timeout: 20_000,
  });
  expect(await sam.locator('.code').textContent()).toBe(alexCode);
  expect(alexCode).toMatch(/^\d{3} \d{3} \d{3}$/);

  for (const page of [sam, alex]) {
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
    // No sample data in a real account.
    await expect(page.getByText('Late shift')).toHaveCount(0);
  }

  // Alex turns on notifications on their device.
  await alex.goto('/#privacy');
  const toggle = alex.getByRole('switch', { name: 'Notifications on this device' });
  await toggle.click();
  await expect(alex.locator('.toast-host')).toContainText('Notifications on.');
  await expect(toggle).toBeChecked();
  const alexSub = JSON.parse(
    (await alex.evaluate(() => localStorage.getItem('e2e-push'))) ?? 'null',
  ) as { endpoint: string; p256dh: string; auth: string; jwk: JsonWebKey };
  expect(alexSub.endpoint).toContain('fcm.googleapis.com');

  // Sam proposes a shared plan.
  await sam.keyboard.press('n');
  await sam.getByRole('textbox', { name: 'What’s the plan?' }).fill('Dinner tomorrow 7pm @ Vic’s');
  await sam.getByRole('button', { name: 'Send to Alex' }).click();
  await expect(sam.getByRole('button', { name: /Dinner/ })).toBeVisible();

  // The Worker pushed a notification to Alex's subscription. Everything it
  // handled is ciphertext: the push body, and the wrapper inside it.
  let pushed: { endpoint: string; body: string; ttl: string } | undefined;
  for (let i = 0; i < 100 && !pushed; i++) {
    const all = (await (await sam.request.get(`${API}/dev/pushes`)).json()) as {
      endpoint: string;
      body: string;
      ttl: string;
    }[];
    pushed = all.find((p) => p.endpoint === alexSub.endpoint);
    if (!pushed) await sam.waitForTimeout(100);
  }
  expect(pushed, 'a push for Alex').toBeTruthy();
  const pushBody = unb64(pushed?.body ?? '');
  for (const secret of ['Dinner', 'Vic', 'Sam asked']) {
    expect(pushBody.includes(Buffer.from(secret))).toBe(false);
  }
  const wrapper = await openWebPush(pushBody, alexSub);
  expect(Object.keys(JSON.parse(wrapper)).sort()).toEqual(['c', 'k', 'p', 's', 'v']);
  for (const secret of ['Dinner', 'Vic', 'Sam asked']) expect(wrapper).not.toContain(secret);

  // Hand it to Alex's service worker the way the browser would: it decrypts
  // with Alex's keys and shows the notification, with a "Yes" action.
  const cdp = await alex.context().newCDPSession(alex);
  const registration = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
      const r = e.registrations.find((x) => x.scopeURL.startsWith('http://localhost:4174'));
      if (r) resolve(r.registrationId);
    });
  });
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: 'http://localhost:4174',
    registrationId: await registration,
    data: wrapper,
  });
  await expect
    .poll(
      () =>
        alex.evaluate(async () =>
          (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({
            title: n.title,
            body: n.body,
          })),
        ),
      { timeout: 10_000 },
    )
    .toEqual([{ title: 'Sam asked: Dinner', body: expect.stringContaining('7 PM') }]);
  // A replayed push is never shown again: only a generic notice, no text.
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: 'http://localhost:4174',
    registrationId: await registration,
    data: wrapper,
  });
  await expect
    .poll(
      () =>
        alex.evaluate(async () =>
          (await (await navigator.serviceWorker.ready).getNotifications())
            .map((n) => `${n.title}|${n.body}`)
            .sort(),
        ),
      { timeout: 10_000 },
    )
    .toEqual([
      'Ours|Something changed. Open Ours to see it.',
      expect.stringMatching(/^Sam asked: Dinner\|/),
    ]);

  // Sam also adds a private plan.
  await sam.keyboard.press('n');
  await sam
    .getByRole('textbox', { name: 'What’s the plan?' })
    .fill('Surprise shopping tomorrow 1pm');
  await sam.getByRole('dialog').getByRole('button', { name: 'Mine' }).click();
  await sam.getByRole('switch', { name: /Keep the details private/ }).check();
  await sam.getByRole('button', { name: 'Add plan' }).click();
  await expect(sam.locator('.rail .demo')).toHaveText('Synced', { timeout: 15_000 });

  // Alex sees the proposal (and only "Busy" for the private plan), and accepts.
  await alex.goto('/#plan');
  await alex.reload();
  await expect(alex.getByText('Sam asked · needs your answer')).toBeVisible({ timeout: 15_000 });
  await expect(alex.getByText('Surprise shopping')).toHaveCount(0);
  await expect(alex.locator('.ev.is-masked').first()).toContainText('Busy');
  await alex.locator('.ask').getByRole('button', { name: 'Yes, add it' }).click();
  await expect(alex.locator('.rail .demo')).toHaveText('Synced', { timeout: 15_000 });

  // Sam sees the yes.
  await sam.reload();
  await expect(sam.getByText('Waiting on Alex')).toHaveCount(0, { timeout: 15_000 });
  await expect(sam.getByRole('button', { name: /Dinner/ })).toBeVisible();

  // End-to-end encryption: the server's database files contain none of the
  // plaintext (titles, place, names), only ciphertext.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(STATE_DIR);
  expect(files.some((f) => f.endsWith('.sqlite'))).toBe(true);
  for (const f of files) {
    const bytes = readFileSync(f);
    for (const secret of ['Dinner', 'Surprise shopping', 'Vic’s', '"Sam"', '"Alex"']) {
      expect(bytes.includes(Buffer.from(secret)), `${secret} found in ${f}`).toBe(false);
    }
  }

  // The busy-time feed: Sam turns it on and a calendar app can read it.
  await sam.goto('/#privacy');
  await sam.getByRole('button', { name: 'Turn on the feed' }).click();
  const feedUrl =
    (await sam.locator('section[aria-labelledby="feed-h"] .url code').textContent()) ?? '';
  expect(feedUrl).toMatch(/^http:\/\/localhost:8788\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
  await expect(sam.getByRole('link', { name: 'Add to Apple Calendar' })).toHaveAttribute(
    'href',
    feedUrl.replace(/^http/, 'webcal'),
  );
  let ics = '';
  for (let i = 0; i < 50 && !ics.includes('BEGIN:VEVENT'); i++) {
    ics = await (await sam.request.get(feedUrl)).text();
    if (!ics.includes('BEGIN:VEVENT')) await sam.waitForTimeout(200);
  }
  expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  expect(ics).toContain('SUMMARY:Busy');
  for (const secret of ['Dinner', 'Surprise', 'Vic']) expect(ics).not.toContain(secret);

  // Key rotation (ADR 0013): Sam secures the space after losing a device.
  const oldCode = await sam.evaluate(() => document.querySelector('.code')?.textContent ?? null);
  await sam.goto('/#privacy');
  const secure = sam.locator('section[aria-labelledby="secure-h"]');
  await secure.getByRole('button', { name: 'Make new keys' }).click();
  await secure.getByRole('button', { name: 'Yes, make new keys' }).click();
  const rekeyLink = (await secure.locator('.url code').textContent({ timeout: 20_000 })) ?? '';
  expect(rekeyLink).toMatch(/\/join\/#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  await secure.getByRole('button', { name: 'Next: new recovery phrase' }).click();
  await secure.getByRole('button', { name: 'I’ve written these down' }).click();
  await expect(secure).toContainText('Your space has new keys');
  await expect(sam.locator('.rail .demo')).toHaveText('Synced', { timeout: 20_000 });

  // Alex's device notices the new keys are missing, but keeps working.
  await alex.goto('/#plan');
  await alex.reload();
  await expect(alex.locator('.keybanner')).toContainText('Sam changed your shared keys');
  await expect(alex.getByRole('button', { name: /Dinner/ }).first()).toBeVisible();
  // A plan made now is kept on Alex's device until the keys arrive.
  await alex.keyboard.press('n');
  await alex.getByRole('textbox', { name: 'What’s the plan?' }).fill('Picnic tomorrow 2pm');
  await alex.getByRole('dialog').getByRole('button', { name: 'Ours' }).click();
  await alex
    .getByRole('dialog')
    .getByRole('button', { name: /Add plan|Send to Sam/ })
    .click();
  await expect(alex.getByRole('button', { name: /Picnic/ })).toBeVisible();

  // Alex opens the key update link: banner gone, the held plan syncs to Sam.
  await alex.goto(rekeyLink);
  await expect(alex.locator('.toast-host')).toContainText('New keys added', { timeout: 20_000 });
  await expect(alex.locator('.keybanner')).toHaveCount(0);
  await expect(alex.locator('.rail .demo')).toHaveText('Synced', { timeout: 20_000 });
  await sam.goto('/#plan');
  await sam.reload();
  await expect(sam.getByRole('button', { name: /Picnic/ }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(sam.getByRole('button', { name: /Dinner/ }).first()).toBeVisible();

  // The safety code changed, and both see the same new one.
  await sam.goto('/#privacy');
  await alex.goto('/#privacy');
  const samCode = await sam.locator('.code').first().textContent();
  expect(samCode).not.toBe(oldCode);
  expect(await alex.locator('.code').first().textContent()).toBe(samCode);
});
