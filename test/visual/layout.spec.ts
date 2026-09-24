import { expect, test } from '@playwright/test';
import { openLab } from './lab.ts';

test('a plain GFM table and ::graph-table with the same data look alike', async ({ page }) => {
  await openLab(page, 'tables', 'light');
  const tables = page.locator('.md-body figure table');
  await expect(tables).toHaveCount(2);
  const look = (i: number) =>
    tables.nth(i).evaluate((t) => {
      const cs = (el: Element | null) => {
        const s = getComputedStyle(el!);
        return [s.fontFamily, s.fontSize, s.color, s.textAlign, s.paddingTop, s.paddingLeft].join('|');
      };
      return {
        frame: t.closest('figure')!.className.includes('graph-frame'),
        th: [...t.querySelectorAll('thead th')].slice(0, 3).map(cs),
        td: [...t.querySelectorAll('tbody tr:first-child td')].map(cs),
        rows: t.querySelectorAll('tbody tr').length,
        rule: !!t.querySelector('thead .graph-rule'),
      };
    });
  const [plain, graph] = [await look(0), await look(1)];
  expect(plain).toEqual(graph);
});

test('::row collapses to one column in the thread panel and keeps two in the message column', async ({ page }) => {
  const columns = async () =>
    page
      .locator('.md-body figure')
      .filter({ hasText: 'Coverage' })
      .evaluate((f) => getComputedStyle(f.parentElement!).gridTemplateColumns.split(' ').length);
  await openLab(page, 'tables', 'light', 'message');
  expect(await columns()).toBe(2);
  await openLab(page, 'tables', 'light', 'thread');
  expect(await columns()).toBe(1);
});
