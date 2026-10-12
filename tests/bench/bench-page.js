// Runs inside the bench page (served by wasm-bench.mjs with COOP/COEP). Exposes
// window.bench.run(opts) which loads one core (st|mt) and runs the op list, returning one row per op.
import { FFmpeg } from '/node_modules/@ffmpeg/ffmpeg/dist/esm/index.js';

const CORE = (mode) => {
  const base = `${location.origin}/node_modules/@ffmpeg/${mode === 'mt' ? 'core-mt' : 'core'}/dist/esm/`;
  return { coreURL: `${base}ffmpeg-core.js`, wasmURL: `${base}ffmpeg-core.wasm`, ...(mode === 'mt' ? { workerURL: `${base}ffmpeg-core.worker.js` } : {}) };
};
const fixture = async (name) => {
  const r = await fetch(`/fixtures/${name}`);
  if (!r.ok) throw new Error(`fixture ${name}: ${r.status}`);
  return new File([await r.blob()], name);
};

// Peak memory while `promise` runs. measureUserAgentSpecificMemory needs crossOriginIsolated and
// is Chromium-only; elsewhere the column is null.
function sampleMemory(promise) {
  if (typeof performance.measureUserAgentSpecificMemory !== 'function' || !crossOriginIsolated) return promise.then(v => ({ v, peak: null, peakCtx: null }));
  // `peak` is the API's total. With the mt core every pthread worker reports the same shared
  // wasm heap, so the total is ~(pool+2) x heap; `peakCtx` (largest single breakdown entry,
  // i.e. one context's view including the shared heap once) is the comparable number.
  let done = false, peak = 0, peakCtx = 0;
  const loop = (async () => {
    while (!done) {
      try {
        const m = await performance.measureUserAgentSpecificMemory();
        peak = Math.max(peak, m.bytes);
        for (const b of m.breakdown || []) peakCtx = Math.max(peakCtx, b.bytes);
      } catch { break; }
      await new Promise(r => setTimeout(r, 250));
    }
  })();
  return promise.finally(() => { done = true; }).then(async v => { await Promise.race([loop, new Promise(r => setTimeout(r, 3000))]); return { v, peak, peakCtx }; });
}

class Session {
  constructor(mode) { this.mode = mode; this.ff = null; this.log = []; this.job = 0; }
  async load() {
    const t0 = performance.now();
    this.ff = new FFmpeg();
    this.ff.on('log', ({ message }) => { this.log.push(message); if (this.log.length > 60) this.log.shift(); });
    await this.ff.load(CORE(this.mode));
    return Math.round(performance.now() - t0);
  }
  terminate() { try { this.ff?.terminate(); } catch {} this.ff = null; }
  // One exec with WORKERFS-mounted inputs (as ffmpegHost does). Returns a result row.
  async exec({ inputs = [], files = [], argv, out, probe = false, timeoutMs }) {
    const ff = this.ff, id = ++this.job, inDir = `/in${id}`, dir = `/w${id}`;
    await ff.createDir(inDir); await ff.createDir(dir);
    if (inputs.length) await ff.mount('WORKERFS', { files: inputs }, inDir);
    for (const f of files) await ff.writeFile(`${dir}/${f.name}`, new Uint8Array(await f.arrayBuffer()));
    const ctx = { in: inputs.map(f => `${inDir}/${f.name}`), dir, out: `${dir}/${out}` };
    const args = argv(ctx);
    this.log = [];
    const t0 = performance.now();
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`timeout ${timeoutMs} ms`), { hang: true })), timeoutMs); });
    const call = probe ? ff.ffprobe(args) : ff.exec(args);
    call.catch(() => {});
    try {
      const { v: code, peak, peakCtx } = await sampleMemory(Promise.race([call, timeout]));
      const execMs = Math.round(performance.now() - t0);
      let bytes = 0;
      try { bytes = (await ff.readFile(ctx.out)).length; } catch {}
      // Core 0.12.10 logs "Aborted()" at the end of every run (its exit path), so like
      // ffmpegHost only a non-zero exit plus Aborted() counts as a crash. ffprobe exits -1 even
      // on success (known bug), so for ffprobe the report decides.
      const aborted = this.log.some(l => /Aborted\(/.test(l));
      const okExit = probe || code === 0;
      const status = okExit && bytes > 0 ? 'ok' : (aborted ? 'crash' : 'fail');
      if (inputs.length) await ff.unmount(inDir).catch(() => {});
      await ff.deleteFile(ctx.out).catch(() => {});
      return { status, exitCode: code, execMs, peakMemBytes: peak || null, peakCtxBytes: peakCtx || null, outBytes: bytes, logTail: status === 'ok' ? undefined : this.log.slice(-6) };
    } catch (e) {
      const execMs = Math.round(performance.now() - t0);
      this.terminate();
      return { status: e.hang ? 'hang' : 'crash', execMs, error: String(e.message || e), logTail: this.log.slice(-6) };
    } finally { clearTimeout(timer); }
  }
}

