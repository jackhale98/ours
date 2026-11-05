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

/** The chosen day's plans: in the drawer on phones (opened if needed), below the grid otherwise. */
async function dayList(page: Page) {
  const drawer = page.locator('.drawer');
  if (await drawer.count()) {
    const grab = page.getByRole('button', { name: 'Plans on this day' });
    if ((await grab.getAttribute('aria-expanded')) !== 'true') await grab.click();
    await expect(grab).toHaveAttribute('aria-expanded', 'true');
    return drawer;
  }
  return page.locator('.daypanel');
}

test('month: choose a day, see its plans, move months and come back to today', async ({ page }) => {
  await page.goto('/#plan/month');
  const title = page.locator('.ptitle');
  const thisMonth = await title.textContent();
  const todayCell = page.locator('.mcell.today');
  await expect(todayCell).toHaveAttribute('aria-pressed', 'true');
  await expect(todayCell).toHaveAttribute('aria-label', /^Today, /);
  await expect((await dayList(page)).locator('h2')).toContainText('Today');
  await page.keyboard.press('Escape');
  const candidate = page
    .locator('.month .mcell:not(.out)')
    .and(page.getByRole('button', { name: /, \d+ plans?/ }))
    .last();
  const date = await candidate.getAttribute('data-date');
  const withPlans = page.locator(`.mcell[data-date="${date}"]`);
  await withPlans.click();
  await expect(withPlans).toHaveAttribute('aria-pressed', 'true');
  await expect((await dayList(page)).locator('.ev').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(title).not.toHaveText(thisMonth ?? '');
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(title).toHaveText(thisMonth ?? '');
});

test('month: the grid is always six weeks and keeps its size', async ({ page }) => {
  await page.goto('/#plan/month');
  const grid = page.locator('table.month');
  await expect(grid.locator('tbody tr')).toHaveCount(6);
  const h1 = (await grid.boundingBox())?.height;
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(grid.locator('tbody tr')).toHaveCount(6);
    expect((await grid.boundingBox())?.height).toBe(h1);
  }
  // Choosing a day doesn't move anything either.
  await page.locator('.mcell:not(.out)').nth(10).click();
  expect((await grid.boundingBox())?.height).toBe(h1);
});

test('month on phones: the day slides up from a drawer and goes away again', async ({
  page,
}, info) => {
  test.skip(!info.project.name.includes('mobile'), 'phones only');
  await page.goto('/#plan/month');
  const grab = page.getByRole('button', { name: 'Plans on this day' });
  await expect(grab).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.drawer .preview')).toBeVisible();
  // Tapping the chosen day again opens it.
  await page.locator('.mcell[aria-pressed="true"]').click();
  await expect(grab).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'New plan' })).toHaveCount(0); // + steps aside
  await page.keyboard.press('Escape');
  await expect(grab).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'New plan' })).toBeVisible();
  // Every week can be seen above the drawer (short phones scroll a little to get there).
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const grid = await page.locator('table.month').boundingBox();
  const drawer = await page.locator('.drawer').boundingBox();
  expect((grid?.y ?? 0) + (grid?.height ?? 0)).toBeLessThanOrEqual((drawer?.y ?? 0) + 2);
});

test('month: arrow keys move the chosen day; a day can be added to', async ({ page }) => {
  await page.goto('/#plan/month');
  await page.locator('.mcell[aria-pressed="true"]').focus();
  const before = await page.locator('.mcell[aria-pressed="true"]').getAttribute('data-date');
  await page.keyboard.press('ArrowRight');
  const after = await page.locator('.mcell[aria-pressed="true"]').getAttribute('data-date');
  expect(after).not.toBe(before);
  // Focus followed the chosen day.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-date')))
    .toBe(after);
  await page.keyboard.press('ArrowDown');
  const week = await page.locator('.mcell[aria-pressed="true"]').getAttribute('data-date');
  expect(Date.parse(week ?? '') - Date.parse(after ?? '')).toBe(7 * 86_400_000);
  await (await dayList(page)).getByRole('button', { name: 'Add a plan on this day' }).click();
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

test('what’s waiting stays one tap away in week and month', async ({ page }, info) => {
  await page.goto('/#plan/week');
  await page.getByRole('button', { name: /waiting on you/ }).click();
  await expect(page).toHaveURL(/#inbox$/);
  await expect(page.getByText('Alex asked · needs your answer')).toBeVisible();
  await page.goto('/#plan/month');
  // Phones give the month grid the room: the header's button does the same job.
  const phone = info.project.name.includes('mobile');
  if (phone) {
    await expect(page.getByRole('button', { name: /waiting on you/ })).toHaveCount(0);
    await page.getByRole('link', { name: /^Waiting on you: \d/ }).click();
  } else {
    await page.getByRole('button', { name: /waiting on you/ }).click();
  }
  await expect(page).toHaveURL(/#inbox$/);
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

test('changing week or month slides the new one in from its side', async ({ page }) => {
  for (const view of ['week', 'month'] as const) {
    await page.goto(`/#plan/${view}`);
    const slide = page.locator('.slide').first();
    await page.getByRole('button', { name: `Next ${view}` }).click();
    await expect(slide).toHaveClass(/slide-next/);
    await page.getByRole('button', { name: `Previous ${view}` }).click();
    await expect(slide).toHaveClass(/slide-prev/);
    // Nothing sticks out sideways while it moves.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test('filters, shortcuts and the agenda going further (review 0009, P-8, P-10, P-14)', async ({
  page,
}, info) => {
  await page.goto('/#plan');
  await expect(page.getByRole('heading', { name: 'This week', level: 1 })).toBeVisible();
  // Routines can be left out, on this device.
  await expect(page.locator('.ev', { hasText: 'Farmers market' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Routines' }).click();
  await expect(page.locator('.ev', { hasText: 'Farmers market' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Filtered (1)' })).toBeVisible();
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Routines' }).click();

  // Jump ahead, then back to today.
  await page.getByLabel('Go to').fill('2027-01-04');
  await expect(page.getByRole('button', { name: 'Back to today' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to today' }).click();
  await expect(page.locator('.day.today')).toHaveCount(1);

  if (info.project.name.includes('mobile')) return;
  await page.getByRole('heading', { name: 'This week', level: 1 }).click();
  await page.keyboard.press('w');
  await expect(page).toHaveURL(/#plan\/week/);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await expect(page).toHaveURL(/#plan$/);
});
