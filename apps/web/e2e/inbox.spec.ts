// SPDX-License-Identifier: AGPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

test('waiting on you: one at a time, then all clear', async ({ page }) => {
  await page.goto('/#plan');
  // The count is on the way in: the rail on desktop, the header on phones.
  await page
    .getByRole('link', { name: /^Waiting on you/ })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/#inbox$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Waiting on you');
  const card = page.locator('.wo-card');
  await expect(card).toContainText('1 of 2');
  await expect(card).toContainText('Alex asked · needs your answer');

  // Skip moves on without answering; picking from the list comes back.
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(card).toContainText('Water the plants');
  await page.getByRole('button', { name: /Dinner at my parents’/ }).click();
  await expect(card).toContainText('Dinner at my parents’');

  // Answering brings up the next one, with focus on it.
  await card.getByRole('button', { name: 'Yes, add it' }).click();
  await expect(card).toContainText('Water the plants');
  await expect(card.getByRole('heading', { name: 'Water the plants' })).toBeFocused();
  await expect(card).toContainText('Nobody’s on it yet.');

  // A repeating task: Done moves it to its next date, so it leaves the queue.
  await card.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Nothing’s waiting on you' })).toBeVisible();
  await expect(page.locator('.toast-host')).toContainText('Done. Next:');
});

test('a task can be passed on or put off', async ({ page }) => {
  await page.goto('/#inbox');
  await page.getByRole('button', { name: /Water the plants/ }).click();
  const card = page.locator('.wo-card');
  await card.getByRole('button', { name: 'Later' }).click();
  await expect(page.locator('.toast-host')).toContainText('Moved to tomorrow');
  // Due tomorrow is still raised; passing it to Alex takes it off my list.
  await page.getByRole('button', { name: /Water the plants/ }).click();
  await card.getByRole('button', { name: 'Pass to Alex' }).click();
  await expect(page.getByRole('button', { name: /Water the plants/ })).toHaveCount(0);
  await page.locator('.toast-host').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /Water the plants/ })).toHaveCount(1);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`waiting on you has no axe violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/#inbox');
    await expect(page.locator('.wo-card')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
}

test('wide screens: lists sit side by side, the agenda has a side column', async ({
  page,
}, info) => {
  test.skip(info.project.name.includes('mobile'), 'desktop layout');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#lists');
  const tabs = page.locator('.ltab');
  const first = await tabs.nth(0).boundingBox();
  const second = await tabs.nth(1).boundingBox();
  expect(second?.x).toBe(first?.x); // stacked, not in a row
  const items = await page.locator('.lists-pane').boundingBox();
  expect(items?.x ?? 0).toBeGreaterThan((first?.x ?? 0) + (first?.width ?? 0));

  await page.goto('/#plan');
  const side = await page.locator('.plan-side').boundingBox();
  const main = await page.locator('.plan-main').boundingBox();
  expect(side?.x ?? 0).toBeGreaterThan((main?.x ?? 0) + (main?.width ?? 0));
  await expect(page.getByRole('heading', { name: 'On your lists this week' })).toBeVisible();
  // The day labels aren't clipped ("TODAY", not "ODAY").
  const label = page.locator('.day.today .dow');
  const box = await label.boundingBox();
  const cell = await page.locator('.day.today .dhead').boundingBox();
  expect(box?.x ?? 0).toBeGreaterThanOrEqual(cell?.x ?? 0);
});

test('phones: all six weeks of the month fit above the day drawer', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'), 'phone layout');
  await page.goto('/#plan/month');
  const lastRow = await page.locator('.month tbody tr').last().boundingBox();
  const drawer = await page.locator('.drawer').boundingBox();
  expect((lastRow?.y ?? 0) + (lastRow?.height ?? 0)).toBeLessThanOrEqual((drawer?.y ?? 0) + 1);
  const cell = await page.locator('.mcell').first().boundingBox();
  expect(cell?.height ?? 0).toBeGreaterThanOrEqual(42);
});
