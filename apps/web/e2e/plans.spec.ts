// SPDX-License-Identifier: AGPL-3.0-or-later
/** Everything the demo shows can be made and changed in the app: edit, repeat, trips, countdowns. */
import { expect, type Page, test } from '@playwright/test';

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

const form = (page: Page) => page.getByRole('dialog', { name: /New plan|Edit plan/ });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

test('add a milestone to count down to', async ({ page }) => {
  await page.getByRole('button', { name: 'Add a milestone' }).click();
  const f = form(page);
  await f.getByRole('textbox', { name: 'What' }).fill('Sam’s birthday');
  await f.getByLabel('First day').fill(inDays(12));
  await f.getByLabel('Last day').fill(inDays(12));
  await expect(f.getByRole('switch', { name: /Count down to this/ })).toBeChecked();
  await f.getByRole('button', { name: /Add plan|Send to/ }).click();
  const tile = page.getByRole('button', { name: /12\s*days to\s*Sam’s birthday/ });
  await expect(tile).toBeVisible();
  await tile.click();
  await expect(page.getByRole('dialog', { name: 'Sam’s birthday' })).toContainText(
    'Counting down on the Plan screen',
  );
});

test('edit a plan: name, place and notes', async ({ page }) => {
  await page
    .getByRole('button', { name: /Dentist/ })
    .first()
    .click();
  await page.getByRole('dialog', { name: 'Dentist' }).getByRole('button', { name: 'Edit' }).click();
  const f = form(page);
  await f.getByRole('textbox', { name: 'What' }).fill('Dentist check-up');
  await f.getByRole('textbox', { name: /Where/ }).fill('Dr. Okafor, 3rd floor');
  await f.getByRole('textbox', { name: /Notes/ }).fill('Bring the insurance card');
  await f.getByRole('button', { name: 'Save changes' }).click();
  const sheet = page.getByRole('dialog', { name: 'Dentist check-up' });
  await expect(sheet).toContainText('Dr. Okafor, 3rd floor');
  await expect(sheet).toContainText('Bring the insurance card');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Dentist check-up/ }).first()).toBeVisible();
});

test('a trip over several days, marked away, from quick add’s more options', async ({ page }) => {
  await page.keyboard.press('n');
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('Lake weekend');
  await page.getByRole('button', { name: /More options/ }).click();
  const f = form(page);
  await expect(f.getByRole('textbox', { name: 'What' })).toHaveValue('Lake weekend');
  if (!(await f.getByRole('switch', { name: 'All day' }).isChecked())) {
    await f.getByRole('switch', { name: 'All day' }).check();
  }
  await f.getByLabel('First day').fill(inDays(3));
  await f.getByLabel('Last day').fill(inDays(5));
  await f.getByRole('switch', { name: 'Away' }).check();
  await f.getByRole('button', { name: /Add plan|Send to/ }).click();
  await page
    .getByRole('button', { name: /Lake weekend/ })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: 'Lake weekend' });
  await expect(sheet).toContainText('–');
  await expect(sheet).toContainText('All day');
  await expect(sheet).toContainText('Away');
});

test('a plan that repeats every week', async ({ page }) => {
  await page.keyboard.press('n');
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('Swim');
  await page.getByRole('button', { name: /More options/ }).click();
  const f = form(page);
  if (await f.getByRole('switch', { name: 'All day' }).isChecked()) {
    await f.getByRole('switch', { name: 'All day' }).uncheck();
  }
  await f.getByLabel('Starts').fill(inDays(1));
  await f.getByLabel('Start time').fill('07:00');
  await f.getByLabel('Ends').fill(inDays(1));
  await f.getByLabel('End time').fill('08:00');
  await f.getByRole('combobox', { name: 'Repeats' }).selectOption({ label: 'Every week' });
  await f.getByRole('button', { name: /Add plan|Send to/ }).click();
  await page.getByRole('button', { name: 'Show next week' }).click();
  // Tomorrow and the same day next week.
  await expect(page.getByRole('button', { name: /Swim/ })).toHaveCount(2);
});

test('changing a private plan’s time moves the partner’s “Busy” too', async ({ page }) => {
  await page.keyboard.press('n');
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('Physio');
  const quick = page.getByRole('dialog', { name: 'New plan' });
  await quick.getByRole('button', { name: 'Mine' }).click();
  await quick.getByRole('switch', { name: /Keep the details private/ }).check();
  await quick.getByRole('button', { name: /More options/ }).click();
  const f = form(page);
  if (await f.getByRole('switch', { name: 'All day' }).isChecked()) {
    await f.getByRole('switch', { name: 'All day' }).uncheck();
  }
  await f.getByLabel('Starts').fill(inDays(1));
  await f.getByLabel('Start time').fill('06:00');
  await f.getByLabel('Ends').fill(inDays(1));
  await f.getByLabel('End time').fill('06:45');
  await f.getByRole('button', { name: 'Add plan' }).click();
  await page
    .getByRole('button', { name: /Physio/ })
    .first()
    .click();
  await page.getByRole('dialog', { name: 'Physio' }).getByRole('button', { name: 'Edit' }).click();
  await form(page).getByLabel('Start time').fill('06:30');
  await form(page).getByLabel('End time').fill('07:15');
  await form(page).getByRole('button', { name: 'Save changes' }).click();
  await page.keyboard.press('Escape');
  // As Alex: Busy at the new time, and no title.
  await page
    .getByRole('navigation', { name: 'Main' })
    .filter({ visible: true })
    .getByRole('link', { name: 'Privacy' })
    .click();
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await page
    .getByRole('navigation', { name: 'Main' })
    .filter({ visible: true })
    .getByRole('link', { name: 'Plan' })
    .click();
  await expect(page.getByText('Physio')).toHaveCount(0);
  await expect(page.locator('.ev.is-masked').filter({ hasText: '6:30' })).toHaveCount(1);
});
