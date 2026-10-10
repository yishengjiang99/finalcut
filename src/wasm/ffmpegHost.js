// ffmpeg.wasm host for the /v2 editor. Self-hosted cores only (no CDN, no toBlobURL).
// Picks the multithreaded core when the page is crossOriginIsolated, otherwise the
// single-thread core, and falls back to single-thread if the mt core fails to load.
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

export const CORE_VERSION = '0.12.10';
export const MAX_MT_THREADS = 4;
// Wall-clock watchdog. ffmpeg's own exec timeout does not fire when the mt core deadlocks,
// so the host terminates the worker (and reloads on the next job) instead.
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const CORE_ROOT = '/v2/ffmpeg-core';

export function coreUrls(mode, root = CORE_ROOT) {
  const base = new URL(`${root}/${mode}/${CORE_VERSION}/`, self.location.href).href;
  return {
    coreURL: `${base}ffmpeg-core.js`,
    wasmURL: `${base}ffmpeg-core.wasm`,
    ...(mode === 'mt' ? { workerURL: `${base}ffmpeg-core.worker.js` } : {}),
  };
}

/** Decide mt vs st. `override` comes from ?wasm=mt|st (debugging). */
export function pickMode({ override, isolated = self.crossOriginIsolated, sab = typeof SharedArrayBuffer === 'function', cores = navigator.hardwareConcurrency ?? 1 } = {}) {
  if (override === 'st') return 'st';
  const canMT = isolated === true && sab && cores > 1;
  if (override === 'mt' && !canMT) return 'st'; // mt is impossible without isolation
  return canMT ? 'mt' : 'st';
}

export class FFmpegHost {
  constructor({ override, onLog, onProgress } = {}) {
    this.override = override;
    this.onLog = onLog;
    this.onProgress = onProgress;
    this.ffmpeg = null;
    this.mode = null;
    this.loadMs = null;
    this.fallbackReason = null;
    this._loading = null;
    this._job = 0;
  }

  get threads() {
    // Encoder thread cap for the mt core. Measured on @ffmpeg/core-mt 0.12.10 (headless Chrome,
    // 8 cores): libx264 with no -threads (auto) or -threads 8 hangs forever, -threads 6 aborts,
    // -threads <= 4 works. The x264 in this build is ffmpegwasm's "4-cores" branch.
    return this.mode === 'mt' ? Math.max(1, Math.min(navigator.hardwareConcurrency || 2, MAX_MT_THREADS)) : undefined;
  }

  load() {
    if (!this._loading) this._loading = this._load().catch((e) => { this._loading = null; throw e; });
    return this._loading;
  }

  async _loadMode(mode) {
    const ff = new FFmpeg();
    if (this.onLog) ff.on('log', this.onLog);
    if (this.onProgress) ff.on('progress', this.onProgress);
    await ff.load(coreUrls(mode));
    return ff;
  }

  async _load() {
    const t0 = performance.now();
    let mode = pickMode({ override: this.override });
    try {
      this.ffmpeg = await this._loadMode(mode);
    } catch (err) {
      if (mode !== 'mt') throw err;
      // e.g. iOS refusing the fixed 1 GB mt heap.
      this.fallbackReason = String(err?.message || err);
      console.warn('[ffmpegHost] mt core failed, falling back to st:', this.fallbackReason);
      mode = 'st';
      this.ffmpeg = await this._loadMode(mode);
    }
    this.mode = mode;
    this.loadMs = Math.round(performance.now() - t0);
    console.info('[ffmpegHost]', { mode, crossOriginIsolated: self.crossOriginIsolated, cores: navigator.hardwareConcurrency, loadMs: this.loadMs });
    return { mode, loadMs: this.loadMs };
  }

  /**
   * Run one job: mount the input File read-only (WORKERFS, no heap copy), exec, read the single
   * output, then clean up. Returns { data: Uint8Array, execMs, exitCode }.
   */
  async run(file, buildArgv, { outName = 'out.mp4', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    await this.load();
    const ff = this.ffmpeg;
    const id = ++this._job;
    const inDir = `/in${id}`;
    const outDir = `/out${id}`;
    const inName = sanitizeName(file.name || 'input.mp4');
    let mounted = false;
    await ff.createDir(inDir);
    await ff.createDir(outDir);
    try {
      try {
        await ff.mount('WORKERFS', { files: [file] }, inDir);
        mounted = true;
      } catch (err) {
        console.warn('[ffmpegHost] WORKERFS mount failed, copying into MEMFS:', err);
        await ff.writeFile(`${inDir}/${inName}`, await fetchFile(file));
      }
      const input = `${inDir}/${mounted ? file.name : inName}`;
      const output = `${outDir}/${outName}`;
      const argv = buildArgv({ input, output, threads: this.threads });
      const t0 = performance.now();
      let timer;
      const watchdog = new Promise((_, reject) => {
        timer = setTimeout(() => {
          this.terminate();
          reject(Object.assign(new Error(`ffmpeg timed out after ${timeoutMs} ms`), { code: 'wasm_timeout' }));
        }, timeoutMs);
      });
      let exitCode;
      try {
        exitCode = await Promise.race([ff.exec(argv), watchdog]);
      } finally {
        clearTimeout(timer);
      }
      const execMs = Math.round(performance.now() - t0);
      if (exitCode !== 0) throw Object.assign(new Error(`ffmpeg exited with ${exitCode}`), { code: 'wasm_exec_failed', exitCode });
      const data = await ff.readFile(output);
      await ff.deleteFile(output).catch(() => {});
      return { data, execMs, exitCode, argv };
    } finally {
      // Skip cleanup if the worker was terminated (timeout/cancel): its FS is gone.
      if (this.ffmpeg === ff) {
        if (mounted) await ff.unmount(inDir).catch(() => {});
        else await ff.deleteFile(`${inDir}/${inName}`).catch(() => {});
        await ff.deleteDir(inDir).catch(() => {});
        await ff.deleteDir(outDir).catch(() => {});
      }
    }
  }

  terminate() {
    this.ffmpeg?.terminate();
    this.ffmpeg = null;
    this._loading = null;
  }
}

function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'input.mp4';
}
