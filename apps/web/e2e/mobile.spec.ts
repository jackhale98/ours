// SPDX-License-Identifier: AGPL-3.0-or-later
/** Feels like an app on phones: no zoom on focus, no sideways scrolling. */
import { expect, type Page, test } from '@playwright/test';

test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'), 'phone viewports only');
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

/** Fields under 16px make iPhones zoom in when they get focus. */
async function smallFields(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('input, textarea, select')]
      .filter((el) => el.offsetParent !== null && (el as HTMLInputElement).type !== 'checkbox')
      .filter((el) => Number.parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => el.id || el.outerHTML.slice(0, 80)),
  );
}

const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

for (const tab of ['plan', 'lists', 'checkin', 'privacy']) {
  test(`${tab}: no sideways scrolling, fields big enough not to zoom`, async ({ page }) => {
    await page.goto(`/#${tab}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await sideways(page)).toBe(false);
    expect(await smallFields(page)).toEqual([]);
  });
}

test('quick add and a plan’s sheet have fields big enough not to zoom', async ({ page }) => {
  await page.goto('/#plan');
  await page
    .getByRole('button', { name: /New plan|Add/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await smallFields(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.locator('.ev').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await smallFields(page)).toEqual([]);
});
