// Ad-hoc screenshot of the seeded harness: tsx test/visual/shot.ts <out.png> [light|dark] [width] [--thread]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [out = 'shot.png', scheme = 'light', width = '1280'] = process.argv.slice(2);
const { conversationId, threadId } = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'ac-visual-4799.json'), 'utf8'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: 900 }, colorScheme: scheme as 'light' | 'dark' });
const thread = process.argv.includes('--thread') ? `thread=${threadId}&` : '';
await page.goto(`http://127.0.0.1:4799/c/${conversationId}?${thread}t=${'a'.repeat(48)}`);
await page.locator('.msg-body').first().waitFor();
await page.waitForTimeout(800);
// Unroll the scroll container so the full conversation fits one image.
await page.addStyleTag({ content: '.app{height:auto!important} .messages-scroll{overflow:visible!important;height:auto!important} html,body,#root{height:auto!important}' });
await page.waitForTimeout(300);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
