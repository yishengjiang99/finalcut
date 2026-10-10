// Playwright config for the /v2 in-browser FFmpeg editor (local, no live site, no API keys).
// Two projects: "mt" (cross-origin isolated -> @ffmpeg/core-mt) and "st" (no COOP/COEP ->
// single-thread @ffmpeg/core fallback). Each gets its own static server.
import { defineConfig } from '@playwright/test';

const MT_PORT = Number(process.env.E2E_MT_PORT || 4173);
const ST_PORT = Number(process.env.E2E_ST_PORT || 4175);
const chromeExecutable = process.env.E2E_CHROME_PATH || undefined; // e.g. /usr/bin/google-chrome

// E2E_BASE_URL=https://grepawk.com used to run the same specs against the deployed /v2 editor.
// The /v2 page is retired (it redirects to the main app at /); prod is now covered by
// tests/e2e/check-v2-headers.sh (redirect, cores, source) and the contract gate, so there are
// no prod projects anymore. These specs run against local throwaway servers only.
const localProjects = [
  { name: 'mt', use: { baseURL: `http://127.0.0.1:${MT_PORT}` }, metadata: { expectedMode: 'mt', isolated: true } },
  { name: 'st', use: { baseURL: `http://127.0.0.1:${ST_PORT}` }, metadata: { expectedMode: 'st', isolated: false } },
];

export default defineConfig({
  testDir: '.',
  testMatch: /v2-.*\.pw\.mjs$/, // main-app specs (main-*.pw.mjs) have their own config (vite dev server)
  timeout: 180_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['json', { outputFile: '../../test-results/e2e-v2/results.json' }]],
  outputDir: '../../test-results/e2e-v2/artifacts',
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    launchOptions: chromeExecutable ? { executablePath: chromeExecutable } : {},
  },
  projects: localProjects,
  webServer: [
    { command: 'node server.mjs', cwd: '.', port: MT_PORT, env: { PORT: String(MT_PORT), ISOLATE: '1' }, reuseExistingServer: false },
    { command: 'node server.mjs', cwd: '.', port: ST_PORT, env: { PORT: String(ST_PORT), ISOLATE: '0' }, reuseExistingServer: false },
  ],
});
