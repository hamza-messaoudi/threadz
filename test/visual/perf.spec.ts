import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openLab } from './lab.ts';

// Performance budgets from the Comark plan (Phase 8). Numbers are printed and recorded in NOTES.md.
// Needs the harness with VISUAL_BULK=200,500 (npm run test:perf).
const TOKEN = 'a'.repeat(48);
const seeded = () => JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `ac-visual-${process.env.VISUAL_PORT ?? 4799}.json`), 'utf8'));

test('open a channel with 200 messages including 40 figures: under 300 ms from data to rendered', async ({ page }) => {
  const bulkId = seeded().bulkIds['200'];
  test.skip(!bulkId, 'run with VISUAL_BULK=200,500 (npm run test:perf)');
  await page.goto(`/?t=${TOKEN}`);
  await page.locator('.sidebar').waitFor();
  const results: number[] = [];
  for (let run = 0; run < 3; run++) {
    await page.goto(`/settings?t=${TOKEN}`);
    await page.locator('.settings').waitFor();
    // Time from the thread response arriving to every message body being rendered.
    await page.evaluate(() => {
      const w = window as any;
      w.__dataAt = 0;
      w.__renderedAt = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) if (/\/api\/threads\/[^/]+$/.test(e.name)) w.__dataAt = e.responseEnd;
      }).observe({ type: 'resource', buffered: false });
      const check = () => {
        const bodies = document.querySelectorAll('.message-list .msg-body .md-body').length;
        if (bodies >= w.__expect && w.__dataAt) w.__renderedAt = performance.now();
        else requestAnimationFrame(check);
      };
      w.__expect = 0;
      w.__check = check;
    });
    await page.evaluate(() => {
      (window as any).__expect = 200;
      (window as any).__check();
    });
    await page.evaluate((id) => {
      history.pushState(null, '', `/c/${id}`);
      window.dispatchEvent(new Event('routechange'));
    }, bulkId);
    await page.waitForFunction(() => (window as any).__renderedAt > 0, null, { timeout: 20000 });
    results.push(await page.evaluate(() => (window as any).__renderedAt - (window as any).__dataAt));
  }
  console.log(`open channel: cold ${results[0].toFixed(0)} ms, re-open (parse cache) ${results.slice(1).map((r) => r.toFixed(0)).join(', ')} ms`);
  expect(results[0]).toBeLessThan(300);
});

test('parse time per streamed frame for a 5,000-character message: under 8 ms', async ({ page }) => {
  await openLab(page, 'report', 'light');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'markdown', 'report.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n+/, '');
  const r = await page.evaluate(async (md) => {
    const parse = (window as any).__labParse as (s: string) => Promise<unknown>;
    for (let i = 0; i < 20; i++) await parse(md.slice(0, 4000 + i)); // warm up
    const times: number[] = [];
    // Consecutive frames of a stream near 5,000 characters, a few characters apart.
    for (let at = 4800; at <= 5200; at += 4) {
      const t = performance.now();
      await parse(md.slice(0, at));
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return { median: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1] };
  }, src);
  console.log(`parse ~5,000 chars: median ${r.median.toFixed(2)} ms, p95 ${r.p95.toFixed(2)} ms, max ${r.max.toFixed(2)} ms`);
  expect(r.p95).toBeLessThan(8);
});

test('scroll through 500 messages: no long tasks over 50 ms after the first render', async ({ page }) => {
  const bulkId = seeded().bulkIds['500'];
  test.skip(!bulkId, 'run with VISUAL_BULK=200,500 (npm run test:perf)');
  await page.goto(`/c/${bulkId}?t=${TOKEN}`);
  await expect(page.locator('.message-list .msg')).toHaveCount(500, { timeout: 20000 });
  await page.waitForTimeout(500);
  const r = await page.evaluate(async () => {
    const long: number[] = [];
    const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration)));
    po.observe({ type: 'longtask' });
    const el = document.querySelector<HTMLElement>('.messages-scroll')!;
    el.scrollTop = 0;
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    const t = performance.now();
    for (let y = 0; y <= el.scrollHeight; y += 400) {
      el.scrollTop = y;
      await frame();
    }
    await new Promise((res) => setTimeout(res, 300));
    po.disconnect();
    return { long, height: el.scrollHeight, ms: performance.now() - t };
  });
  console.log(`scroll 500 messages (${r.height}px, ${r.ms.toFixed(0)} ms): long tasks ${JSON.stringify(r.long.map(Math.round))}`);
  expect(r.long.filter((d) => d > 50)).toEqual([]);
});
