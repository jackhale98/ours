// SPDX-License-Identifier: AGPL-3.0-or-later
/** Week and month views (docs/design/calendar-views.md). */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

const view = (page: Page) => page.getByRole('group', { name: 'View' });

test('switches between agenda, week and month, and the back button follows', async ({ page }) => {
  await page.goto('/#plan');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This week');
  await view(page).getByRole('button', { name: 'Week' }).click();
  await expect(page).toHaveURL(/#plan\/week$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Week');
  await view(page).getByRole('button', { name: 'Month' }).click();
  await expect(page).toHaveURL(/#plan\/month$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Month');
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Week');
  // The Plan tab reopens in the last view used.
  await page
    .getByRole('navigation', { name: 'Main' })
    .filter({ visible: true })
    .getByRole('link', { name: 'Lists' })
    .click();
  await page
    .getByRole('navigation', { name: 'Main' })
    .filter({ visible: true })
    .getByRole('link', { name: 'Plan' })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Week');
});

test('month: choose a day, see its plans, move months and come back to today', async ({ page }) => {
  await page.goto('/#plan/month');
  const title = page.locator('.ptitle');
  const thisMonth = await title.textContent();
  // Today is chosen and its plans are listed below the grid.
  const todayCell = page.locator('.mcell.today');
  await expect(todayCell).toHaveAttribute('aria-pressed', 'true');
  await expect(todayCell).toHaveAttribute('aria-label', /^Today, /);
  await expect(page.locator('.daypanel h2')).toContainText('Today');
  // Choose another day that has plans.
  const candidate = page
    .locator('.month .mcell:not(.out)')
    .and(page.getByRole('button', { name: /, \d+ plans?/ }))
    .last();
  const date = await candidate.getAttribute('data-date');
  const withPlans = page.locator(`.mcell[data-date="${date}"]`);
  await withPlans.click();
  await expect(withPlans).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.daypanel .ev').first()).toBeVisible();
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(title).not.toHaveText(thisMonth ?? '');
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(title).toHaveText(thisMonth ?? '');
});

test('month: arrow keys move the chosen day; a day can be added to', async ({ page }) => {
  await page.goto('/#plan/month');
  await page.locator('.mcell[aria-pressed="true"]').focus();
  const before = await page.locator('.mcell[aria-pressed="true"]').getAttribute('data-date');
  await page.keyboard.press('ArrowRight');
  const after = await page.locator('.mcell[aria-pressed="true"]').getAttribute('data-date');
  expect(after).not.toBe(before);
  // Focus followed the chosen day.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-date'))).toBe(after);
  await page.keyboard.press('ArrowDown');
  const week = await page.locator('.mcell[aria-pressed="true"]').getAttribute('data-date');
  expect(Date.parse(week ?? '') - Date.parse(after ?? '')).toBe(7 * 86_400_000);
  await page.getByRole('button', { name: 'Add a plan on this day' }).click();
  await expect(page.getByRole('dialog', { name: 'New plan' })).toBeVisible();
});

test('week: shows the week, moves between weeks, opens a plan', async ({ page }) => {
  await page.goto('/#plan/week');
  const title = page.locator('.ptitle');
  const thisWeek = await title.textContent();
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(title).not.toHaveText(thisWeek ?? '');
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(title).toHaveText(thisWeek ?? '');
  // A plan opens its sheet from the grid (wide) or the day list (phone).
  const plan = page.locator('.wg-ev, .daypanel .ev').first();
  await plan.click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('proposals stay visible in week and month', async ({ page }) => {
  await page.goto('/#plan/month');
  await page.getByRole('button', { name: /needs your answer/ }).click();
  await expect(page).toHaveURL(/#plan$/);
  await expect(page.getByText('Alex asked · needs your answer')).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  for (const v of ['week', 'month']) {
    test(`${v} view has no axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`/#plan/${v}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(results.violations.map((x) => `${x.id}: ${x.nodes[0]?.html}`)).toEqual([]);
    });
  }
}
