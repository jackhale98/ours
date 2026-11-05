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
  await page.goto('/#plan');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This week');
});

test('a free evening offers date ideas that fit, filtered by length', async ({ page }) => {
  await page.locator('.agenda .free').first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('You’re both free')).toBeVisible();
  const when = sheet.getByRole('radio');
  expect(await when.count()).toBeGreaterThan(0);
  await expect(sheet.getByRole('radio', { checked: true })).toHaveCount(1);
  const ideas = sheet.getByRole('list', { name: 'Date ideas' });

  // Sized ideas filter by length; ideas nobody sized always stay.
  await sheet.getByRole('button', { name: 'All day' }).click();
  await expect(ideas).toContainText('Day trip to the coast');
  await expect(ideas).toContainText('Board game café'); // no length set
  await expect(ideas).not.toContainText('Pottery class');
  await sheet.getByRole('button', { name: 'An hour or two' }).click();
  await expect(ideas).toContainText('Pottery class');
  await expect(ideas).not.toContainText('Day trip to the coast');
  await sheet.getByRole('button', { name: 'Anything' }).click();
  await expect(ideas).toContainText('Day trip to the coast');
  await expect(ideas).toContainText('Pottery class');

  // Planning one fills in the idea, the day and a time in the free stretch.
  await ideas.getByRole('button', { name: /Night walk and dumplings/ }).click();
  const quick = page.getByRole('dialog', { name: 'New plan' });
  await expect(quick.getByRole('textbox', { name: 'What’s the plan?' })).toHaveValue(
    'Night walk and dumplings',
  );
  await expect(quick).toContainText('7 PM');
});

test('an idea’s length is set in its details, and is optional', async ({ page }) => {
  await page.goto('/#lists');
  await page
    .getByRole('group', { name: 'Lists' })
    .getByRole('button', { name: /Date ideas/ })
    .click();
  await page.getByRole('button', { name: 'Details: Board game café' }).click();
  const sheet = page.getByRole('dialog', { name: 'Board game café' });
  await expect(sheet.getByRole('button', { name: 'Not sure' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(sheet.getByRole('combobox', { name: 'Repeats' })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'An evening' }).click();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.it', { hasText: 'Board game café' })).toContainText('An evening');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the free-time sheet has no axe violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator('.agenda .free').first().click();
    await expect(page.getByRole('list', { name: 'Date ideas' })).toBeVisible();
    // The sheet slides and fades in: check colours once it has arrived.
    await page.waitForFunction(() =>
      document.getAnimations().every((a) => a.playState !== 'running'),
    );
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
}
