// Local scratch: run raw ffmpeg argv in the wasm core through the host (not part of the suite).
import { chromium } from '@playwright/test';
const cmds = JSON.parse(process.env.CMDS);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => { if (m.text().startsWith('[t]')) console.log(m.text().slice(0, 900)); });
await page.goto(`http://localhost:${process.env.PORT || 5211}/legal/terms.html`);
const fixture = '/@fs' + process.cwd() + '/tests/e2e/fixtures/testclip-6s.mp4';
await page.evaluate(async ({ fixture, cmds, wasm }) => {
  const { FFmpegHost } = await import('/src/wasm/ffmpegHost.js');
  const host = new FFmpegHost({ selfHostedWorker: true, override: wasm });
  const file = new File([await (await fetch(fixture)).arrayBuffer()], 'input.mp4', { type: 'video/mp4' });
  for (const [out, ...args] of cmds) {
    const t0 = performance.now();
    try {
      const r = await host.runJob({ inputs: [file], outName: out, timeoutMs: 25000, buildArgv: ({ inputs, output, threads }) => ['-hide_banner', '-nostdin', '-y', '-i', inputs[0], ...args.map(a => (a === 'THREADS' ? String(threads || 1) : a)), output] });
      console.log(`[t] OK ${out} ${args.join(' ')} -> ${r.data.length}b ${Math.round(performance.now() - t0)}ms (${host.mode})`);
    } catch (e) {
      console.log(`[t] FAIL ${out} ${args.join(' ')} -> ${e.message} ${String(e.stderr || '').split('\n').slice(-3).join(' | ')}`);
    }
  }
}, { fixture, cmds, wasm: process.env.WASM || null });
await browser.close();
