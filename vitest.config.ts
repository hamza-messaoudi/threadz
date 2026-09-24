import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    globalSetup: ['test/global-setup.ts'],
    env: { TZ: 'Europe/Madrid' },
    testTimeout: 20000,
  },
});