const T = (mode) => (mode === 'mt' ? ['-threads', '4'] : []); // ffmpegHost's MAX_MT_THREADS
const OPS = {
  trim_copy: async () => ({ inputs: [await fixture('src-1080p-60s.mp4')], out: 'out.mp4', timeoutMs: 120e3,
    argv: c => ['-ss', '10', '-i', c.in[0], '-t', '20', '-c', 'copy', c.out] }),
  x264_veryfast: async (m) => ({ inputs: [await fixture('src-1080p-60s.mp4')], out: 'out.mp4', timeoutMs: 300e3,
    argv: c => ['-i', c.in[0], '-t', '10', '-c:v', 'libx264', '-preset', 'veryfast', ...T(m), '-c:a', 'aac', c.out] }),
  // mt only, not in the default op list: x264 picks its own thread count (hangs on core-mt 0.12.10).
  x264_auto_threads: async () => ({ inputs: [await fixture('src-1080p-60s.mp4')], out: 'out.mp4', timeoutMs: 300e3,
    argv: c => ['-i', c.in[0], '-t', '10', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', c.out] }),
  xfade_join3: async (m) => ({ inputs: [await fixture('clip1-720p-5s.mp4'), await fixture('clip2-720p-5s.mp4'), await fixture('clip3-720p-5s.mp4')], out: 'out.mp4', timeoutMs: 300e3,
    argv: c => ['-i', c.in[0], '-i', c.in[1], '-i', c.in[2], '-filter_complex',
      '[0:v][1:v]xfade=transition=fade:duration=1:offset=4[v01];[v01][2:v]xfade=transition=fade:duration=1:offset=8[v];[0:a][1:a]acrossfade=d=1[a01];[a01][2:a]acrossfade=d=1[a]',
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', ...T(m), '-c:a', 'aac', c.out] }),
  burn_ass: async (m) => ({ inputs: [await fixture('src-720p-10s.mp4')], files: [await fixture('subs.ass'), await fixture('DejaVuSans.ttf')], out: 'out.mp4', timeoutMs: 300e3,
    argv: c => ['-i', c.in[0], '-vf', `subtitles=${c.dir}/subs.ass:fontsdir=${c.dir}`, '-c:v', 'libx264', '-preset', 'veryfast', ...T(m), '-c:a', 'copy', c.out] }),
  loudnorm: async () => ({ inputs: [await fixture('src-1080p-60s.mp4')], out: 'out.m4a', timeoutMs: 600e3,
    argv: c => ['-i', c.in[0], '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', c.out] }),
  thumbnail: async () => ({ inputs: [await fixture('src-1080p-60s.mp4')], out: 'thumb.jpg', timeoutMs: 120e3,
    argv: c => ['-ss', '30', '-i', c.in[0], '-frames:v', '1', '-vf', 'scale=320:-2', c.out] }),
  ffprobe: async () => ({ inputs: [await fixture('src-1080p-60s.mp4')], out: 'probe.json', timeoutMs: 60e3, probe: true,
    argv: c => ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', c.in[0], '-o', c.out] }),
};

async function soak(s, runs, mode) {
  const f = await fixture('soak-240p-2s.mp4');
  const rows = [];
  for (let i = 1; i <= runs; i++) {
    const r = await s.exec({ inputs: [f], out: 'out.mp4', timeoutMs: 60e3,
      argv: c => ['-i', c.in[0], '-af', 'vibrato=f=7:d=0.5', '-c:v', 'libx264', '-preset', 'ultrafast', ...T(mode), '-c:a', 'aac', c.out] });
    rows.push({ run: i, ...r });
    if (r.status !== 'ok') break; // the worker is gone or unreliable; report where it broke
  }
  const ok = rows.filter(r => r.status === 'ok');
  const firstBad = rows.find(r => r.status !== 'ok');
  return { status: firstBad ? firstBad.status : 'ok', runsOk: ok.length, runs, firstFailure: firstBad ? { run: firstBad.run, status: firstBad.status, error: firstBad.error, logTail: firstBad.logTail } : null,
    execMs: rows.reduce((a, r) => a + (r.execMs || 0), 0), medianRunMs: ok.length ? ok.map(r => r.execMs).sort((a, b) => a - b)[ok.length >> 1] : null,
    peakMemBytes: Math.max(0, ...rows.map(r => r.peakMemBytes || 0)) || null, peakCtxBytes: Math.max(0, ...rows.map(r => r.peakCtxBytes || 0)) || null };
}

window.bench = {
  env: () => ({ ua: navigator.userAgent, crossOriginIsolated, cores: navigator.hardwareConcurrency, memApi: typeof performance.measureUserAgentSpecificMemory === 'function' }),
  async run({ mode, ops, soakRuns = 60 }) {
    const rows = [];
    const s = new Session(mode);
    let loadMs;
    try { loadMs = await s.load(); } catch (e) { return [{ op: 'load', status: 'crash', error: String(e.message || e) }]; }
    for (const op of ops) {
      if (!s.ff) { try { loadMs = await s.load(); } catch (e) { rows.push({ op, status: 'crash', error: 'reload failed: ' + e }); continue; } }
      try {
        if (op === 'soak60') {
          // Soak gets its own fresh worker so earlier ops don't count towards it.
          s.terminate(); const l = await s.load();
          rows.push({ op, loadMs: l, ...(await soak(s, soakRuns, mode)) });
        } else {
          rows.push({ op, loadMs, ...(await s.exec(await OPS[op](mode))) });
        }
      } catch (e) { rows.push({ op, status: 'crash', error: String(e.message || e) }); s.terminate(); }
    }
    s.terminate();
    return rows;
  },
};
window.benchReady = true;
