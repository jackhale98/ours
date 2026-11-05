// SPDX-License-Identifier: AGPL-3.0-or-later
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function openDemo(page: Page, tab = 'plan') {
  await page.goto(`/#${tab}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function nav(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Main' })
    .filter({ visible: true })
    .getByRole('link', { name })
    .click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

test('landing links to the demo', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Try the demo' }).first().click();
  await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  for (const tab of ['plan', 'lists', 'checkin', 'privacy']) {
    test(`${tab} has no axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openDemo(page, tab);
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    });
  }
}

test('plan shows the seeded week, a proposal and a partner’s private plan as Busy', async ({
  page,
}) => {
  await openDemo(page);
  await expect(page.getByText('Alex asked · needs your answer')).toBeVisible();
  await expect(page.getByText('Dinner at my parents’').first()).toBeVisible();
  // Alex's private "Therapy" must never be shown to Sam.
  await expect(page.getByText('Therapy')).toHaveCount(0);
  await expect(page.locator('.ev.is-masked').first()).toContainText('Busy');
});

test('accepting a proposal confirms it', async ({ page }) => {
  await openDemo(page);
  const card = page.locator('.ask').first();
  await card.getByRole('button', { name: 'Yes, add it' }).click();
  await expect(page.getByRole('status')).toContainText('will see your yes');
  await expect(page.locator('.ask')).toHaveCount(0);
});

test('declining a proposal hides it for me and shows the answer to my partner', async ({
  page,
}) => {
  await openDemo(page);
  const card = page.locator('.ask').first();
  const title = (await card.locator('h3, h2').first().textContent())?.trim() ?? '';
  await card.getByRole('button', { name: 'Can’t make it' }).click();
  await expect(page.locator('.toast-host')).toContainText('can’t make it');
  await expect(page.locator('.ask')).toHaveCount(0);
  // Switch to the partner who asked: the plan is still there, marked declined.
  await nav(page, 'Settings');
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await nav(page, 'Plan');
  const row = page.locator('.ev.is-declined').first();
  await expect(row).toContainText('can’t make it');
  if (title) await expect(row).toContainText(title);
  // WebKit can lose a tap that lands while the freshly switched view re-renders.
  await expect(async () => {
    if (!(await page.getByRole('dialog').isVisible())) await row.click();
    await expect(page.getByRole('button', { name: 'Ask again' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Ask again' }).click();
  await expect(page.locator('.toast-host')).toContainText('Asked Sam again');
});

test('quick add parses natural language and adds a plan', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('n');
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await expect(dialog).toBeVisible();
  await page
    .getByRole('textbox', { name: 'What’s the plan?' })
    .fill('pottery tomorrow 6pm @ Clay Co');
  await expect(dialog.getByText('Tomorrow', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Clay Co')).toBeVisible();
  await dialog.getByRole('button', { name: 'Mine' }).click();
  await dialog.getByRole('button', { name: 'Add plan' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: /Pottery/ })).toBeVisible();
});

test('reminders: quick choices, a custom one, removable, and kept', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('n');
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('Dentist tomorrow 9am');
  await dialog.getByRole('button', { name: 'Mine' }).click();
  await dialog.getByRole('button', { name: 'Add plan' }).click();
  await page
    .getByRole('button', { name: /Dentist/ })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: 'Dentist' });
  const group = sheet.getByRole('group', { name: 'Remind me' });
  await group.getByRole('button', { name: 'Add a reminder' }).click();
  await group
    .getByRole('group', { name: 'Quick choices' })
    .getByRole('button', { name: '1 hour before' })
    .click();
  // A custom one: 1 hour 30 minutes = 90 minutes.
  const custom = group.getByRole('group', { name: 'Or your own' });
  await custom.getByRole('spinbutton', { name: 'How long before' }).fill('90');
  await custom.getByRole('combobox', { name: 'Unit' }).selectOption('minutes');
  await expect(group.getByText('1 hour 30 minutes before').first()).toBeVisible(); // preview
  await group.getByRole('button', { name: 'Add reminder' }).click();
  // The same one again is refused, in words.
  await group.getByRole('button', { name: 'Add reminder' }).click();
  await expect(group.getByRole('alert')).toHaveText('You already have that reminder.');
  const chips = group.getByRole('list', { name: 'Reminders' });
  await expect(chips.getByRole('listitem')).toHaveText([
    '1 hour before',
    '1 hour 30 minutes before',
  ]);
  await chips.getByRole('button', { name: 'Remove reminder: 1 hour before' }).click();
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: /Dentist/ })
    .first()
    .click();
  await expect(
    page
      .getByRole('dialog', { name: 'Dentist' })
      .getByRole('list', { name: 'Reminders' })
      .getByRole('listitem'),
  ).toHaveText(['1 hour 30 minutes before']);
});

test('all-day plans: a reminder some days before, at a chosen time', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Add a milestone' }).click();
  const form = page.getByRole('dialog', { name: /New plan/ });
  await form.getByRole('textbox', { name: 'What' }).fill('Concert');
  const group = form.getByRole('group', { name: 'Remind me' });
  await group.getByRole('button', { name: 'Add a reminder' }).click();
  const custom = group.getByRole('group', { name: 'Or your own' });
  await custom.getByRole('spinbutton', { name: /Days before/ }).fill('3');
  await custom.getByLabel('Time').fill('20:00');
  // Enter adds the reminder; it doesn't submit the plan.
  await custom.getByLabel('Time').press('Enter');
  await expect(group.getByRole('list', { name: 'Reminders' })).toContainText('3 days before at 8');
  await expect(form).toBeVisible();
});

