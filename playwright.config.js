import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright',
  timeout: 300_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.FINALCUT_LIVE_BASE_URL || 'https://grepawk.com',
  },
});
