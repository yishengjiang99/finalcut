// ffmpeg.wasm host. Self-hosted cores only (no CDN, no toBlobURL).
// Picks the multithreaded core when the page is crossOriginIsolated, otherwise the
// single-thread core, and falls back to single-thread if the mt core fails to load.
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

export const CORE_VERSION = '0.12.10';
export const FFMPEG_JS_VERSION = '0.12.15';
export const MAX_MT_THREADS = 4;
// Wall-clock watchdog. ffmpeg's own exec timeout does not fire when the mt core deadlocks,
// so the host terminates the worker (and reloads on the next job) instead.
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const CORE_ROOT = '/v2/ffmpeg-core';
const LOG_TAIL_LINES = 40;
// One worker is reused for this many ffmpeg/ffprobe runs, then replaced. Measured on core-mt
// 0.12.10: after a few dozen runs in the same worker a job can hang (the 44th job, an OGG encode,
// never returned) and filters that read uninitialised memory start to fail (vibrato produced NaN
// samples on the 29th job); both work in a fresh worker. Reloading a cached core takes well under
// a second.
export const RECYCLE_AFTER_RUNS = 12;

export function coreUrls(mode, root = CORE_ROOT) {
  const base = new URL(`${root}/${mode}/${CORE_VERSION}/`, self.location.href).href;
  return {
    coreURL: `${base}ffmpeg-core.js`,
    wasmURL: `${base}ffmpeg-core.wasm`,
    ...(mode === 'mt' ? { workerURL: `${base}ffmpeg-core.worker.js` } : {}),
  };
}

/**
 * The @ffmpeg/ffmpeg class worker, self-hosted next to the cores so it is served with the
 * isolation headers (a worker script without COEP is refused by an isolated page in Firefox).
 */
export function classWorkerUrl(root = CORE_ROOT) {
  return new URL(`${root}/ffmpeg/${FFMPEG_JS_VERSION}/worker.js`, self.location.href).href;
}

/** Decide mt vs st. `override` comes from ?wasm=mt|st (debugging). */
export function pickMode({ override, isolated = self.crossOriginIsolated, sab = typeof SharedArrayBuffer === 'function', cores = navigator.hardwareConcurrency ?? 1 } = {}) {
  if (override === 'st') return 'st';
  const canMT = isolated === true && sab && cores > 1;
  if (override === 'mt' && !canMT) return 'st'; // mt is impossible without isolation
  return canMT ? 'mt' : 'st';
}

export class FFmpegHost {
  /** `selfHostedWorker` loads the class worker from the core path instead of the page bundle. */
  constructor({ override, onLog, onProgress, selfHostedWorker = false } = {}) {
    this.override = override;
    this.onLog = onLog;
    this.onProgress = onProgress;
    this.selfHostedWorker = selfHostedWorker;
    this.ffmpeg = null;
    this.mode = null;
    this.loadMs = null;
    this.fallbackReason = null;
    this._loading = null;
    this._job = 0;
    this._runs = 0;
    this._logTail = [];
  }

  get threads() {
    // Encoder thread cap for the mt core. Measured on @ffmpeg/core-mt 0.12.10 (headless Chrome,
    // 8 cores): libx264 with no -threads (auto) or -threads 8 hangs forever, -threads 6 aborts,
    // -threads <= 4 works. The x264 in this build is ffmpegwasm's "4-cores" branch.
    return this.mode === 'mt' ? Math.max(1, Math.min(navigator.hardwareConcurrency || 2, MAX_MT_THREADS)) : undefined;
  }

  /** Loads the core once; later calls share the same promise. A failed load can be retried. */
  load() {
    if (!this._loading) this._loading = this._load().catch((e) => { this._loading = null; throw e; });
    return this._loading;
  }

