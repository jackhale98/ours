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

/** Two boxes overlap if their rectangles intersect. */
const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('date and time fields never overlap', async ({ page }) => {
  await page.goto('/#plan');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('n');
  const quick = page.getByRole('dialog', { name: 'New plan' });
  const date = await quick.locator('#qa-date').boundingBox();
  const time = await quick.locator('#qa-time').boundingBox();
  expect(date && time && !overlaps(date, time)).toBe(true);
  for (const box of [date, time]) {
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  }
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('Dinner tomorrow 7pm');
  await quick.getByRole('button', { name: /More options/ }).click();
  const form = page.getByRole('dialog', { name: /New plan/ });
  const fields = ['Starts', 'Start time', 'Ends', 'End time'];
  const boxes = [];
  const ids = ['#pf-sd', '#pf-st', '#pf-ed', '#pf-et'];
  for (const id of ids) boxes.push(await form.locator(id).boundingBox());
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      expect(a && b && !overlaps(a, b), `${fields[i]} / ${fields[j]}`).toBe(true);
    }
  }
});

test('tapping a milestone leaves no keyboard outline around the strip', async ({ page }) => {
  await page.goto('/#plan');
  const strip = page.locator('.cd-wrap');
  // iPhone Safari hands focus back to the strip after a milestone's sheet
  // closes, and shows it as keyboard focus. Put it in that state here:
  await page.keyboard.press('Shift');
  await strip.focus();
  expect(await strip.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  await expect(strip).not.toHaveCSS('outline-style', 'none');
  // After a touch, no outline, even though it still has focus...
  await page.locator('h1').dispatchEvent('pointerdown');
  await expect(strip).toBeFocused();
  await expect(strip).toHaveCSS('outline-style', 'none');
  // ...and keys bring it back.
  await page.keyboard.press('ArrowRight');
  await expect(strip).not.toHaveCSS('outline-style', 'none');
});
