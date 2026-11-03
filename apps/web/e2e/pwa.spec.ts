// SPDX-License-Identifier: AGPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];

for (const [path, heading] of [
  ['/legal/privacy/', 'Privacy policy'],
  ['/legal/terms/', 'Terms of use'],
  ['/legal/accessibility/', 'Accessibility'],
] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${heading} page has no a11y violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      // Placeholders are always filled in at build time.
      await expect(page.locator('body')).not.toContainText('%OURS_');
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test('landing links to the legal pages', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy policy');
  await page.getByRole('link', { name: 'Terms' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of use');
});

test('the web app manifest is valid and installable', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await request.get(href ?? '');
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.name).toBe('Ours');
  expect(m.display).toBe('standalone');
  expect(m.start_url).toBe('/#plan');
  expect(m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
  for (const icon of m.icons as { src: string }[]) {
    expect((await request.get(`/${icon.src}`)).ok(), icon.src).toBe(true);
  }
});

test('the app opens offline once it has been visited', async ({ page, context, browserName }) => {
  // WebKit in Playwright does not run service workers for this check.
  test.skip(browserName !== 'chromium', 'service worker offline check runs on Chromium');
  await page.goto('/#plan');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Wait until the worker controls the page (first visit installs it).
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('/legal/privacy/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy policy');
  await context.setOffline(false);
});
