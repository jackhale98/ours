// SPDX-License-Identifier: AGPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const scheme of ['light', 'dark'] as const) {
  test(`landing renders without a11y violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('two of you');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('landing makes no third-party requests', async ({ page }) => {
  const origins = new Set<string>();
  page.on('request', (r) => origins.add(new URL(r.url()).origin));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect([...origins]).toEqual(['http://localhost:4173']);
});

test('join page strips the invite secret from the address bar', async ({ page }) => {
  const secret = 'A'.repeat(43);
  await page.goto(`/join/#0190a6c8-7a3e-7cc2-9b1d-000000000001.${secret}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Join');
  await expect(page.getByText('looks valid')).toBeVisible();
  expect(page.url()).not.toContain(secret);
});

test('join page reports a damaged link', async ({ page }) => {
  await page.goto('/join/#broken');
  await expect(page.getByRole('alert')).toBeVisible();
});

test('landing sells the app first, then explains privacy', async ({ page }) => {
  await page.goto('/');
  for (const h of [
    'Everything a couple plans, together',
    'Find the time, without the back and forth',
    'Lists you both keep, and some you don’t',
    'A ten-minute weekly check-in',
    'Your plans are yours. Not even we can read them.',
  ]) {
    await expect(page.getByRole('heading', { name: h })).toBeVisible();
  }
  // Every call to action leads into the app.
  const ctas = page.getByRole('link', { name: 'Try the demo' });
  expect(await ctas.count()).toBeGreaterThanOrEqual(2);
  await ctas.last().click();
  await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeVisible();
});
