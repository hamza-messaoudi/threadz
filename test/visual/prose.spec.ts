import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const TOKEN = 'a'.repeat(48);
const demo = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'reference', 'prose-styles.json'), 'utf8'));

export async function openLab(page: Page, fixture: string, scheme: 'light' | 'dark', width = 'message') {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`/dev/markdown?fixture=${fixture}&width=${width}&t=${TOKEN}`);
  await page.locator('[data-testid=lab-canvas] .md-body').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

const STYLE = ['fontSize', 'lineHeight', 'fontWeight', 'color', 'letterSpacing', 'textTransform', 'textDecorationLine', 'textDecorationStyle', 'textUnderlineOffset', 'fontStyle', 'backgroundColor'] as const;

for (const scheme of ['light', 'dark'] as const) {
  test(`prose matches the demo's computed styles (${scheme})`, async ({ page }) => {
    await openLab(page, 'prose', scheme);
    const got = await page.evaluate((props) => {
      const c = document.querySelector('[data-testid=lab-canvas]')!;
      const pick = (sel: string): Record<string, string> | null => {
        const el = c.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { family: cs.fontFamily, ...Object.fromEntries(props.map((k) => [k, cs[k] as string])) };
      };
      return { p: pick('.comark-content > p'), a: pick('.comark-content > p a'), code: pick('.comark-content > p code'), h2: pick('.comark-content > h2') };
    }, [...STYLE]);
    // Tailwind serialises colours as oklch, Next's build as lab(): compare rendered RGBA instead.
    const rgba = (colors: string[]) =>
      page.evaluate((cs) => {
        const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        return cs.map((c) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data].join(',');
        });
      }, colors);
    const COLOR = new Set(['color', 'backgroundColor']);
    const ref = structuredClone(demo[scheme]);
    for (const el of ['p', 'a', 'code', 'h2'] as const)
      for (const k of COLOR) {
        const [g, r] = await rgba([got[el]![k], ref[el][k]]);
        got[el]![k] = g;
        ref[el][k] = r;
      }
    for (const el of ['p', 'a', 'code'] as const) {
      for (const k of STYLE) expect.soft(got[el]![k], `${el}.${k}`).toBe(ref[el][k]);
      expect(got[el]!.family).toContain(el === 'code' ? 'Geist Mono' : 'Geist');
    }
    // Headings are one step smaller than the demo's; everything else about them is the same.
    for (const k of ['color', 'letterSpacing', 'textTransform', 'fontWeight'] as const) {
      if (k === 'letterSpacing') expect(parseFloat(got.h2![k]) / parseFloat(got.h2!.fontSize)).toBeCloseTo(parseFloat(ref.h2[k]) / parseFloat(ref.h2.fontSize), 3);
      else expect.soft(got.h2![k], `h2.${k}`).toBe(ref.h2[k]);
    }
    expect(got.h2!.family).toContain('Geist Mono');
  });

  test(`prose lab snapshot (${scheme})`, async ({ page }) => {
    await openLab(page, 'prose', scheme);
    await expect(page.getByTestId('lab-canvas')).toHaveScreenshot(`prose-${scheme}.png`, { animations: 'disabled' });
  });
}

test('long lines, URLs and wide tables never widen the message column', async ({ page }) => {
  for (const width of ['thread', 'message'] as const) {
    await openLab(page, 'prose', 'light', width);
    const r = await page.evaluate(() => {
      const c = document.querySelector<HTMLElement>('[data-testid=lab-canvas]')!;
      const blocks = [...c.querySelectorAll<HTMLElement>('[data-block]')];
      return { canvas: c.clientWidth, scroll: c.scrollWidth, widest: Math.max(...blocks.map((b) => b.getBoundingClientRect().width)) };
    });
    // Frame corners (+) sit centred on the frame's edge, 8 px outside it by design.
    expect(r.scroll).toBeLessThanOrEqual(r.canvas + 8);
    expect(r.widest).toBeLessThanOrEqual(r.canvas);
  }
});
