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

async function signUp(page: Page, email: string, how: 'open' | 'paste' = 'open') {
  await expect(
    page.getByRole('heading', { name: /Sign in or create an account|Join your partner/ }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('checkbox', { name: /16 or older/ }).check();
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = await magicLink(page, email);
  if (how === 'open') {
    await page.goto(link);
    return;
  }
  // An iPhone Home Screen app can't open the link: it's copied and pasted instead.
  await page.getByRole('button', { name: 'Paste the sign-in link' }).click();
  await page.getByRole('textbox', { name: 'Paste the sign-in link' }).fill(link);
  await page.getByRole('button', { name: 'Use this link' }).click();
}

async function recoveryPhrase(page: Page) {
  await expect(page.getByRole('heading', { name: 'Save your recovery phrase' })).toBeVisible();
  const words = await page
    .getByRole('list', { name: 'Recovery phrase' })
    .getByRole('listitem')
    .allTextContents();
  expect(words).toHaveLength(12);
  // One click copies all 12 words, in order, ready to paste back in.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await page.getByRole('button', { name: 'Copy all 12 words' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(words.join(' '));
  await page.getByRole('button', { name: 'I’ve saved them' }).click();
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
  const samEmail = `sam-${stamp}@example.com`;
  const sam = await newPage(browser);
  const alex = await newPage(browser);
  await fakePushManager(alex);

  // Sam creates the space.
  await sam.goto('/#start');
  await signUp(sam, samEmail);
  await sam.getByRole('textbox', { name: 'Your first name' }).fill('Sam');
  await sam.getByRole('button', { name: 'Create our space' }).click();
  await recoveryPhrase(sam);
  await expect(sam.getByRole('heading', { name: 'Invite your partner' })).toBeVisible();
  const invite = (await sam.locator('.url code').textContent()) ?? '';
  expect(invite).toMatch(/\/join\/#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);

  // Alex joins with the link.
  await alex.goto(invite);
  await expect(alex).toHaveURL(/#start$/);
  await signUp(alex, `alex-${stamp}@example.com`, 'paste');
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
    await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeVisible();
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

  // Privacy says why the last notification only said "Something changed".
  await alex.goto('/#privacy');
  await expect(alex.locator('section[aria-labelledby="notif-h"]')).toContainText('arrived twice', {
    timeout: 10_000,
  });

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
  // What Sam changed is listed at the top, for when a notification could
  // only say "Something changed"; never the private plan.
  const news = alex.locator('section[aria-labelledby="news-h"]');
  await expect(news).toContainText('New from Sam');
  await expect(news).toContainText('Dinner');
  await expect(news).not.toContainText('Surprise');
  await news.getByRole('button', { name: 'Got it' }).click();
  await expect(news).toHaveCount(0);
  await alex.locator('.ask').getByRole('button', { name: 'Yes, add it' }).click();
  await expect(alex.locator('.rail .demo')).toHaveText('Synced', { timeout: 15_000 });

  // Sam sees the yes.
  await sam.reload();
  await expect(sam.getByText('Waiting on Alex')).toHaveCount(0, { timeout: 15_000 });
  await expect(sam.locator('.ev', { hasText: 'Dinner' }).first()).toBeVisible();
  // Alex's yes is listed among what's new from Alex.
  await expect(sam.locator('section[aria-labelledby="news-h"]')).toContainText('Dinner');

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

  // A shared list both will edit while their keys differ (review 0005, M5).
  await sam.goto('/#lists');
  await sam.getByRole('button', { name: 'New list' }).click();
  const listDialog = sam.getByRole('dialog', { name: 'New list' });
  await listDialog
    .getByRole('group', { name: 'Start from' })
    .getByRole('button', { name: /^To-dos/ })
    .click();
  await listDialog.getByRole('textbox', { name: 'Name' }).fill('Hardware');
  await listDialog.getByRole('button', { name: 'Make list' }).click();
  await sam.getByRole('textbox', { name: 'Add to Hardware' }).fill('Picture hooks');
  await sam.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sam.locator('.rail .demo')).toHaveText('Synced', { timeout: 20_000 });
  await alex.goto('/#lists');
  await alex.reload();
  await expect(alex.getByText('Picture hooks')).toBeVisible({ timeout: 20_000 });

  // Key rotation (ADR 0013, review 0005): Sam secures the space after losing
  // a device. The new phrase is saved before anything changes on the server.
  const oldCode = await sam.evaluate(() => document.querySelector('.code')?.textContent ?? null);
  await sam.goto('/#privacy');
  const secure = sam.locator('section[aria-labelledby="secure-h"]');
  await secure.getByRole('button', { name: 'Make new keys' }).click();
  await secure.getByRole('button', { name: 'Yes, make new keys' }).click();
  await expect(secure.locator('.words li')).toHaveCount(12, { timeout: 20_000 });
  const words = await secure.locator('.words li').allTextContents();
  expect(words).toHaveLength(12);
  await secure.getByRole('button', { name: 'I’ve saved these' }).click();
  for (const label of await secure.locator('label[for^="rot-"]').allTextContents()) {
    const n = Number(label.replace(/\D/g, ''));
    await secure.getByRole('textbox', { name: label, exact: true }).fill(words[n - 1] ?? '');
  }
  // The first answer is lost on the way back, though the server rotated
  // (re-review N1). Pressing again finds that out instead of losing the keys.
  await sam.route(
    '**/spaces/*/rotate',
    async (route) => {
      await route.fetch();
      await route.abort();
    },
    { times: 1 },
  );
  await secure.getByRole('button', { name: 'Save and use the new keys' }).click();
  await expect(sam.locator('.toast-host')).not.toContainText('Your space has new keys');
  await expect(secure.getByRole('button', { name: 'Save and use the new keys' })).toBeEnabled({
    timeout: 20_000,
  });
  // Pressing again while the server can't be asked what happened keeps the
  // new keys (re-review 2, R1).
  await sam.route('**/me', (route) => route.abort(), { times: 2 });
  await secure.getByRole('button', { name: 'Save and use the new keys' }).click();
  await expect(sam.locator('.toast-host')).toContainText('Couldn’t confirm the change', {
    timeout: 20_000,
  });
  await expect(secure.getByRole('button', { name: 'Save and use the new keys' })).toBeEnabled();
  await secure.getByRole('button', { name: 'Save and use the new keys' }).click();
  await expect(sam.locator('.toast-host')).toContainText('Your space has new keys', {
    timeout: 20_000,
  });
  // Everything is re-encrypted, checked with the server (M2): the banner goes.
  await expect(sam.locator('.keybanner')).toHaveCount(0, { timeout: 30_000 });
  await secure.getByRole('button', { name: 'Make key update link' }).click();
  const rekeyLink = (await secure.locator('.url code').textContent({ timeout: 20_000 })) ?? '';
  expect(rekeyLink).toMatch(/\/join\/#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const newCode = (await sam.locator('.code').first().textContent()) ?? '';
  expect(newCode).not.toBe(oldCode);

  // After rotating, Sam renames the item.
  const editItem = async (page: Page, field: RegExp, value: string) => {
    await page.goto('/#lists');
    await page.getByRole('button', { name: /^Details: Picture hooks/ }).click();
    const sheet = page.getByRole('dialog', { name: /Picture hooks/ });
    await sheet.getByLabel(field).fill(value);
    await sheet.getByRole('button', { name: 'Save' }).click();
  };
  await editItem(sam, /^What/, 'Picture hooks (brass)');
  await expect(sam.locator('.rail .demo')).toHaveText('Synced', { timeout: 20_000 });

  // Alex's device notices the new keys are missing, but keeps working.
  await alex.goto('/#plan');
  await alex.reload();
  await expect(alex.locator('.keybanner')).toContainText('Sam changed your shared keys');
  await expect(alex.getByRole('button', { name: /Dinner/ }).first()).toBeVisible();
  // A plan made now, and a note added to dinner, are kept on Alex's device
  // until the keys arrive.
  await alex.keyboard.press('n');
  await alex.getByRole('textbox', { name: 'What’s the plan?' }).fill('Picnic tomorrow 2pm');
  await alex.getByRole('dialog').getByRole('button', { name: 'Ours' }).click();
  await alex
    .getByRole('dialog')
    .getByRole('button', { name: /Add plan|Send to Sam/ })
    .click();
  await expect(alex.getByRole('button', { name: /Picnic/ })).toBeVisible();
  // Alex, still on the old keys, gives the same item a due date. It waits on
  // the device for the keys: let it reach the device's storage before
  // leaving the page (a slow machine could otherwise still be writing it).
  const pending = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<number>((res, rej) => {
          const r = indexedDB.open('ours');
          r.onerror = () => rej(r.error);
          r.onsuccess = () => {
            const q = r.result.transaction('outbox').objectStore('outbox').count();
            q.onsuccess = () => {
              res(q.result);
              r.result.close();
            };
          };
        }),
    );
  const before = await pending(alex);
  await editItem(alex, /^Due/, '2031-05-20');
  await expect.poll(() => pending(alex), { timeout: 10_000 }).toBeGreaterThan(before);

  // Alex opens the key update link, compares the code with Sam's, and uses it.
  await alex.goto(rekeyLink);
  const prompt = alex.locator('.keylink');
  await expect(prompt).toContainText('New keys from Sam', { timeout: 20_000 });
  expect(await prompt.locator('.code').textContent()).toBe(newCode);
  await prompt.getByRole('button', { name: 'They match, use these keys' }).click();
  await expect(alex.locator('.toast-host')).toContainText('New keys added', { timeout: 20_000 });
  await expect(alex.locator('.keybanner')).not.toContainText('changed your shared keys');
  // Alex's backup can't hold the new key yet: a new phrase is asked for (M3).
  await expect(alex.locator('.keybanner')).toContainText('Make a new phrase');
  await expect(alex.locator('.rail .demo')).toHaveText('Synced', { timeout: 20_000 });

  // Both changes to the item survive, on both sides (M5), and the held plan arrived.
  for (const page of [sam, alex]) {
    await page.goto('/#plan');
    await page.reload();
    await expect(page.getByRole('button', { name: /Picnic/ }).first()).toBeVisible({
      timeout: 20_000,
    });
    await page.goto('/#lists');
    await page.getByRole('button', { name: /^Details: Picture hooks \(brass\)/ }).click({
      timeout: 20_000,
    });
    const sheet = page.getByRole('dialog', { name: /Picture hooks/ });
    await expect(sheet.getByLabel(/^Due/)).toHaveValue('2031-05-20');
    await page.keyboard.press('Escape');
  }

  // A new device restores everything from the new phrase alone (H2).
  const fresh = await newPage(browser);
  await fresh.goto('/#start');
  await signUp(fresh, samEmail);
  await expect(fresh.getByRole('heading', { name: 'Welcome back' })).toBeVisible({
    timeout: 20_000,
  });
  await fresh.getByRole('textbox', { name: 'Recovery phrase' }).fill(words.join(' '));
  await fresh.getByRole('button', { name: 'Unlock' }).click();
  await fresh.goto('/#lists');
  await expect(fresh.getByText('Picture hooks (brass)')).toBeVisible({ timeout: 20_000 });
  await expect(fresh.getByText(/changed your shared keys|keys were changed/)).toHaveCount(0);
  await fresh.context().close();

  // Both see the same new safety code; Sam stops being offered the link (M3).
  await alex.goto('/#privacy');
  expect(await alex.locator('.code').first().textContent()).toBe(newCode);
  await sam.goto('/#privacy');
  await sam.reload();
  await expect(secure.getByRole('button', { name: 'Make key update link' })).toHaveCount(0, {
    timeout: 20_000,
  });
});

test('a partner invite can be made again later, from Privacy or Waiting on you', async ({
  browser,
}) => {
  const jo = await newPage(browser);
  await jo.goto('/#start');
  await signUp(jo, `jo-${Date.now()}@example.com`);
  await jo.getByRole('textbox', { name: 'Your first name' }).fill('Jo');
  await jo.getByRole('button', { name: 'Create our space' }).click();
  await recoveryPhrase(jo);
  await expect(jo.getByRole('heading', { name: 'Invite your partner' })).toBeVisible();
  const first = (await jo.locator('.url code').textContent()) ?? '';
  await jo.getByRole('button', { name: 'Do this later' }).click();
  await jo.getByRole('button', { name: 'Not now' }).click();
  await expect(jo.getByRole('heading', { name: 'This week', exact: true })).toBeVisible();

  // Nobody has joined: Privacy offers a fresh link, which replaces the first.
  await jo.goto('/#privacy');
  const card = jo.locator('section.card', { hasText: 'Invite your partner' });
  await card.getByRole('button', { name: 'Make an invite link' }).click();
  const second = (await card.locator('.url code').textContent()) ?? '';
  expect(second).toMatch(/\/join\/#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  expect(second).not.toBe(first);
  await card.getByRole('button', { name: 'Make a new link' }).click();
  await expect(card.locator('.url code')).not.toHaveText(second);

  // On a phone, the links fit the screen (they used to push the page wider).
  await jo.setViewportSize({ width: 375, height: 740 });
  const fits = () => jo.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  expect(await fits()).toBe(true);
  await jo.getByRole('button', { name: 'Link a new device' }).click();
  await expect(jo.locator('.url code').nth(1)).toContainText('/join/#');
  expect(await fits()).toBe(true);

  // And it's first in Waiting on you.
  await jo.goto('/#inbox');
  await expect(jo.locator('.wo-card')).toContainText('Invite your partner');
  await expect(
    jo.locator('.wo-card').getByRole('button', { name: 'Make an invite link' }),
  ).toBeVisible();
});

test('a passkey can sign in and unlock the keys, without a link or the phrase', async ({
  browser,
}) => {
  const page = await newPage(browser);
  // A virtual passkey with PRF, like iCloud Keychain or Google Password Manager.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto('/#start');
  await signUp(page, `kim-${Date.now()}@example.com`);
  await page.getByRole('textbox', { name: 'Your first name' }).fill('Kim');
  await page.getByRole('button', { name: 'Create our space' }).click();
  await recoveryPhrase(page);
  await page.getByRole('button', { name: 'Do this later' }).click();
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeVisible();

  // Something to find again.
  await page.keyboard.press('n');
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('Brunch saturday 11am');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Add plan|Send to/ })
    .click();
  await expect(page.locator('.rail .demo')).toHaveText('Synced', { timeout: 20_000 });

  // Turn on unlocking with the passkey, after reading what it means.
  await page.goto('/#privacy');
  const card = page.locator('section[aria-labelledby="pk-h"]');
  await expect(card).toContainText('signs in');
  // Nothing from the passkey's unlock secret is sent when setting it up either.
  const setup: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') setup.push(r.postData() ?? '');
  });
  await card.getByRole('button', { name: 'Let a passkey unlock my keys' }).click();
  await expect(card).toContainText('Leave it off if someone close to you knows your passcode');
  await card.getByRole('button', { name: 'Choose a passkey' }).click();
  await expect(page.locator('.toast-host')).toContainText('can now unlock your keys', {
    timeout: 20_000,
  });
  await expect(card).toContainText('signs in and unlocks your keys');
  expect(setup.some((b) => b.includes('space_version'))).toBe(true);
  for (const b of setup) expect(b).not.toMatch(/"prf"|"results"/);

  // Signing out removes everything from this device...
  await page
    .locator('section[aria-labelledby="acct-h"]')
    .getByRole('button', { name: 'Sign out' })
    .click();
  await page.getByRole('button', { name: 'Tap again to sign out' }).click();
  // Signing out has finished once the landing page is back.
  await expect(page.getByRole('heading', { name: /The shared planner/ })).toBeVisible({
    timeout: 20_000,
  });
  // ...and one touch of the passkey brings it all back.
  await page.goto('/#start');
  await page.reload();
  // The passkey's unlock secret never leaves the device: not in the sign-in.
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') sent.push(r.postData() ?? '');
  });
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
  await page.goto('/#plan');
  await expect(page.getByRole('button', { name: /Brunch/ }).first()).toBeVisible({
    timeout: 20_000,
  });
  expect(sent.some((b) => b.includes('authenticatorData'))).toBe(true);
  for (const b of sent) expect(b).not.toMatch(/"prf"|"results"/);
  await page.context().close();
});

