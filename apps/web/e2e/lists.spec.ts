// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main' })
    .filter({ visible: true })
    .getByRole('link', { name })
    .click();

async function newList(page: Page, start: string, name?: string) {
  await page.getByRole('button', { name: 'New list' }).click();
  const dialog = page.getByRole('dialog', { name: 'New list' });
  await dialog
    .getByRole('group', { name: 'Start from' })
    .getByRole('button', { name: new RegExp(`^${start}`) })
    .click();
  if (name) await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  return dialog;
}

const settingsOf = async (page: Page, list: string) => {
  await page.getByRole('button', { name: `List settings: ${list}` }).click();
  return page.getByRole('dialog', { name: 'List settings' });
};

test('make a shared list and add to it', async ({ page }) => {
  await page.goto('/#lists');
  const dialog = await newList(page, 'To-dos', 'Hardware store');
  await expect(dialog.getByRole('switch', { name: /Just for me/ })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Make list' }).click();
  await expect(page.getByRole('button', { name: /Hardware store/, pressed: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Add to Hardware store' }).fill('Picture hooks');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Picture hooks')).toBeVisible();
});

test('gift lists are private by default and hidden from the partner', async ({ page }) => {
  await page.goto('/#lists');
  const dialog = await newList(page, 'Gift ideas', 'Birthday');
  await expect(dialog.getByRole('switch', { name: /Just for me/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Make list' }).click();
  await expect(page.getByRole('button', { name: /Private: Birthday/ })).toBeVisible();
  await nav(page, 'Privacy');
  await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Alex' }).click();
  await nav(page, 'Lists');
  await expect(page.getByRole('button', { name: /Birthday/ })).toHaveCount(0);
});

test('a date-ideas list gets "pick one for us"', async ({ page }) => {
  await page.goto('/#lists');
  const dialog = await newList(page, 'Date ideas', 'Rainy days');
  await dialog.getByRole('button', { name: 'Make list' }).click();
  await expect(page.getByRole('button', { name: 'Pick one for us' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Add to Rainy days' }).fill('Museum and noodles');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Pick one for us' }).click();
  await expect(page.getByRole('heading', { name: 'Museum and noodles' })).toBeVisible();
});

test('settings: rename, switch features, make private, delete with undo', async ({ page }) => {
  await page.goto('/#lists');
  const dialog = await settingsOf(page, 'Groceries');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Food shop');
  // Prices: each item gets one, and the list a total.
  await dialog.getByRole('switch', { name: /^Prices/ }).check();
  await dialog.getByRole('switch', { name: /Just for me/ }).check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: /Private: Food shop/ })).toBeVisible();
  await expect(page.getByText('Oat milk')).toBeVisible();
  await page.getByRole('button', { name: 'Details: Oat milk' }).click();
  const item = page.getByRole('dialog', { name: 'Oat milk' });
  await item.getByLabel(/^Price/).fill('3.49');
  await item.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.total')).toContainText('3.49');

  const again = await settingsOf(page, 'Food shop');
  await again.getByRole('button', { name: /^Delete list/ }).click();
  await again.getByRole('button', { name: 'Tap again to delete' }).click();
  await expect(page.getByRole('button', { name: /Food shop/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Private: Food shop/ })).toBeVisible();
});

test('any shared list can be part of the weekly check-in', async ({ page }) => {
  // The demo's Home list is part of it.
  await page.goto('/#checkin');
  await expect(page.getByText('Book furnace service')).toBeVisible();
  await expect(page.getByText('Oat milk')).toHaveCount(0);

  // Turn it on for Groceries too: both lists come up, by name.
  await page.goto('/#lists');
  const dialog = await settingsOf(page, 'Groceries');
  await dialog.getByRole('switch', { name: 'Part of the weekly check-in' }).check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.goto('/#checkin');
  await expect(page.getByText('Oat milk')).toBeVisible();
  await expect(page.locator('.sublbl', { hasText: 'Groceries' })).toBeVisible();

  // Private lists can't be (the check-in is shared).
  await page.goto('/#lists');
  const again = await settingsOf(page, 'Groceries');
  await again.getByRole('switch', { name: /Just for me/ }).check();
  await expect(again.getByRole('switch', { name: 'Part of the weekly check-in' })).toHaveCount(0);
});

test('starting points, a blank list to set up, and your own saved ones', async ({ page }) => {
  await page.goto('/#lists');
  const dialog = await newList(page, 'Blank list', 'Camping');
  await expect(
    dialog.getByRole('group', { name: 'Start from' }).getByRole('button', { pressed: false }),
  ).toHaveCount(9);
  await dialog.getByRole('button', { name: 'Make list' }).click();
  // A blank list opens its settings, to switch on what it needs.
  const settings = page.getByRole('dialog', { name: 'List settings' });
  await expect(settings.getByRole('switch', { name: /^Tick off/ })).toBeChecked();
  await settings.getByRole('switch', { name: /^How many/ }).check();
  await settings.getByRole('switch', { name: /^Sections/ }).check();
  await settings.getByRole('button', { name: 'Save as a starting point' }).click();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast-host')).toContainText('Saved “Camping”');
  await settings.getByRole('button', { name: 'Done', exact: true }).click();

  // Sections group things as they're added.
  await page.getByRole('textbox', { name: 'Add to Camping' }).fill('Tent pegs');
  await page.getByRole('combobox', { name: 'Section' }).fill('Gear');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Gear' })).toBeVisible();

  // The saved starting point is offered next time.
  const next = await newList(page, 'Camping', 'Beach');
  await next.getByRole('button', { name: 'Make list' }).click();
  await expect(page.getByRole('combobox', { name: 'Section' })).toBeVisible();
});

test('start over and copy a list', async ({ page }) => {
  await page.goto('/#lists');
  await page
    .getByRole('button', { name: /^Groceries/ })
    .first()
    .click();
  await page.locator('.it', { hasText: 'Oat milk' }).getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: /Show done · 2/ })).toBeVisible();
  await page.getByRole('button', { name: 'Start over' }).click();
  await expect(
    page.locator('.it', { hasText: 'Sourdough' }).getByRole('checkbox'),
  ).not.toBeChecked();

  const dialog = await settingsOf(page, 'Groceries');
  await dialog.getByRole('button', { name: 'Copy list' }).click();
  await expect(
    page.getByRole('button', { name: /Groceries \(copy\)/, pressed: true }),
  ).toBeVisible();
  await expect(page.getByText('Bay leaves')).toBeVisible();
});