test('default reminders apply to new plans', async ({ page }) => {
  await openDemo(page, 'privacy');
  const timed = page.getByRole('group', { name: 'Plans with a time' });
  await timed.getByRole('button', { name: 'Add a reminder' }).click();
  await timed.getByRole('button', { name: '30 minutes before' }).click();
  await nav(page, 'Plan');
  await page.keyboard.press('n');
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('Haircut tomorrow 2pm');
  await dialog.getByRole('button', { name: 'Mine' }).click();
  await dialog.getByRole('button', { name: 'Add plan' }).click();
  await page
    .getByRole('button', { name: /Haircut/ })
    .first()
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Haircut' }).getByRole('list', { name: 'Reminders' }),
  ).toHaveText('30 minutes before');
});

test('a private plan is hidden from the partner but visible as Busy', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('n');
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await page.getByRole('textbox', { name: 'What’s the plan?' }).fill('surprise planning today 1pm');
  await dialog.getByRole('button', { name: 'Mine' }).click();
  await dialog.getByRole('switch', { name: /Keep the details private/ }).check();
  await dialog.getByRole('button', { name: 'Add plan' }).click();
  await expect(page.getByRole('button', { name: /Surprise planning/ })).toBeVisible();

  await nav(page, 'Settings');
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await nav(page, 'Plan');
  await expect(page.getByText('Surprise planning')).toHaveCount(0);
  await expect(page.getByText('Therapy')).toBeVisible();
});

test('event sheet: notes and delete with undo', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /Ours: Dinner with Jordan/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Dinner with Jordan & Priya' });
  await expect(dialog.getByText('I can drive if you grab the wine.')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Note' }).fill('Booked a table.');
  await dialog.getByRole('button', { name: 'Send note' }).click();
  await expect(dialog.getByText('Booked a table.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete plan' }).click();
  await dialog.getByRole('button', { name: 'Tap again to confirm' }).click();
  await expect(page.getByRole('button', { name: /Ours: Dinner with Jordan/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /Ours: Dinner with Jordan/ })).toBeVisible();
});

test('escape closes a sheet and returns focus', async ({ page }) => {
  await openDemo(page);
  const trigger = page.getByRole('button', { name: /Ours: Dinner with Jordan/ });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('lists: add, assign, check off; private list is hidden from the partner', async ({ page }) => {
  await openDemo(page, 'lists');
  await page.getByRole('textbox', { name: 'Add to Groceries' }).fill('Basil');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'Basil' });
  await row.getByRole('button', { name: /No one yet/ }).click();
  await expect(row.getByRole('button', { name: /Sam is on it/ })).toBeVisible();
  await row.getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: /Show done · 2/ })).toBeVisible();

  await expect(page.getByRole('button', { name: /Gift ideas/ })).toBeVisible();
  await nav(page, 'Settings');
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await nav(page, 'Lists');
  await expect(page.getByRole('button', { name: /Gift ideas/ })).toHaveCount(0);
});

test('date ideas: pick one and plan it', async ({ page }) => {
  await openDemo(page, 'lists');
  await page.getByRole('button', { name: /Date ideas/ }).click();
  await page.getByRole('button', { name: 'Pick one for us' }).click();
  await expect(page.getByText('Your pick')).toBeVisible();
  await page.getByRole('button', { name: /^Ask Alex/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await dialog.getByRole('button', { name: 'Send to Alex' }).click();
  await expect(page.getByRole('status')).toContainText('Sent to Alex');
});

test('check-in: finish after four steps', async ({ page }) => {
  await openDemo(page, 'checkin');
  await expect(page.getByText('Alex’s note')).toBeVisible();
  const finish = page.getByRole('button', { name: 'Finish check-in' });
  await expect(finish).toBeDisabled();
  for (const step of [
    'Look at the week ahead',
    'Share out what needs doing',
    'Plan time together',
  ]) {
    await page.getByRole('button', { name: `Done: ${step}` }).click();
  }
  await page.getByRole('textbox', { name: 'Note for Alex' }).fill('Excited for Lisbon.');
  await page.getByRole('button', { name: 'Done: Anything on your mind?' }).click();
  await finish.click();
  await expect(page.getByRole('status')).toContainText('Check-in saved');
});

test('theme override applies', async ({ page }) => {
  await openDemo(page, 'privacy');
  await page
    .getByRole('group', { name: 'Appearance' })
    .getByRole('button', { name: 'Dark' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('the demo makes no network requests beyond the site itself', async ({ page }) => {
  const origins = new Set<string>();
  page.on('request', (r) => origins.add(new URL(r.url()).origin));
  for (const tab of ['plan', 'lists', 'checkin', 'privacy']) await openDemo(page, tab);
  expect([...origins]).toEqual(['http://localhost:4173']);
});

test('check-in: each count opens the plans behind it', async ({ page }) => {
  await openDemo(page, 'checkin');
  const counts = page.getByRole('group', { name: 'Show plans' });
  const together = counts.getByRole('button', { name: /Together/ });
  await together.click();
  await expect(together).toHaveAttribute('aria-pressed', 'true');
  // Plans the two of you share this week, each opening its details.
  const list = page.locator('.weeklist');
  await expect(list).toContainText('Trash & recycling out');
  await list.locator('.ev').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  // Alex's include their private plan, shown only as Busy.
  await counts.getByRole('button', { name: /Alex/ }).click();
  await expect(list).toContainText('Busy');
  await expect(list).not.toContainText('Therapy');
  await expect(list.getByRole('link', { name: 'See the whole week' })).toHaveAttribute(
    'href',
    '#plan/week',
  );
  // Tapping the open count again closes the list.
  await counts.getByRole('button', { name: /Alex/ }).click();
  await expect(list).toHaveCount(0);
});
