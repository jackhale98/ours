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

test('search finds plans, list items and lists, and opens them', async ({ page }, info) => {
  await page.goto('/#plan');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This week');
  if (info.project.name.includes('mobile')) {
    await page.getByRole('link', { name: 'Search' }).filter({ visible: true }).click();
  } else {
    // "/" opens search once the app is listening; pressing too soon does nothing.
    await expect(async () => {
      if (!page.url().endsWith('#search')) await page.keyboard.press('/');
      await expect(page).toHaveURL(/#search$/, { timeout: 1000 });
    }).toPass();
  }
  await expect(page).toHaveURL(/#search$/);
  const box = page.getByRole('searchbox', { name: 'Search plans, lists and notes' });
  await expect(box).toBeFocused();

  await box.fill('dinner parents');
  await expect(page.getByText('1 result', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: /Dinner at my parents’/ }).click();
  await expect(page.getByRole('dialog', { name: 'Dinner at my parents’' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  await box.fill('oat');
  await page.getByRole('button', { name: /Oat milk/ }).click();
  await expect(page.getByRole('dialog', { name: 'Oat milk' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  await box.fill('gift');
  await page.getByRole('button', { name: /Gift ideas/ }).click();
  await expect(page).toHaveURL(/#lists$/);
  await expect(
    page.getByRole('group', { name: 'Lists' }).getByRole('button', { name: /Gift ideas/ }),
  ).toHaveAttribute('aria-pressed', 'true');

  // The search is still there on the way back.
  await page.goto('/#search');
  await expect(page.getByRole('searchbox')).toHaveValue('gift');
});

test('no matches says so', async ({ page }) => {
  await page.goto('/#search');
  await page.getByRole('searchbox').fill('zzzz');
  await expect(page.getByText('Nothing matches “zzzz”.')).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`search has no axe violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/#search');
    await page.getByRole('searchbox').fill('d');
    await expect(page.locator('.find-row').first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
}
