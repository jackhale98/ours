// SPDX-License-Identifier: AGPL-3.0-or-later
/** Everything the demo shows can be made and changed in the app: edit, repeat, trips, countdowns. */
import AxeBuilder from '@axe-core/playwright';
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

test('quick add understands repeats, and the choice can be changed', async ({ page }) => {
  await page.keyboard.press('n');
  const quick = page.getByRole('dialog', { name: 'New plan' });
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('Yoga every tue and thu 6am');
  await expect(quick.locator('.pchip', { hasText: 'Every Tuesday and Thursday' })).toBeVisible();
  await expect(quick.getByRole('combobox', { name: 'Repeats' })).toHaveValue(
    'FREQ=WEEKLY;BYDAY=TU,TH',
  );
  await quick.getByRole('button', { name: /Add plan|Send to/ }).click();
  await page.getByRole('button', { name: 'Show next week' }).click();
  // Two weeks: four Yoga rows (or three if this week's Tuesday has passed).
  expect(await page.getByRole('button', { name: /Yoga/ }).count()).toBeGreaterThanOrEqual(3);

  // Picking a repeat by hand overrides what was typed.
  await page.keyboard.press('n');
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('Book club tomorrow 7pm');
  await quick.getByRole('combobox', { name: 'Repeats' }).selectOption({ label: 'Every month' });
  await quick.getByRole('button', { name: /Add plan|Send to/ }).click();
  await page
    .getByRole('button', { name: /Book club/ })
    .filter({ hasText: 'Every month' })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: 'Book club' })).toContainText('Every month');
});

test('one day of a repeating plan can be skipped, moved and put back', async ({ page }) => {
  await page.getByRole('button', { name: 'Show next week' }).click();
  const trash = page.locator('.agenda .ev', { hasText: 'Trash & recycling out' });
  await expect(trash).toHaveCount(2);

  // Skip the first: the rest of the series stays.
  await trash.first().click();
  const sheet = page.getByRole('dialog', { name: 'Trash & recycling out' });
  await expect(sheet.getByRole('heading', { name: /^Just / })).toBeVisible();
  await sheet.getByRole('button', { name: 'Skip this day' }).click();
  await expect(page.locator('.toast-host')).toContainText('The rest still repeat');
  await expect(trash).toHaveCount(1);
  await page.locator('.toast-host').getByRole('button', { name: 'Undo' }).click();
  await expect(trash).toHaveCount(2);

  // Move the first to earlier the same evening.
  await trash.first().click();
  await sheet.getByRole('button', { name: 'Move this day' }).click();
  await sheet.getByLabel('From').fill('19:00');
  await sheet.getByLabel('To').fill('19:15');
  await sheet.getByRole('button', { name: 'Move this day' }).click();
  await expect(page.locator('.toast-host')).toContainText('Moved to');
  await expect(trash.first()).toContainText('moved this time');
  await expect(trash.first()).toContainText('7 PM');
  await expect(trash.nth(1)).not.toContainText('moved this time');

  // Put it back.
  await trash.first().click();
  await expect(sheet).toContainText('Moved from');
  await sheet.getByRole('button', { name: 'Put it back' }).click();
  await expect(trash.first()).not.toContainText('moved this time');
  await expect(trash.first()).toContainText('9 PM');
});

test('add a plan to my calendar: time and title unless I ask for more', async ({ page }) => {
  await page
    .getByRole('button', { name: /Dentist/ })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: 'Dentist' });
  await sheet.getByRole('button', { name: 'Add to my calendar' }).click();
  const panel = sheet.getByRole('group', { name: 'Add to my calendar' });
  await expect(panel.getByRole('radio', { name: /Time and title/ })).toBeChecked();
  await expect(panel).toContainText('isn’t protected by Ours’ encryption');
  const axe = await new AxeBuilder({ page })
    .include('.addcal')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  // Phones open the calendar app directly; the file is always there too.
  const file = panel.getByRole('button', { name: 'Download a file' });
  const button = (await file.count()) ? file : panel.getByRole('button', { name: 'Add' });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toBe('Dentist.ics');
  const text = await (await download.createReadStream()).toArray();
  const ics = Buffer.concat(text).toString('utf8');
  expect(ics).toContain('SUMMARY:Dentist');
  expect(ics).not.toContain('LOCATION');

  // The choice is remembered; full details add the place.
  await sheet.getByRole('button', { name: 'Add to my calendar' }).click();
  await panel.getByRole('radio', { name: /Full details/ }).check();
  const again = (await file.count()) ? file : panel.getByRole('button', { name: 'Add' });
  const [second] = await Promise.all([page.waitForEvent('download'), again.click()]);
  const full = Buffer.concat(await (await second.createReadStream()).toArray()).toString('utf8');
  expect(full).toContain('LOCATION');
  await sheet.getByRole('button', { name: 'Add to my calendar' }).click();
  await expect(panel.getByRole('radio', { name: /Full details/ })).toBeChecked();
});

test('the service worker hands out a calendar file once, without the network', async ({
  page,
}, info) => {
  test.skip(info.project.name.startsWith('webkit'), 'checked in Chromium');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const got = await page.evaluate(async () => {
    const url = new URL('add-event/123.ics', location.href.split('#')[0]).href;
    const cache = await caches.open('ours-add-event');
    await cache.put(
      url,
      new Response('BEGIN:VCALENDAR', { headers: { 'Content-Type': 'text/calendar' } }),
    );
    const first = await fetch(url);
    const second = await fetch(url);
    return [first.status, first.headers.get('Content-Type'), await first.text(), second.status];
  });
  expect(got).toEqual([200, 'text/calendar', 'BEGIN:VCALENDAR', 404]);
});

test('a plan’s place opens in maps', async ({ page }) => {
  await page
    .getByRole('button', { name: /Dentist/ })
    .first()
    .click();
  const link = page
    .getByRole('dialog', { name: 'Dentist' })
    .getByRole('link', { name: /open in maps/ });
  await expect(link).toHaveAttribute(
    'href',
    /^(https:\/\/maps\.apple\.com\/\?q=|geo:0,0\?q=|https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=)Dr/,
  );
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

test('moving a shared plan asks; "can’t make it" puts it back (review 0009, P-4)', async ({
  page,
}) => {
  await page.goto('/#plan');
  await page.getByRole('button', { name: /Ours: Dinner with Jordan/ }).click();
  await page
    .getByRole('dialog', { name: 'Dinner with Jordan & Priya' })
    .getByRole('button', { name: 'Edit' })
    .click();
  const f = form(page);
  const was = await f.getByLabel('Start time').inputValue();
  await f.getByLabel('Start time').fill('21:00');
  await expect(f.getByRole('switch', { name: 'Ask Alex about the new time' })).toBeChecked();
  await f.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.toast-host')).toContainText('Asked Alex about the new time');
  await page.keyboard.press('Escape');

  // Alex sees the move, old → new, and can't make it: it goes back.
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
  const card = page.locator('.ask', { hasText: 'Dinner with Jordan' });
  await expect(card).toContainText('Sam wants to move this');
  await expect(card).toContainText('→');
  await card.getByRole('button', { name: 'Can’t make it' }).click();
  await expect(page.locator('.toast-host')).toContainText('Kept at the old time');
  await page.getByRole('button', { name: /Ours: Dinner with Jordan/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Dinner with Jordan & Priya' });
  await sheet.getByRole('button', { name: 'Edit' }).click();
  await expect(form(page).getByLabel('Start time')).toHaveValue(was);
});
