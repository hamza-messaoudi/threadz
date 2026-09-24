import { expect, test } from '@playwright/test';
import { openLab } from './lab.ts';

// Baselines in __screenshots__/figures.spec.ts are crops of the demo itself (atinux/comark-graphs-demo,
// reduced motion, 1280 px, captured in Phase 5), so each figure is compared with the demo's rendering.
// Skipped: the two live clocks at the end of the catalog, and catalog figure 10 (graph-cells), whose
// `@min-[28rem]:flex-row` queries the nearest container: the demo has none, so its shards stack; the
// message column is a container here, so they sit in a row as mdxcn intends (see NOTES.md).
const PAGES = { report: 12, catalog: 18 } as const;
const SKIP = new Set(['catalog-10']);

for (const [fixture, count] of Object.entries(PAGES)) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${fixture} figures match the demo (${scheme})`, async ({ page }) => {
      await openLab(page, fixture, scheme, 'demo');
      const figs = page.locator('[data-testid=lab-canvas] .md-body figure');
      await expect(figs.nth(count - 1)).toBeVisible();
      for (let i = 0; i < count; i++) {
        if (SKIP.has(`${fixture}-${String(i).padStart(2, '0')}`)) continue;
        await expect.soft(figs.nth(i)).toHaveScreenshot(`${fixture}-${String(i).padStart(2, '0')}-${scheme}.png`, {
          animations: 'disabled',
          maxDiffPixels: Number.MAX_SAFE_INTEGER, // the config default is 0; the ratio decides here
          maxDiffPixelRatio: 0.03,
        });
      }
    });
  }
}

// Regression snapshots of the whole lab page at the message column width (clocks masked).
for (const fixture of ['catalog', 'report']) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${fixture} lab snapshot (${scheme})`, async ({ page }) => {
      await openLab(page, fixture, scheme);
      const clocks = page.locator('.md-body figure').filter({ hasText: /Uptime|Flag removal/ });
      await expect(page.getByTestId('lab-canvas')).toHaveScreenshot(`${fixture}-lab-${scheme}.png`, { animations: 'disabled', mask: [clocks] });
    });
  }
}