test('an invite survives the sign-in link opening in a new tab', async ({ browser }) => {
  const stamp = Date.now();
  const jo = await newPage(browser);
  await jo.goto('/#start');
  await signUp(jo, `jo2-${stamp}@example.com`);
  await jo.getByRole('textbox', { name: 'Your first name' }).fill('Jo');
  await jo.getByRole('button', { name: 'Create our space' }).click();
  await recoveryPhrase(jo);
  const invite = (await jo.locator('.url code').textContent()) ?? '';

  // Kim opens the invite, asks for a sign-in link, and the email app opens
  // it in a new tab (or the browser instead of the installed app).
  const kim = await newPage(browser);
  await kim.goto(invite);
  const kimEmail = `kim-${stamp}@example.com`;
  await expect(kim.getByRole('heading', { name: 'Join your partner' })).toBeVisible();
  await kim.getByRole('textbox', { name: 'Email' }).fill(kimEmail);
  await kim.getByRole('checkbox', { name: /16 or older/ }).check();
  await kim.getByRole('button', { name: 'Email me a link' }).click();
  await expect(kim.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = await magicLink(kim, kimEmail);
  const tab = await kim.context().newPage();
  await tab.goto(link);
  await expect(tab.getByRole('heading', { name: 'Join the space' })).toBeVisible();
  await tab.getByRole('textbox', { name: 'Your first name' }).fill('Kim');
  await tab.getByRole('button', { name: 'Join' }).click();
  await recoveryPhrase(tab);
  await expect(tab.getByRole('heading', { name: 'Compare your safety code' })).toBeVisible();
});

/** Pat makes a space and an invite; Lee signs up without it and makes their own. */
async function strayedPartner(browser: Browser, tag: string) {
  const stamp = `${tag}-${Date.now()}`;
  const pat = await newPage(browser);
  await pat.goto('/#start');
  await signUp(pat, `pat-${stamp}@example.com`);
  await pat.getByRole('textbox', { name: 'Your first name' }).fill('Pat');
  await pat.getByRole('button', { name: 'Create our space' }).click();
  await recoveryPhrase(pat);
  const invite = (await pat.locator('.url code').textContent()) ?? '';
  const lee = await newPage(browser);
  const leeEmail = `lee-${stamp}@example.com`;
  await lee.goto('/#start');
  await signUp(lee, leeEmail);
  await lee.getByRole('textbox', { name: 'Your first name' }).fill('Lee');
  await lee.getByRole('button', { name: 'Create our space' }).click();
  const oldWords = await recoveryPhrase(lee);
  await lee.getByRole('button', { name: 'Do this later' }).click();
  await lee.getByRole('button', { name: 'Not now' }).click();
  await expect(lee.getByRole('heading', { name: 'This week', exact: true })).toBeVisible();
  return { pat, lee, leeEmail, invite, oldWords };
}

test('someone whose own space is empty can join with the same account', async ({ browser }) => {
  const { pat, lee, invite, oldWords } = await strayedPartner(browser, 'keep');
  await lee.goto(invite);
  const prompt = lee.locator('section[aria-labelledby="ji-h"]');
  // Who it's from comes from inside the invite.
  await expect(prompt).toContainText('Join Pat’s space?');
  await expect(prompt).toContainText('your sign-in, passkeys and devices stay');
  await prompt.getByRole('button', { name: 'Join with this account' }).click();
  await prompt.getByRole('button', { name: 'Tap again to join Pat' }).click();
  // The old phrase doesn't hold the new space's keys: a new one is saved.
  const words = await recoveryPhrase(lee);
  expect(words).not.toEqual(oldWords);
  await expect(lee.getByRole('heading', { name: 'Compare your safety code' })).toBeVisible();
  // A reload doesn't skip comparing the code (review 0007, C3).
  await lee.reload();
  await expect(lee.getByRole('heading', { name: 'Compare your safety code' })).toBeVisible();
  await expect(pat.getByRole('heading', { name: 'Compare your safety code' })).toBeVisible({
    timeout: 20_000,
  });
  expect(await pat.locator('.code').textContent()).toBe(await lee.locator('.code').textContent());

  // Same account, now in Pat's space: plans sync both ways.
  await lee.getByRole('button', { name: 'Done' }).click();
  await lee.getByRole('button', { name: 'Not now' }).click();
  await pat.getByRole('button', { name: 'Done' }).click();
  await pat.getByRole('button', { name: 'Not now' }).click();
  await pat.keyboard.press('n');
  await pat.getByRole('textbox', { name: 'What’s the plan?' }).fill('Pizza friday 7pm');
  await pat.getByRole('button', { name: 'Send to Lee' }).click();
  await lee.reload();
  await expect(lee.getByRole('button', { name: /Pizza/ }).first()).toBeVisible({
    timeout: 20_000,
  });
  // Only one space, the shared one.
  const me = await lee.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('ours');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<unknown>((res) => {
      const g = db.transaction('kv').objectStore('kv').get('me');
      g.onsuccess = () => res(g.result);
    });
  });
  expect((me as { spaces: unknown[] }).spaces).toHaveLength(1);
});

