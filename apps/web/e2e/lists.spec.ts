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

async function newList(page: Page, kind: string, name?: string) {
  await page.getByRole('button', { name: 'New list' }).click();
  const dialog = page.getByRole('dialog', { name: 'New list' });
  await dialog
    .getByRole('group', { name: 'What kind of list?' })
    .getByRole('button', { name: new RegExp(`^${kind}`) })
    .click();
  if (name) await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  return dialog;
}

test('make a shared shopping list and add to it', async ({ page }) => {
  await page.goto('/#lists');
  const dialog = await newList(page, 'Shopping', 'Hardware store');
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
  await page.getByRole('textbox', { name: 'Add a date idea' }).fill('Museum and noodles');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Pick one for us' }).click();
  await expect(page.getByRole('heading', { name: 'Museum and noodles' })).toBeVisible();
});

test('edit: rename, change kind, make private, delete with undo', async ({ page }) => {
  await page.goto('/#lists');
  await page.getByRole('button', { name: 'Edit list: Groceries' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit list' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Food shop');
  await dialog
    .getByRole('group', { name: 'Kind' })
    .getByRole('button', { name: /^To-dos/ })
    .click();
  await dialog.getByRole('switch', { name: /Just for me/ }).check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: /Private: Food shop/ })).toBeVisible();
  await expect(page.getByText('To-dos')).toBeVisible();
  await expect(page.getByText('Oat milk')).toBeVisible();

  await page.getByRole('button', { name: 'Edit list: Food shop' }).click();
  const again = page.getByRole('dialog', { name: 'Edit list' });
  await again.getByRole('button', { name: /^Delete list/ }).click();
  await again.getByRole('button', { name: 'Tap again to delete' }).click();
  await expect(page.getByRole('button', { name: /Food shop/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /Food shop/ })).toBeVisible();
});

test('the check-in uses the chores list', async ({ page }) => {
  await page.goto('/#checkin');
  await expect(page.getByText('Book furnace service')).toBeVisible();
});
