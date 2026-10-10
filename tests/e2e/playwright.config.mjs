// Playwright config for the /v2 in-browser FFmpeg editor (local, no live site, no API keys).
// Two projects: "mt" (cross-origin isolated -> @ffmpeg/core-mt) and "st" (no COOP/COEP ->
// single-thread @ffmpeg/core fallback). Each gets its own static server.
import { defineConfig } from '@playwright/test';

const MT_PORT = Number(process.env.E2E_MT_PORT || 4173);
const ST_PORT = Number(process.env.E2E_ST_PORT || 4175);
const chromeExecutable = process.env.E2E_CHROME_PATH || undefined; // e.g. /usr/bin/google-chrome

// E2E_BASE_URL=https://grepawk.com runs the same specs against a deployed site instead of local
// servers: "prod-mt" (auto -> mt) and "prod-st" (?wasm=st forces the single-thread core on the same
// isolated page). Read-only: GET/HEAD only, every non-GET is blocked by the guard.
const PROD = process.env.E2E_BASE_URL;
const localProjects = [
  { name: 'mt', use: { baseURL: `http://127.0.0.1:${MT_PORT}` }, metadata: { expectedMode: 'mt', isolated: true } },
  { name: 'st', use: { baseURL: `http://127.0.0.1:${ST_PORT}` }, metadata: { expectedMode: 'st', isolated: false } },
];
const prodProjects = PROD && [
  { name: 'prod-mt', use: { baseURL: PROD }, metadata: { expectedMode: 'mt', isolated: true, query: '' } },
  { name: 'prod-st', use: { baseURL: PROD }, metadata: { expectedMode: 'st', isolated: true, query: '?wasm=st' } },
];

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.pw\.mjs$/,
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
  projects: prodProjects || localProjects,
  webServer: PROD ? [] : [
    { command: 'node server.mjs', cwd: '.', port: MT_PORT, env: { PORT: String(MT_PORT), ISOLATE: '1' }, reuseExistingServer: false },
    { command: 'node server.mjs', cwd: '.', port: ST_PORT, env: { PORT: String(ST_PORT), ISOLATE: '0' }, reuseExistingServer: false },
  ],
});
