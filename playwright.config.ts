import { defineConfig } from '@playwright/test';

// Visual checks against a seeded, isolated server (test/visual/harness.ts). Run `npm run test:visual`.
export default defineConfig({
  testDir: 'test/visual',
  testMatch: /.*\.spec\.ts/,
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  expect: { toHaveScreenshot: { maxDiffPixels: 0 } },
  use: { baseURL: 'http://127.0.0.1:4799', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' },
  webServer: {
    command: 'tsx test/visual/harness.ts',
    url: 'http://127.0.0.1:4799/api/health',
    reuseExistingServer: false,
    env: { VISUAL_FIXTURES: process.env.VISUAL_FIXTURES ?? '', VISUAL_BULK: process.env.VISUAL_BULK ?? '' },
  },
});