test('we both want, we did it, and favourites', async ({ page }) => {
  await page.goto('/#lists');
  await page
    .getByRole('button', { name: /^Date ideas/ })
    .first()
    .click();
  // Only what the two of you both hearted.
  await page
    .getByRole('group', { name: 'Show only' })
    .getByRole('button', { name: 'We both want' })
    .click();
  await expect(page.locator('.items .it')).toHaveCount(2);
  await page.getByRole('button', { name: 'Pick one for us' }).click();
  await expect(page.locator('.picked h2')).toHaveText(/Pottery class|Georgian place/);
  await page
    .getByRole('group', { name: 'Show only' })
    .getByRole('button', { name: 'We both want' })
    .click();

  // Hearting one makes it agreed when the partner already did.
  const walk = page.locator('.it', { hasText: 'Night walk' });
  await walk.getByRole('button', { name: /I’d like this/ }).click();
  await expect(walk).toHaveClass(/agreed/);

  // We did it (in the idea's details: rows stay one line), how it was, a favourite.
  await page.getByRole('button', { name: 'Details: Night walk and dumplings' }).click();
  const sheet = page.getByRole('dialog', { name: 'Night walk and dumplings' });
  await sheet.getByRole('button', { name: 'We did it' }).click();
  await sheet.getByRole('button', { name: 'Loved it' }).click();
  await sheet.getByRole('switch', { name: /Do it again/ }).check();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await page
    .getByRole('group', { name: 'Show only' })
    .getByRole('button', { name: 'Favourites' })
    .click();
  await expect(page.locator('.items .it')).toHaveCount(2);
  await expect(walk).toContainText('Did it today');
});

test('a plan’s checklist, due in the days before it', async ({ page }) => {
  await page.goto('/#lists');
  await page
    .getByRole('button', { name: /^For Lisbon/ })
    .first()
    .click();
  await expect(page.locator('.note', { hasText: 'For' })).toContainText('Lisbon trip');
  await expect(page.locator('.it', { hasText: 'Passports' })).toContainText('Due');
  // From the plan, a new checklist can be added.
  await page.locator('.note button', { hasText: 'Lisbon trip' }).click();
  const plan = page.getByRole('dialog', { name: 'Lisbon trip' });
  await expect(plan.getByRole('button', { name: /For Lisbon/ })).toBeVisible();
  await plan.getByRole('button', { name: 'Add a checklist' }).click();
  await expect(page.getByRole('button', { name: /For Lisbon trip/, pressed: true })).toBeVisible();
});

test('views across lists', async ({ page }) => {
  await page.goto('/#lists');
  const views = page.getByRole('group', { name: 'Across all lists' });
  await views.getByRole('button', { name: /We both want/ }).click();
  await expect(page.getByRole('heading', { name: 'We both want' })).toBeVisible();
  await expect(page.locator('.it', { hasText: 'Pottery class' })).toContainText('Date ideas');
  await views.getByRole('button', { name: /On me/ }).click();
  await expect(page.locator('.it', { hasText: 'Book furnace service' })).toBeVisible();
});

