import { expect, test } from '@playwright/test';
import { openLab } from './lab.ts';

// WCAG contrast of the markdown text colours against the surface they sit on, in both themes, on the
// message column (chrome background) and on the demo's page colour.
const TEXT = {
  ink: '--foreground',
  accent: '--graph-accent',
  'muted-foreground': '--muted-foreground',
  'graph-muted': '--graph-muted',
} as const;

for (const scheme of ['light', 'dark'] as const) {
  for (const width of ['message', 'demo'] as const) {
    test(`text contrast (${scheme}, ${width} surface)`, async ({ page }) => {
      await openLab(page, 'prose', scheme, width);
      const ratios = await page.evaluate((vars) => {
        const root = document.querySelector('[data-testid=lab-canvas] .md-root')!;
        const cs = getComputedStyle(root);
        const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        const rgb = (css: string) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const bg = lum(rgb(cs.getPropertyValue('--background').trim()));
        const out: Record<string, number> = {};
        for (const [name, v] of Object.entries(vars)) {
          const l = lum(rgb(cs.getPropertyValue(v).trim()));
          out[name] = Math.round(((Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05)) * 100) / 100;
        }
        return out;
      }, TEXT);
      console.log(`contrast ${scheme}/${width}: ${JSON.stringify(ratios)}`);
      expect(ratios.ink).toBeGreaterThanOrEqual(7);
      expect(ratios.accent, 'accent text must pass WCAG AA').toBeGreaterThanOrEqual(4.5);
      expect(ratios['muted-foreground']).toBeGreaterThanOrEqual(4.5);
    });
  }
}
