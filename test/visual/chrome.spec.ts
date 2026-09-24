import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The app chrome around messages. Markdown output is masked, so this stays valid while the renderer changes.
const seeded = () => JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'ac-visual-4799.json'), 'utf8'));

for (const scheme of ['light', 'dark'] as const) {
  test(`chrome ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.clock.setFixedTime(new Date(Date.UTC(2026, 8, 24, 11, 0)));
    const { conversationId, threadId } = seeded();
    await page.goto(`/c/${conversationId}?thread=${threadId}&t=${'a'.repeat(48)}`);
    await page.locator('.thread-panel .msg').first().waitFor();
    await page.locator('.msg-body').first().waitFor();
    await page.locator('.md-shiki').first().waitFor();
    const mask = [page.locator('.msg-body'), page.locator('.quote .md'), page.locator('.quote > :last-child')];
    await expect(page).toHaveScreenshot(`chrome-${scheme}.png`, { mask, animations: 'disabled' });
  });
}
