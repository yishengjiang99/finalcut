// /v2 spike: open a local file, trim it in ffmpeg.wasm, preview + download. No media upload.
import { FFmpegHost } from '../src/wasm/ffmpegHost.js';
import { buildTrimArgs } from '../src/wasm/ops/trim.js';
import { checkClip } from '../src/wasm/clipLimits.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const override = params.get('wasm'); // ?wasm=st|mt for debugging
const state = { file: null, duration: NaN, height: NaN, outUrl: null, inUrl: null };
// Test/debug hook (console only; nothing is reported to a server).
const report = (window.__v2 = { ready: false, crossOriginIsolated: self.crossOriginIsolated });

const host = new FFmpegHost({
  override,
  onProgress: ({ progress }) => setStatus(`Trimming… ${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`),
});

function setStatus(text) {
  $('status').textContent = text;
}

function videoMeta(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => reject(new Error('could not read media metadata'));
    v.src = url;
  });
}

// ?debug=1 exposes the engine for local experiments (console only).
if (params.get('debug') === '1') report.host = host;

$('file').addEventListener('change', async () => {
  const file = $('file').files?.[0];
  if (!file) return;
  if (state.inUrl) URL.revokeObjectURL(state.inUrl);
  state.file = file;
  state.inUrl = URL.createObjectURL(file);
  $('inputPreview').src = state.inUrl;
  let meta = { duration: NaN, height: NaN };
  try { meta = await videoMeta(state.inUrl); } catch (e) { console.warn(e); }
  state.duration = meta.duration;
  state.height = meta.height;
  const verdict = checkClip({ bytes: file.size, durationSec: meta.duration, height: meta.height });
  $('clipNotice').className = verdict.level;
  $('clipNotice').textContent = verdict.reasons.join(' ');
  $('trim').disabled = verdict.level === 'block';
  if (Number.isFinite(meta.duration)) $('end').value = String(Math.min(+$('end').value || 1, +meta.duration.toFixed(1)));
  report.input = { bytes: file.size, ...meta, clip: verdict.level };
  // Warm the engine in the background so the first edit is quicker.
  host.load().then(({ mode, loadMs }) => {
    report.mode = mode; report.loadMs = loadMs; report.fallbackReason = host.fallbackReason;
    setStatus(`Engine: ${mode} core loaded in ${loadMs} ms (crossOriginIsolated=${self.crossOriginIsolated})`);
  }).catch((e) => { report.error = String(e?.message || e); setStatus(`Engine failed to load: ${report.error}`); });
  report.ready = true;
});

$('trim').addEventListener('click', async () => {
  if (!state.file) return;
  const args = { start: +$('start').value, end: +$('end').value, precise: $('precise').checked };
  $('trim').disabled = true;
  report.trim = null;
  try {
    setStatus('Loading engine…');
    await host.load();
    report.mode = host.mode; report.loadMs = host.loadMs;
    setStatus('Trimming…');
    const { data, execMs, argv } = await host.run(state.file, (io) => buildTrimArgs(args, { ...io, duration: state.duration }));
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    if (state.outUrl) URL.revokeObjectURL(state.outUrl);
    state.outUrl = URL.createObjectURL(blob);
    $('output').src = state.outUrl;
    $('download').href = state.outUrl;
    $('download').hidden = false;
    const meta = await videoMeta(state.outUrl).catch(() => ({ duration: NaN }));
    report.trim = { execMs, bytes: blob.size, duration: meta.duration, argv };
    setStatus(`Engine: ${host.mode} (load ${host.loadMs} ms). Trim ${args.start}–${args.end}s done in ${execMs} ms → ${(blob.size / 1024).toFixed(0)} KB, ${meta.duration?.toFixed?.(2)} s`);
  } catch (e) {
    report.trim = { error: String(e?.message || e), code: e?.code };
    setStatus(`Trim failed: ${report.trim.error}`);
  } finally {
    $('trim').disabled = false;
  }
});