test('someone whose own space has things in it can delete them and join', async ({ browser }) => {
  const { pat, lee, invite } = await strayedPartner(browser, 'clear');
  await lee.keyboard.press('n');
  await lee.getByRole('textbox', { name: 'What’s the plan?' }).fill('Dentist tomorrow 9am');
  await lee.getByRole('button', { name: /Add plan|Send to/ }).click();
  await expect(lee.getByRole('button', { name: /Dentist/ }).first()).toBeVisible();

  await lee.goto(invite);
  const prompt = lee.locator('section[aria-labelledby="ji-h"]');
  await expect(prompt).toContainText('has 1 thing in it, which will be deleted');
  await prompt.getByRole('button', { name: 'Delete them and join' }).click();
  await prompt.getByRole('button', { name: 'Tap again: delete 1 and join' }).click();
  await recoveryPhrase(lee);
  await expect(lee.getByRole('heading', { name: 'Compare your safety code' })).toBeVisible();
  await expect(pat.getByRole('heading', { name: 'Compare your safety code' })).toBeVisible({
    timeout: 20_000,
  });
  expect(await pat.locator('.code').textContent()).toBe(await lee.locator('.code').textContent());
  await lee.getByRole('button', { name: 'Done' }).click();
  await lee.getByRole('button', { name: 'Not now' }).click();
  await expect(lee.getByRole('heading', { name: 'This week', exact: true })).toBeVisible();
  await expect(lee.getByRole('button', { name: /Dentist/ })).toHaveCount(0);
});

