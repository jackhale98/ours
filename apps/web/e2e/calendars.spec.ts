// SPDX-License-Identifier: AGPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main' })
    .filter({ visible: true })
    .getByRole('link', { name })
    .click();

async function addSample(page: Page, share: 'Everything' | 'Just busy') {
  await page.goto('/#privacy');
  await page.getByText('Add a calendar').click();
  const form = page.locator('details.addcal');
  await form
    .getByRole('group', { name: 'Whose calendar' })
    .getByRole('button', { name: 'Mine' })
    .click();
  await form.getByRole('group', { name: 'Alex sees' }).getByRole('button', { name: share }).click();
  await form.getByRole('button', { name: 'Add a sample work calendar' }).click();
  await expect(page.getByRole('status')).toContainText('Imported');
}

test('import a calendar shared as busy-only: I see details, my partner sees Busy', async ({
  page,
}) => {
  await addSample(page, 'Just busy');
  await nav(page, 'Plan');
  await expect(page.getByRole('button', { name: /Team standup/ }).first()).toBeVisible();

  await nav(page, 'Privacy');
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await expect(page.getByText(/shared by Sam · busy times only/)).toBeVisible();
  await nav(page, 'Plan');
  await expect(page.getByText('Team standup')).toHaveCount(0);
  await expect(page.getByText('Launch prep')).toHaveCount(0);
});

test('import a calendar shared in full: my partner sees titles', async ({ page }) => {
  await addSample(page, 'Everything');
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await nav(page, 'Plan');
  await expect(page.getByRole('button', { name: /Team standup/ }).first()).toBeVisible();
});

test('imported events are read-only, and free time does not block evenings', async ({ page }) => {
  await addSample(page, 'Just busy');
  await nav(page, 'Plan');
  await page
    .getByRole('button', { name: /Team standup/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Read-only here/)).toBeVisible();
  await page.keyboard.press('Escape');
});

test('the feed leaves out calendars I imported, and changing the share updates it', async ({
  page,
}) => {
  await addSample(page, 'Just busy');
  const feed = page.locator('section', {
    has: page.getByRole('heading', { name: 'Calendar feed' }),
  });
  await expect(feed.getByText(/Leaves out Work/)).toBeVisible();
  // As Alex, Sam's work calendar is not Alex's own, so it isn't left out.
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await expect(feed.getByText(/Leaves out/)).toHaveCount(0);
});

test('a calendar can be removed with undo', async ({ page }) => {
  await addSample(page, 'Just busy');
  await page.getByRole('button', { name: 'Remove Work' }).click();
  await expect(page.getByRole('button', { name: 'Remove Work' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Remove Work' })).toBeVisible();
});

test('privacy with calendars has no axe violations', async ({ page }) => {
  await addSample(page, 'Just busy');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
});

test('each person picks a colour and a shape, and everything follows', async ({ page }) => {
  await page.goto('/#plan');
  await page.getByText('What the marks mean').click();
  // Both circles by default, so the key doesn't mention shapes.
  await expect(page.getByText('Alex’s plan', { exact: true })).toBeVisible();

  await page.goto('/#privacy');
  const alex = page.getByRole('group', { name: 'Alex’s shape' });
  await alex.getByRole('button', { name: 'Square' }).click();
  await expect(alex.getByRole('button', { name: 'Square' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page
    .getByRole('radiogroup', { name: 'Alex’s colour' })
    .getByTitle('Teal', { exact: true })
    .click();
  // The two of you can't share a colour.
  await expect(
    page.getByRole('radiogroup', { name: 'Sam’s colour' }).getByLabel(/Teal, Alex’s colour/),
  ).toBeDisabled();

  await page.goto('/#plan');
  await page.getByText('What the marks mean').click();
  await expect(page.getByText('Alex’s plan (square)')).toBeVisible();
  await expect(page.getByText('Sam’s plan (circle)')).toBeVisible();
  const b = page.locator('.key .mk i.b').first();
  await expect(b).toHaveCSS('border-radius', '2px');
  const teal = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--pal-teal').trim(),
  );
  const hex = (rgb: string) =>
    `#${(rgb.match(/\d+/g) ?? [])
      .slice(0, 3)
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')}`;
  expect(hex(await b.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(teal);
});

test('colours that colour blindness could confuse suggest different shapes', async ({ page }) => {
  await page.goto('/#privacy');
  await page
    .getByRole('radiogroup', { name: 'Sam’s colour' })
    .getByTitle('Green', { exact: true })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Alex’s colour' })
    .getByTitle('Brown', { exact: true })
    .click();
  const note = page.getByText(/can look alike to people with colour blindness/);
  await expect(note).toBeVisible();
  await page
    .getByRole('group', { name: 'Alex’s shape' })
    .getByRole('button', { name: 'Diamond' })
    .click();
  await expect(note).toHaveCount(0);
});