  async _loadMode(mode) {
    const ff = new FFmpeg();
    // Keep the last lines of ffmpeg's log so a failed job can say why.
    ff.on('log', ({ message }) => {
      this._logTail.push(message);
      if (this._logTail.length > LOG_TAIL_LINES) this._logTail.shift();
    });
    if (this.onLog) ff.on('log', this.onLog);
    if (this.onProgress) ff.on('progress', this.onProgress);
    await ff.load({ ...coreUrls(mode), ...(this.selfHostedWorker ? { classWorkerURL: classWorkerUrl() } : {}) });
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
  run(file, buildArgv, opts = {}) {
    return this.runJob({ ...opts, inputs: [file], buildArgv: ({ inputs, ...io }) => buildArgv({ ...io, input: inputs[0] }) });
  }

  /**
   * Like run(), for jobs with several inputs and/or small side files (fonts, subtitles).
   * `inputs` are Files mounted read-only; `files` ([{ name, data }]) are written to a MEMFS work
   * dir. buildArgv gets { inputs: string[], output, dir, threads }. `signal` cancels the job.
   */
  async runJob({ inputs = [], files = [], buildArgv, outName = 'out.mp4', timeoutMs = DEFAULT_TIMEOUT_MS, signal, fresh = false } = {}) {
    // `fresh` asks for a worker that has not run anything yet (see RECYCLE_AFTER_RUNS).
    if (fresh && this._runs > 0) this.terminate();
    return this._withFiles(inputs, files, async (ff, { paths, dir }) => {
      const output = `${dir}/${outName}`;
      const argv = buildArgv({ inputs: paths, output, dir, threads: this.threads });
      const t0 = performance.now();
      let exitCode;
      try {
        exitCode = await this._guard(ff, ff.exec(argv), { timeoutMs, signal });
      } catch (error) {
        // A trap inside the core (out-of-bounds access, abort) leaves the worker unusable: the
        // next job would hang. Replace it.
        if (this.ffmpeg === ff) this.terminate();
        throw Object.assign(error, { code: error.code || 'wasm_crashed', stderr: error.stderr || this._logTail.join('\n'), argv });
      }
      const execMs = Math.round(performance.now() - t0);
      if (exitCode !== 0) {
        const stderr = this._logTail.join('\n');
        // "Aborted()" in the log means the runtime aborted; same treatment as a trap.
        if (/Aborted\(/.test(stderr) && this.ffmpeg === ff) this.terminate();
        throw Object.assign(new Error(`ffmpeg exited with ${exitCode}`), { code: 'wasm_exec_failed', exitCode, stderr, argv });
      }
      const data = await ff.readFile(output);
      await ff.deleteFile(output).catch(() => {});
      return { data, execMs, exitCode, argv };
    });
  }

  /** ffprobe one File. Returns the parsed `-show_format -show_streams` JSON. */
  async probe(file, { timeoutMs = 60_000, signal } = {}) {
    return this._withFiles([file], [], async (ff, { paths, dir }) => {
      const out = `${dir}/probe.json`;
      // ffprobe in core 0.12.10 returns -1 even when it wrote a complete report, so the report
      // itself (not the exit code) decides whether the probe worked.
      await this._guard(ff, ff.ffprobe(['-v', 'error', '-show_format', '-show_streams', '-of', 'json', paths[0], '-o', out]), { timeoutMs, signal });
      try {
        const metadata = JSON.parse(await ff.readFile(out, 'utf8'));
        if (!metadata.streams?.length) throw new Error('no streams');
        return metadata;
      } catch {
        throw Object.assign(new Error('Could not read this media file'), { code: 'wasm_probe_failed' });
      } finally {
        await ff.deleteFile(out).catch(() => {});
      }
    });
  }

  /** Run ffmpeg with no input or output file and return its log (e.g. `-filters`). */
  async query(argv, { timeoutMs = 60_000 } = {}) {
    await this.load();
    const lines = [];
    const onLog = ({ message }) => lines.push(message);
    this.ffmpeg.on('log', onLog);
    try {
      await this._guard(this.ffmpeg, this.ffmpeg.exec(argv), { timeoutMs });
    } finally {
      this.ffmpeg?.off('log', onLog);
    }
    return lines;
  }

  // Race a worker call against the wall-clock watchdog and the cancel signal. Either one
  // terminates the worker (the next job reloads it).
  async _guard(ff, promise, { timeoutMs, signal }) {
    let timer;
    let onAbort;
    const stop = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // Reject first: terminating also rejects the worker call, with a less useful error.
        reject(Object.assign(new Error(`ffmpeg timed out after ${timeoutMs} ms`), { code: 'wasm_timeout' }));
        if (this.ffmpeg === ff) this.terminate();
      }, timeoutMs);
      onAbort = () => {
        reject(Object.assign(new Error('Job cancelled'), { code: 'cancelled', name: 'AbortError' }));
        if (this.ffmpeg === ff) this.terminate();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    // The worker promise is abandoned when the watchdog wins; its late rejection is expected.
    promise.catch(() => {});
    try {
      this._logTail = [];
      return await Promise.race([promise, stop]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async _withFiles(inputs, files, fn) {
    if (this.ffmpeg && this._runs >= RECYCLE_AFTER_RUNS) this.terminate();
    await this.load();
    this._runs += 1;
    const ff = this.ffmpeg;
    const id = ++this._job;
    const inDir = `/in${id}`;
    const dir = `/w${id}`;
    // Unique, shell-safe names (WORKERFS exposes each File under its name).
    const named = inputs.map((f, i) => new File([f], `${i}_${sanitizeName(f.name || 'input.mp4')}`, { type: f.type }));
    const written = [];
    let mounted = false;
    await ff.createDir(inDir);
    await ff.createDir(dir);
    try {
      try {
        if (named.length) await ff.mount('WORKERFS', { files: named }, inDir);
        mounted = named.length > 0;
      } catch (err) {
        console.warn('[ffmpegHost] WORKERFS mount failed, copying into MEMFS:', err);
        for (const f of named) {
          await ff.writeFile(`${inDir}/${f.name}`, await fetchFile(f));
          written.push(`${inDir}/${f.name}`);
        }
      }
      for (const { name, data } of files) {
        // writeFile transfers the buffer to the worker; send a copy so callers can reuse theirs.
        await ff.writeFile(`${dir}/${name}`, typeof data === 'string' ? data : data.slice());
        written.push(`${dir}/${name}`);
      }
      return await fn(ff, { paths: named.map(f => `${inDir}/${f.name}`), dir });
    } finally {
      // Skip cleanup if the worker was terminated (timeout/cancel): its FS is gone.
      if (this.ffmpeg === ff) {
        if (mounted) await ff.unmount(inDir).catch(() => {});
        for (const path of written) await ff.deleteFile(path).catch(() => {});
        await ff.deleteDir(inDir).catch(() => {});
        await ff.deleteDir(dir).catch(() => {});
      }
    }
  }

  terminate() {
    this.ffmpeg?.terminate();
    this.ffmpeg = null;
    this._loading = null;
    this._runs = 0;
  }
}

function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'input.mp4';
}
