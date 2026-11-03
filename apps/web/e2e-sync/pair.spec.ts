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
    await page.getByRole('textbox', { name: label }).fill(words[n - 1] ?? '');
  }
  await page.getByRole('button', { name: 'Confirm' }).click();
  return words;
}

async function newPage(browser: Browser) {
  const context = await browser.newContext();
  return context.newPage();
}

test('sign up, pair, compare safety codes, and sync plans both ways', async ({ browser }) => {
  const stamp = Date.now();
  const sam = await newPage(browser);
  const alex = await newPage(browser);

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

  // Sam proposes a shared plan.
  await sam.keyboard.press('n');
  await sam.getByRole('textbox', { name: 'What’s the plan?' }).fill('Dinner tomorrow 7pm @ Vic’s');
  await sam.getByRole('button', { name: 'Send to Alex' }).click();
  await expect(sam.getByRole('button', { name: /Dinner/ })).toBeVisible();

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
});