test('a join whose answer was lost is finished on the next start', async ({ browser }) => {
  const { pat, lee, invite } = await strayedPartner(browser, 'lost');
  // The server joins, but the answer never reaches the device.
  await lee.route('**/invites/*/accept', async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  });
  await lee.goto(invite);
  const prompt = lee.locator('section[aria-labelledby="ji-h"]');
  await prompt.getByRole('button', { name: 'Join with this account' }).click();
  await prompt.getByRole('button', { name: 'Tap again to join Pat' }).click();
  await expect(lee.locator('.toast-host')).toBeVisible();
  await lee.unroute('**/invites/*/accept');
  // Next start: the server says it happened; the device catches up, asks
  // for a new phrase and shows the safety code.
  await lee.goto('/#plan');
  await lee.reload();
  await recoveryPhrase(lee);
  await expect(lee.getByRole('heading', { name: 'Compare your safety code' })).toBeVisible();
  await expect(pat.getByRole('heading', { name: 'Compare your safety code' })).toBeVisible({
    timeout: 20_000,
  });
  expect(await pat.locator('.code').textContent()).toBe(await lee.locator('.code').textContent());
});

test('an invite kept for one address isn’t offered to someone else on the same browser', async ({
  browser,
}) => {
  const stamp = Date.now();
  const jo = await newPage(browser);
  await jo.goto('/#start');
  await signUp(jo, `jo3-${stamp}@example.com`);
  await jo.getByRole('textbox', { name: 'Your first name' }).fill('Jo');
  await jo.getByRole('button', { name: 'Create our space' }).click();
  await recoveryPhrase(jo);
  const invite = (await jo.locator('.url code').textContent()) ?? '';

  // Kim opens the invite on a shared computer and asks for a sign-in link...
  const shared = await newPage(browser);
  await shared.goto(invite);
  await shared.getByRole('textbox', { name: 'Email' }).fill(`kim3-${stamp}@example.com`);
  await shared.getByRole('checkbox', { name: /16 or older/ }).check();
  await shared.getByRole('button', { name: 'Email me a link' }).click();
  await expect(shared.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  // ...but someone else signs in there with their own address.
  const other = await shared.context().newPage();
  await other.goto('/#start');
  await signUp(other, `ash-${stamp}@example.com`);
  await expect(other.getByRole('heading', { name: 'Set up your space' })).toBeVisible();
  expect(await other.evaluate(() => localStorage.getItem('ours-pending-invite'))).toBeNull();
});
