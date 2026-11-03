// SPDX-License-Identifier: AGPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function openDemo(page: Page, tab = 'plan') {
  await page.goto(`/#${tab}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function nav(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Main' })
    .filter({ visible: true })
    .getByRole('link', { name })
    .click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

test('landing links to the demo', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Try the demo' }).click();
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  for (const tab of ['plan', 'lists', 'checkin', 'privacy']) {
    test(`${tab} has no axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openDemo(page, tab);
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    });
  }
}

test('plan shows the seeded week, a proposal and a partner’s private plan as Busy', async ({
  page,
}) => {
  await openDemo(page);
  await expect(page.getByText('Alex asked · needs your answer')).toBeVisible();
  await expect(page.getByText('Dinner at my parents’').first()).toBeVisible();
  // Alex's private "Therapy" must never be shown to Sam.
  await expect(page.getByText('Therapy')).toHaveCount(0);
  await expect(page.locator('.ev.is-masked').first()).toContainText('Busy');
});

test('accepting a proposal confirms it', async ({ page }) => {
  await openDemo(page);
  const card = page.locator('.ask').first();
  await card.getByRole('button', { name: 'Yes, add it' }).click();
  await expect(page.getByRole('status')).toContainText('will see your yes');
  await expect(page.locator('.ask')).toHaveCount(0);
});

test('declining a proposal hides it for me and shows the answer to my partner', async ({
  page,
}) => {
  await openDemo(page);
  const card = page.locator('.ask').first();
  const title = (await card.locator('h3, h2').first().textContent())?.trim() ?? '';
  await card.getByRole('button', { name: 'Can’t make it' }).click();
  await expect(page.locator('.toast-host')).toContainText('can’t make it');
  await expect(page.locator('.ask')).toHaveCount(0);
  // Switch to the partner who asked: the plan is still there, marked declined.
  await nav(page, 'Privacy');
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await nav(page, 'Plan');
  const row = page.locator('.ev.is-declined').first();
  await expect(row).toContainText('can’t make it');
  if (title) await expect(row).toContainText(title);
  await row.click();
  await page.getByRole('button', { name: 'Ask again' }).click();
  await expect(page.locator('.toast-host')).toContainText('Asked Sam again');
});

test('quick add parses natural language and adds a plan', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('n');
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await expect(dialog).toBeVisible();
  await page
    .getByRole('textbox', { name: 'What’s the plan?' })
    .fill('pottery tomorrow 6pm @ Clay Co');
  await expect(dialog.getByText('Tomorrow', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Clay Co')).toBeVisible();
  await dialog.getByRole('button', { name: 'Mine' }).click();
  await dialog.getByRole('button', { name: 'Add plan' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: /Pottery/ })).toBeVisible();
});

test('a private plan is hidden from the partner but visible as Busy', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('n');
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('surprise planning today 1pm');
  await dialog.getByRole('button', { name: 'Mine' }).click();
  await dialog.getByRole('switch', { name: /Keep the details private/ }).check();
  await dialog.getByRole('button', { name: 'Add plan' }).click();
  await expect(page.getByRole('button', { name: /Surprise planning/ })).toBeVisible();

  await nav(page, 'Privacy');
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await nav(page, 'Plan');
  await expect(page.getByText('Surprise planning')).toHaveCount(0);
  await expect(page.getByText('Therapy')).toBeVisible();
});

test('event sheet: notes and delete with undo', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /Dinner with Jordan/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Dinner with Jordan & Priya' });
  await expect(dialog.getByText('I can drive if you grab the wine.')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Note' }).fill('Booked a table.');
  await dialog.getByRole('button', { name: 'Send note' }).click();
  await expect(dialog.getByText('Booked a table.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete plan' }).click();
  await dialog.getByRole('button', { name: 'Tap again to confirm' }).click();
  await expect(page.getByRole('button', { name: /Dinner with Jordan/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /Dinner with Jordan/ })).toBeVisible();
});

test('escape closes a sheet and returns focus', async ({ page }) => {
  await openDemo(page);
  const trigger = page.getByRole('button', { name: /Dinner with Jordan/ });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('lists: add, assign, check off; private list is hidden from the partner', async ({ page }) => {
  await openDemo(page, 'lists');
  await page.getByRole('textbox', { name: 'Add to Groceries' }).fill('Basil');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'Basil' });
  await row.getByRole('button', { name: /No one yet/ }).click();
  await expect(row.getByRole('button', { name: /Sam is on it/ })).toBeVisible();
  await row.getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: /Show done · 2/ })).toBeVisible();

  await expect(page.getByRole('button', { name: /Gift ideas/ })).toBeVisible();
  await nav(page, 'Privacy');
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await nav(page, 'Lists');
  await expect(page.getByRole('button', { name: /Gift ideas/ })).toHaveCount(0);
});

test('date ideas: pick one and plan it', async ({ page }) => {
  await openDemo(page, 'lists');
  await page.getByRole('button', { name: /Date ideas/ }).click();
  await page.getByRole('button', { name: 'Pick one for us' }).click();
  await expect(page.getByText('Your pick')).toBeVisible();
  await page.getByRole('button', { name: /^Ask Alex/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await dialog.getByRole('button', { name: 'Send to Alex' }).click();
  await expect(page.getByRole('status')).toContainText('Sent to Alex');
});

test('check-in: finish after four steps', async ({ page }) => {
  await openDemo(page, 'checkin');
  await expect(page.getByText('Alex’s note')).toBeVisible();
  const finish = page.getByRole('button', { name: 'Finish check-in' });
  await expect(finish).toBeDisabled();
  for (const step of ['Look at the week ahead', 'Share out the chores', 'Plan time together']) {
    await page.getByRole('button', { name: `Done: ${step}` }).click();
  }
  await page.getByRole('textbox', { name: 'Note for Alex' }).fill('Excited for Lisbon.');
  await page.getByRole('button', { name: 'Done: Anything on your mind?' }).click();
  await finish.click();
  await expect(page.getByRole('status')).toContainText('Check-in saved');
});

test('theme override applies', async ({ page }) => {
  await openDemo(page, 'privacy');
  await page
    .getByRole('group', { name: 'Appearance' })
    .getByRole('button', { name: 'Dark' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('the demo makes no network requests beyond the site itself', async ({ page }) => {
  const origins = new Set<string>();
  page.on('request', (r) => origins.add(new URL(r.url()).origin));
  for (const tab of ['plan', 'lists', 'checkin', 'privacy']) await openDemo(page, tab);
  expect([...origins]).toEqual(['http://localhost:4173']);
});
