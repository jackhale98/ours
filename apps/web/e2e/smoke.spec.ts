// SPDX-License-Identifier: AGPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const scheme of ['light', 'dark'] as const) {
  test(`landing renders without a11y violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('private planner');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
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
