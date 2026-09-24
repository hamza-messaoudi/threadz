import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openLab } from './lab.ts';

const INFRA = /^(index|StyleLab|shiki|github-light|github-dark|CodeBlock|langs|rolldown|engine|core|preload)/;
const FIXTURES = new Set(fs.readdirSync(path.join(import.meta.dirname, '..', 'fixtures', 'markdown')).map((f) => f.replace(/\.md$/, '')));

test('the first TypeScript block loads only the TypeScript grammar; a second loads nothing', async ({ page }) => {
  const chunks: string[] = [];
  page.on('request', (r) => {
    const m = /\/assets\/([^/]+?)-[\w-]{8}\.js$/.exec(r.url());
    if (m) chunks.push(m[1]);
  });
  await openLab(page, 'code-ts', 'light');
  await expect(page.locator('.md-shiki')).toHaveCount(2);
  const grammars = chunks.filter((c) => !INFRA.test(c) && !FIXTURES.has(c));
  expect(grammars).toEqual(['typescript']);
});

test('the theme toggle recolours code without highlighting again', async ({ page }) => {
  await openLab(page, 'code-ts', 'light');
  const code = page.locator('.md-shiki').first();
  await expect(code).toBeVisible();
  await code.evaluate((el) => ((el as any).__marker = 1));
  const kw = code.locator('span').first();
  const before = await kw.evaluate((el) => getComputedStyle(el).color);
  await page.getByRole('button', { name: 'dark', exact: true }).click();
  const after = await kw.evaluate((el) => getComputedStyle(el).color);
  expect(after).not.toBe(before);
  expect(await code.evaluate((el) => (el as any).__marker)).toBe(1); // same DOM node: no re-render of the HTML
});

test('a streaming 200-line code block stays plain, then highlights once at the end', async ({ page }) => {
  await openLab(page, 'code-long', 'light', 'message', '&speed=40');
  await expect(page.locator('.md-shiki')).toHaveCount(1); // the static render, before streaming starts
  await page.evaluate(() => {
    (window as any).__shikiInserts = 0;
    // React may reuse the <code> element, so count both inserted nodes and class changes to .md-shiki.
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'attributes' && (m.target as HTMLElement).matches('.md-shiki') && !(m.oldValue ?? '').includes('md-shiki')) (window as any).__shikiInserts++;
        for (const n of m.addedNodes) if (n instanceof HTMLElement && (n.matches('.md-shiki') || n.querySelector('.md-shiki'))) (window as any).__shikiInserts++;
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  });
  await page.getByRole('button', { name: 'stream', exact: true }).click();
  // Mid-stream: the code block exists, is plain.
  await expect(page.locator('.md-code')).toHaveCount(1, { timeout: 5000 });
  await page.waitForTimeout(500);
  expect(await page.locator('.md-shiki').count()).toBe(0);
  await expect(page.locator('.md-shiki')).toHaveCount(1, { timeout: 30000 });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__shikiInserts)).toBe(1);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`code lab snapshot (${scheme})`, async ({ page }) => {
    await openLab(page, 'code', scheme);
    await expect(page.locator('.md-shiki')).toHaveCount(5);
    await expect(page.getByTestId('lab-canvas')).toHaveScreenshot(`code-${scheme}.png`, { animations: 'disabled' });
  });
}
