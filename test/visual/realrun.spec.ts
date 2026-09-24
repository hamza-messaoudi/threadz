import { expect, test } from '@playwright/test';
import { openLab } from './lab.ts';

// Replies from real `claude -p --model sonnet` runs with the catalog appended (Phase 7, NOTES.md).
// Each must render with no fallback, error or empty frame.
const CASES = [
  { fixture: 'realrun-prs', figures: '.md-body figure.graph-frame:not(.md-code)', min: 1, max: 2 },
  { fixture: 'realrun-login', figures: '.md-mermaid[data-state=ready]', min: 1, max: 1 },
  { fixture: 'realrun-deploy', figures: '.md-body figure', min: 1, max: 1 },
];

for (const c of CASES) {
  test(`${c.fixture} renders cleanly`, async ({ page }) => {
    await openLab(page, c.fixture, 'light');
    await expect(page.locator(c.figures).first()).toBeVisible({ timeout: 15000 });
    const n = await page.locator(c.figures).count();
    expect(n).toBeGreaterThanOrEqual(c.min);
    expect(n).toBeLessThanOrEqual(c.max);
    await expect(page.locator('.md-unknown, [data-error], .md-mermaid[data-state=error]')).toHaveCount(0);
    expect(await page.getByText('· · ·').count()).toBe(0);
    expect(await page.locator('.md-body p').count()).toBeGreaterThan(0); // prose alongside the figure
  });
}

test('the three-step process uses graph-flow, the sequence uses Mermaid', async ({ page }) => {
  await openLab(page, 'realrun-deploy', 'light');
  await expect(page.locator('.md-mermaid')).toHaveCount(0);
  await expect(page.locator('figure').filter({ hasText: 'Deploy pipeline' })).toBeVisible();
  await openLab(page, 'realrun-login', 'light');
  await expect(page.locator('.md-mermaid')).toHaveCount(1);
});
