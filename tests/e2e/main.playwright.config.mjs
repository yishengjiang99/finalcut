// Playwright config for the main-app (/ ) in-browser FFmpeg specs: the engine op matrix
// (main-engine.pw.mjs) and the chat loop (main-chat.pw.mjs). Runs against a vite dev server,
// which serves /src (the engine modules), /v2/ffmpeg-core (the cores) and /fonts with the
// same COOP/COEP isolation headers production sends, so the mt core loads.
// Two projects: "main-mt" (auto -> mt) and "main-st" (?wasm=st forces the single-thread core).
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_MAIN_PORT || 5211);
const chromeExecutable = process.env.E2E_CHROME_PATH || undefined;

export default defineConfig({
  testDir: '.',
  testMatch: /main-.*\.pw\.mjs$/,
  timeout: 600_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['json', { outputFile: '../../test-results/e2e-main/results.json' }]],
  outputDir: '../../test-results/e2e-main/artifacts',
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--no-sandbox'],
      ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
    },
  },
  projects: [
    { name: 'main-mt', use: { baseURL: `http://127.0.0.1:${PORT}` }, metadata: { expectedMode: 'mt', query: '' } },
    { name: 'main-st', use: { baseURL: `http://127.0.0.1:${PORT}` }, metadata: { expectedMode: 'st', query: '?wasm=st' } },
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: '../..',
    port: PORT,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
