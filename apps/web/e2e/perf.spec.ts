// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Speed with a couple's worth of history (reviews 0008 L-5 and 0009 P-1):
 * dozens of lists, thousands of items and plans. What a tap costs must depend
 * on what's on screen, not on everything ever saved. Budgets are generous for
 * slow CI machines; before the fixes these took several times as long.
 */
import { expect, type Page, test } from '@playwright/test';

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'timed once, on one browser');
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

/** Adds lists, items and past plans to the demo store, then reloads. */
async function bigStore(page: Page) {
  await page.goto('/#lists');
  await expect(page.getByRole('heading', { name: 'Lists', level: 1 })).toBeVisible();
  await page.evaluate(() => {
    const raw = localStorage.getItem('ours-demo-v2');
    if (!raw) throw new Error('no demo store');
    const store = JSON.parse(raw);
    let n = 0;
    const now = Date.now();
    const id = (p: string) => `${p}-${(n++).toString(36).padStart(6, '0')}-perf`;
    const day = (offset: number) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
    const add = (kind: string, data: object) => {
      const e = {
        id: id(kind),
        scope: 'space',
        owner: null,
        rec: { kind, deleted: false, data, updated_at: now, device_id: 'demo-a' },
      };
      store.entries.push(e);
      return e.id;
    };
    const features = ['tick', 'who', 'due', 'sections', 'qty', 'notes'];
    for (let l = 0; l < 45; l++) {
      const list = add('list', {
        name: `Perf list ${l + 1}`,
        kind: 'todo',
        private: false,
        features,
        template: 'todo',
      });
      const count = l === 0 ? 400 : l === 1 ? 300 : 30;
      for (let i = 0; i < count; i++)
        add('item', {
          list_id: list,
          text: `Thing ${i + 1} on list ${l + 1}`,
          done: i % 3 === 0,
          assignee: i % 2 ? 'a' : null,
          due: i % 4 ? day((i % 40) - 20) : null,
          section: ['Produce', 'Dairy', 'Bakery', 'Frozen'][i % 4],
          sort_key: `${String(10000 + i)}1`,
        });
    }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (let i = 0; i < 3000; i++) {
      const d = day(-(30 + (i % 900)));
      add('event', {
        title: `Past plan ${i}`,
        start: `${d}T18:00`,
        end: `${d}T19:00`,
        all_day: false,
        tz,
        rrule: null,
        away: false,
        owner: i % 3 ? 'a' : 'both',
        status: 'confirmed',
        proposed_by: null,
        privacy: 'full',
        location: null,
        notes: null,
        countdown: false,
        stub_id: null,
      });
    }
    for (let i = 0; i < 15; i++)
      add('event', {
        title: `Routine ${i}`,
        start: `${day(-200)}T0${i % 10}:00`,
        end: `${day(-200)}T0${i % 10}:30`,
        all_day: false,
        tz,
        rrule: i % 2 ? 'FREQ=DAILY' : 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
        away: false,
        owner: 'a',
        status: 'confirmed',
        proposed_by: null,
        privacy: 'full',
        location: null,
        notes: null,
        countdown: false,
        stub_id: null,
      });
    localStorage.setItem('ours-demo-v2', JSON.stringify(store));
  });
  await page.reload();
}

/**
 * Milliseconds from a click to the next painted frame, as the browser's
 * Event Timing API measures it (what people feel as a tap's delay).
 */
async function timed(page: Page, click: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { tap: number; seen: PerformanceObserver };
    w.tap = 0;
    w.seen?.disconnect();
    w.seen = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.name === 'click' || e.name === 'pointerup' || e.name === 'pointerdown')
          w.tap = Math.max(w.tap, e.duration);
    });
    w.seen.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
  });
  await click();
  await page.waitForTimeout(400);
  return page.evaluate(() => (window as unknown as { tap: number }).tap);
}

test('lists stay quick with dozens of lists and thousands of items', async ({ page }) => {
  await bigStore(page);
  await page.goto('/#lists');
  const times: number[] = [];
  for (const name of ['Perf list 1', 'Perf list 7', 'Perf list 2', 'Perf list 30']) {
    const tab = page.getByRole('button', { name: new RegExp(`^${name} `) }).first();
    times.push(await timed(page, () => tab.click()));
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
  }
  const tick = page.getByRole('checkbox').first();
  const ticked = await timed(page, () => tick.click());
  test.info().annotations.push({
    type: 'timings',
    description: `list switches ${times.map(Math.round).join(', ')} ms; tick ${Math.round(ticked)} ms`,
  });
  for (const t of times) expect(t).toBeLessThan(150);
  expect(ticked).toBeLessThan(150);
});

test('the month view stays quick with years of past plans', async ({ page }) => {
  await bigStore(page);
  await page.goto('/#plan');
  await page.getByRole('button', { name: 'Month' }).click();
  const next = page.getByRole('button', { name: /^Next month/ });
  const times: number[] = [];
  for (let i = 0; i < 4; i++) times.push(await timed(page, () => next.click()));
  test.info().annotations.push({
    type: 'timings',
    description: `month steps ${times.map(Math.round).join(', ')} ms`,
  });
  for (const t of times) expect(t).toBeLessThan(200);
});
