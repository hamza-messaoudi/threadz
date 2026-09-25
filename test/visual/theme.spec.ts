import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const TOKEN = 'a'.repeat(48);

test('theme toggle switches .dark and the markdown tokens', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`/settings?t=${TOKEN}`);
  const sample = page.getByTestId('theme-sample');
  await sample.waitFor();
  const style = () => sample.evaluate((el) => ({ color: getComputedStyle(el).color, line: getComputedStyle(el).textDecorationLine }));
  const light = await style();
  expect(light.line).toBe('none');

  await page.getByRole('tab', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  const dark = await style();
  expect(dark.color).not.toBe(light.color);
  expect(dark.line).toBe('underline');

  // Survives a reload, and "System" follows the OS again.
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('tab', { name: 'System', exact: true }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('build keeps only the utilities in use', () => {
  const dir = path.join('web', 'dist', 'assets');
  const css = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  expect(css).toContain('.font-mono');
  for (const unused of ['.p-96', '.bg-red-500', '.text-9xl', '.grid-cols-12']) expect(css).not.toContain(unused);
});
