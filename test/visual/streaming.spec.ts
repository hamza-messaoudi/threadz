import { expect, test } from '@playwright/test';
import { openLab } from './lab.ts';

// Streams the demo report character by character (8 per frame) through MessageMarkdown and watches
// every frame: blocks that are no longer last must not move by more than one line, the message must
// never shrink by more than a line, and nothing may throw.
test('streaming report.md: no layout jumps, no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await openLab(page, 'report', 'light', 'message', '&speed=8');
  await page.getByRole('button', { name: 'stream', exact: true }).click();
  await page.locator('.md-streaming').waitFor();
  await page.evaluate(() => {
    const w = window as any;
    w.__jumps = [];
    w.__frames = 0;
    const tops = new Map<number, number>();
    let lastHeight = 0;
    const LINE = 26;
    const sample = () => {
      const body = document.querySelector<HTMLElement>('[data-testid=lab-canvas] .md-body');
      if (body) {
        w.__frames++;
        const blocks = [...body.querySelectorAll<HTMLElement>(':scope > [data-block]')];
        const base = body.getBoundingClientRect().top;
        blocks.slice(0, -1).forEach((b) => {
          const i = Number(b.dataset.block);
          const top = b.getBoundingClientRect().top - base;
          const was = tops.get(i);
          if (was === undefined) tops.set(i, top);
          else if (Math.abs(top - was) > LINE) {
            w.__jumps.push(`block ${i} moved ${Math.round(top - was)}px`);
            tops.set(i, top);
          }
        });
        const h = body.getBoundingClientRect().height;
        if (h < lastHeight - LINE) w.__jumps.push(`message shrank ${Math.round(lastHeight - h)}px at ${blocks.at(-1)?.textContent?.slice(0, 40)}`);
        lastHeight = h;
      }
      if (!document.querySelector('.md-streaming') && w.__frames > 10) return;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await expect(page.locator('.md-streaming')).toHaveCount(0, { timeout: 60000 });
  const r = await page.evaluate(() => ({ jumps: (window as any).__jumps as string[], frames: (window as any).__frames as number }));
  expect(r.frames).toBeGreaterThan(100);
  expect(r.jumps).toEqual([]);
  expect(errors).toEqual([]);
  await expect(page.locator('[data-testid=lab-canvas] figure').nth(11)).toBeVisible();
});