test('repeating tasks: typed, ticked, and set up in details', async ({ page }) => {
  await page.goto('/#lists');
  // The demo's Home list has one: ticking moves it on instead of finishing it.
  await page.getByRole('button', { name: /^Home/ }).first().click();
  const bins = page.locator('.it', { hasText: 'Take out the bins' });
  await expect(bins).toContainText('Every Monday, taking turns');
  await bins.getByRole('checkbox').check();
  await expect(page.locator('.toast-host')).toContainText('Done. Next:');
  await expect(bins).toBeVisible();
  await expect(bins.getByRole('checkbox')).not.toBeChecked();

  // Typing a repeat sets it up.
  await page
    .getByRole('textbox', { name: /Add to Home/ })
    .fill('Change the bedsheets every sunday');
  await page.getByRole('textbox', { name: /Add to Home/ }).press('Enter');
  const sheets = page.locator('.it', { hasText: 'Change the bedsheets' });
  await expect(sheets).toContainText('Every Sunday');
  await expect(sheets).not.toContainText('every sunday'); // taken out of the name

  // Details: repeat every 2 weeks, take turns.
  await sheets.getByRole('button', { name: /^Details:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the bedsheets' });
  await dialog.getByRole('combobox', { name: 'Repeats' }).selectOption({ label: 'Every 2 weeks' });
  await dialog.getByRole('switch', { name: 'Take turns' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(sheets).toContainText('Every other week, taking turns');
});

test('the check-in remembers something you did a month ago', async ({ page }) => {
  await page.goto('/#checkin');
  const recall = page.locator('.recall');
  await expect(recall).toContainText('About a month ago you did “Board game café”');
  await recall.getByRole('button', { name: 'Do it again' }).click();
  await expect(page.getByRole('dialog', { name: 'New plan' })).toBeVisible();
});

test('the rows of views and lists scroll sideways only', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'), 'the rows scroll on phones');
  await page.goto('/#lists');
  for (const sel of ['.xviews', '.ltabs']) {
    const box = await page.locator(sel).evaluate((el) => {
      const s = getComputedStyle(el);
      return { y: s.overflowY, fits: el.scrollHeight <= el.clientHeight };
    });
    expect(box, sel).toEqual({ y: 'hidden', fits: true });
  }
});

test('select several items and change them together, with undo', async ({ page }) => {
  await page.goto('/#lists');
  const dialog = await newList(page, 'To-dos', 'Errands');
  await dialog.getByRole('button', { name: 'Make list' }).click();
  const add = page.getByRole('textbox', { name: 'Add to Errands' });
  for (const t of ['Post office', 'Bank', 'Pharmacy']) {
    await add.fill(t);
    await add.press('Enter');
    await expect(page.locator('.it', { hasText: t })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select Post office' }).check();
  await page.getByRole('checkbox', { name: 'Select Bank' }).check();
  const bar = page.getByRole('region', { name: 'Change the selected items' });
  await expect(bar).toContainText('2 selected');

  // The same due date for both.
  await bar.getByRole('button', { name: 'Due date' }).click();
  await bar.getByLabel('Due date').fill('2030-01-15');
  await bar.getByRole('button', { name: 'Set' }).click();
  await expect(page.locator('.toast-host')).toContainText('2 items due');
  for (const t of ['Post office', 'Bank'])
    await expect(page.locator('.it', { hasText: t })).toContainText('Jan 15');
  await expect(page.locator('.it', { hasText: 'Pharmacy' })).not.toContainText('Jan 15');

  // Both to one person, then undone.
  await bar.getByRole('button', { name: 'Assign' }).click();
  await bar.getByRole('button', { name: 'Me' }).click();
  await expect(page.locator('.toast-host')).toContainText('You’re on 2 items');
  await page.locator('.toast-host').getByRole('button', { name: 'Undo' }).click();
  await bar.getByRole('button', { name: 'Assign' }).click();
  await bar.getByRole('button', { name: 'Me' }).click();

  // Ticked off together; selecting ends.
  await bar.getByRole('button', { name: 'Mark done' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('.it', { hasText: 'Post office' })).toHaveCount(0);
  await expect(page.locator('.it', { hasText: 'Pharmacy' })).toBeVisible();
  await page.getByRole('button', { name: /Show done · 2/ }).click();
  await expect(page.getByRole('button', { name: /is on it\. Change: Post office/ })).toBeVisible();
});

test('the check-in shows free evenings even without a list of date ideas', async ({ page }) => {
  await page.goto('/#lists');
  await page
    .getByRole('button', { name: /^Date ideas/ })
    .first()
    .click();
  const settings = await settingsOf(page, 'Date ideas');
  await settings.getByRole('button', { name: /^Delete list/ }).click();
  await settings.getByRole('button', { name: 'Tap again to delete' }).click();
  await expect(page.getByRole('button', { name: /Date ideas/ })).toHaveCount(0);

  await nav(page, 'Check-in');
  await expect(page.getByText('No shared free evenings')).toHaveCount(0);
  const dates = page.getByRole('group', { name: 'Evenings you’re both free' });
  await expect(dates.getByRole('button').first()).toBeVisible();
  await page.getByRole('textbox', { name: 'Do what?' }).fill('Dinner out');
  await page.getByRole('button', { name: /^Ask Alex · / }).click();
  await nav(page, 'Plan');
  await expect(page.getByRole('button', { name: /Dinner out/ }).first()).toBeVisible();
});

test('switch lists, pin one, move an item and bring a done one back (review 0008)', async ({
  page,
}) => {
  await page.goto('/#lists');
  // The list's name opens every list, grouped.
  await page.locator('.lswitch').click();
  const sw = page.getByRole('dialog', { name: 'Your lists' });
  await expect(sw.getByRole('heading', { name: 'Just for you' })).toBeVisible();
  await sw.getByRole('button', { name: 'Change the order or pin lists' }).click();
  await sw.getByRole('button', { name: 'Pin Date ideas' }).click();
  await sw.getByRole('button', { name: 'Done' }).click();
  await sw.getByRole('button', { name: /^Groceries/ }).click();
  await expect(page.getByRole('dialog', { name: 'Your lists' })).toHaveCount(0);
  await expect(page.locator('.ltabs .ltab').first()).toContainText('Date ideas');

  // Move Oat milk to Home from its details, then undo.
  await page.getByRole('button', { name: 'Details: Oat milk' }).click();
  const item = page.getByRole('dialog', { name: 'Oat milk' });
  await item.getByLabel('List', { exact: true }).selectOption({ label: 'Home' });
  await expect(page.locator('.toast-host')).toContainText('Moved to “Home”');
  await expect(page.locator('.it', { hasText: 'Oat milk' })).toHaveCount(0);
  await page.locator('.toast-host').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.it', { hasText: 'Oat milk' })).toHaveCount(1);

  // Sections keep their order as items are added.
  const order = () => page.locator('.isec-fold').allInnerTexts();
  const before = (await order()).map((t) => t.split('\n')[0]);
  await page.getByRole('textbox', { name: 'Add to Groceries' }).fill('Peas');
  await page.getByRole('combobox', { name: 'Section' }).fill('Frozen');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const after = (await order()).map((t) => t.split('\n')[0]);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.at(-1)?.toLowerCase()).toContain('frozen');

  // Typing a done item's name brings it back instead of adding a copy.
  await page.locator('.it', { hasText: 'Peas' }).getByRole('checkbox').check();
  await expect(page.locator('.items .it', { hasText: 'Peas' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Add to Groceries' }).fill('peas');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.toast-host')).toContainText('Brought back “Peas”');
  await expect(page.locator('.items .it', { hasText: 'Peas' })).toHaveCount(1);
});

test('keyboard: n adds to the open list, arrows move between items (review 0008, L-16)', async ({
  page,
}, info) => {
  test.skip(info.project.name.includes('mobile'), 'keyboard');
  await page.goto('/#lists');
  await page
    .getByRole('button', { name: /^Groceries/ })
    .first()
    .click();
  await page.getByRole('heading', { name: 'Lists', level: 1 }).click(); // focus away from inputs
  await page.keyboard.press('n');
  await expect(page.getByRole('textbox', { name: 'Add to Groceries' })).toBeFocused();
  await page.keyboard.type('Basil');
  await page.keyboard.press('Enter');
  await expect(page.locator('.it', { hasText: 'Basil' })).toHaveCount(1);

  const first = page.locator('.listcard li.it').first().getByRole('checkbox');
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.listcard li.it').nth(1).getByRole('checkbox')).toBeFocused();
  await page.keyboard.press('e');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('a plan’s new checklist can start from the last trip’s (review 0008, L-9)', async ({
  page,
}) => {
  await page.goto('/#plan');
  await page.getByRole('button', { name: /Ours: Dinner with Jordan/ }).click();
  const plan = page.getByRole('dialog', { name: 'Dinner with Jordan & Priya' });
  await plan.getByRole('button', { name: 'Add a checklist' }).click();
  await plan.getByRole('button', { name: 'Last time: For Lisbon' }).click();
  await expect(page.getByRole('button', { name: /^For Dinner with Jordan/ }).first()).toBeVisible();
  await expect(page.locator('.it', { hasText: 'Passports' })).toHaveCount(1);
});
