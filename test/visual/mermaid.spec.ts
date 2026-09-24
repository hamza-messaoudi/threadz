import { expect, test } from '@playwright/test';
import { openLab } from './lab.ts';

const mermaidChunks = (urls: string[]) => urls.filter((u) => /\/assets\/(mermaid|MermaidBlock)[^/]*\.js$/.test(u));

test('a message without diagrams never downloads the Mermaid chunk', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  for (const f of ['prose', 'code', 'report']) await openLab(page, f, 'light');
  await page.waitForTimeout(500);
  expect(mermaidChunks(urls)).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`flowchart, sequence, state and ER diagrams render with dashed edges and Geist Mono (${scheme})`, async ({ page }) => {
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    await openLab(page, 'mermaid', scheme);
    const ready = page.locator('.md-mermaid[data-state=ready]');
    await expect(ready).toHaveCount(4, { timeout: 15000 });
    expect(mermaidChunks(urls).length).toBeGreaterThan(0);
    await expect(ready.first().locator('figcaption')).toContainText('Request path');
    const check = await ready.evaluateAll((figs) =>
      figs.map((f) => {
        const svg = f.querySelector('svg')!;
        const edges = [...svg.querySelectorAll<SVGElement>('.flowchart-link, .messageLine0, .messageLine1, .transition, .relationshipLine, path.relation')];
        const texts = [...svg.querySelectorAll('text, .nodeLabel')];
        return {
          dashed: edges.length > 0 && edges.every((e) => getComputedStyle(e).strokeDasharray.replace(/px/g, '').trim() === '2, 5'),
          mono: texts.length > 0 && texts.every((t) => getComputedStyle(t).fontFamily.includes('Geist Mono')),
          fits: svg.getBoundingClientRect().width <= f.getBoundingClientRect().width + 1,
          scripts: svg.querySelectorAll('script, foreignObject, [onclick]').length,
        };
      }),
    );
    for (const c of check) expect(c).toEqual({ dashed: true, mono: true, fits: true, scripts: 0 });
    await expect(page.getByTestId('lab-canvas')).toHaveScreenshot(`mermaid-${scheme}.png`, { animations: 'disabled' });
  });
}

test('an invalid diagram shows its source and a one-line error; the rest renders', async ({ page }) => {
  await openLab(page, 'mermaid', 'light');
  const bad = page.locator('.md-mermaid[data-state=error]');
  await expect(bad).toHaveCount(1, { timeout: 15000 });
  await expect(bad).toContainText('Could not draw this diagram');
  await expect(bad.locator('pre')).toContainText('A[Start --> B{{');
  await expect(page.getByText('Text after the broken diagram still renders.')).toBeVisible();
  // Mermaid's own error graphic never reaches the page.
  expect(await page.locator('body > [id^=dmd-mermaid], body > svg').count()).toBe(0);
});

test('a streaming diagram shows its source until the fence closes, then renders once', async ({ page }) => {
  await openLab(page, 'mermaid', 'light', 'message', '&speed=1');
  await expect(page.locator('.md-mermaid[data-state=ready]')).toHaveCount(4, { timeout: 15000 });
  await page.evaluate(() => {
    const w = window as any;
    w.__svgs = 0;
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n instanceof Element && (n.matches('.md-mermaid-svg') || n.querySelector('.md-mermaid-svg'))) w.__svgs++;
    }).observe(document.body, { subtree: true, childList: true });
  });
  await page.getByRole('button', { name: 'stream', exact: true }).click();
  // The first diagram's fence is open for a while: its source shows under [ DIAGRAM ].
  const open = page.locator('.md-code[data-language=mermaid]');
  await expect(open.first()).toBeVisible({ timeout: 10000 });
  await expect(open.first()).toContainText('[ DIAGRAM ]');
  await expect(page.locator('.md-mermaid-svg')).toHaveCount(0);
  await expect(page.locator('.md-mermaid[data-state=ready]')).toHaveCount(1, { timeout: 20000 });
  await page.waitForTimeout(700); // the next diagram is still streaming at this speed
  expect(await page.evaluate(() => (window as any).__svgs)).toBe(1);
});

test('expand opens the diagram in a full-width overlay', async ({ page }) => {
  await openLab(page, 'mermaid', 'light');
  await expect(page.locator('.md-mermaid[data-state=ready]')).toHaveCount(4, { timeout: 15000 });
  await page.locator('.md-mermaid').first().getByRole('button', { name: 'expand' }).click();
  const overlay = page.getByRole('dialog', { name: 'Request path' });
  await expect(overlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
});
