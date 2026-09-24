import type { Page } from '@playwright/test';

const TOKEN = 'a'.repeat(48);

/** Opens the style lab (/dev/markdown) on a fixture and waits for fonts. */
export async function openLab(page: Page, fixture: string, scheme: 'light' | 'dark', width = 'message', extra = '') {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`/dev/markdown?fixture=${fixture}&width=${width}${extra}&t=${TOKEN}`);
  await page.locator('[data-testid=lab-canvas] .md-body').waitFor();
  await page.evaluate(() => document.fonts.ready);
}
