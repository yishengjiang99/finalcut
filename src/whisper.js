// On-device speech recognition for captions: Whisper through transformers.js, on WebGPU when the
// browser has it and WebAssembly otherwise. The audio never leaves the browser. The library and
// its runtime are loaded on first use; the model files are downloaded once (from the Hugging Face
// hub) and then kept in the browser cache.
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
// The ONNX runtime is self-hosted next to the FFmpeg cores (isolation headers, application/wasm).
const ORT_ROOT = `/v2/ffmpeg-core/ort/${ORT_VERSION}`;

export const WHISPER_MODELS = {
  webgpu: { id: 'onnx-community/whisper-base', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
  wasm: { id: 'onnx-community/whisper-tiny', dtype: 'q8' },
};
export const SAMPLE_RATE = 16000;

/** Samples (Float32, -1 to 1) of a 16-bit PCM mono WAV, as written by the engine's extractSpeechAudio. */
export function wavToFloat32(wav) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (wav.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const size = view.getUint32(offset + 4, true);
    if (tag(offset) === 'data') {
      const start = offset + 8;
      // FFmpeg writes 0xFFFFFFFF as the size when it could not seek back to patch the header.
      const count = Math.floor(Math.min(size, wav.byteLength - start) / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(start + i * 2, true) / 32768;
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV file has no audio data');
}

const pad = (n, width = 2) => String(n).padStart(width, '0');
function timestamp(seconds, separator) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

/**
 * SRT and VTT from Whisper's chunks ([{ timestamp: [start, end], text }]). Whisper leaves the last
 * end time open when the audio stops mid-phrase; it is closed at `duration`.
 */
export function chunksToCaptions(chunks, duration) {
  const cues = [];
  for (const chunk of chunks || []) {
    const text = String(chunk?.text || '').trim();
    const start = chunk?.timestamp?.[0];
    if (!text || !Number.isFinite(start) || /^\[.*\]$|^\(.*\)$/.test(text)) continue; // "[BLANK_AUDIO]", "(music)"
    const end = Number.isFinite(chunk.timestamp[1]) ? chunk.timestamp[1] : Math.min(start + 5, duration || start + 5);
    if (end > start) cues.push({ start, end, text });
  }
  return {
    srt: cues.map((c, i) => `${i + 1}\n${timestamp(c.start, ',')} --> ${timestamp(c.end, ',')}\n${c.text}`).join('\n\n'),
    vtt: ['WEBVTT', '', ...cues.map(c => `${timestamp(c.start, '.')} --> ${timestamp(c.end, '.')}\n${c.text}`)].join('\n\n').replace('WEBVTT\n\n\n\n', 'WEBVTT\n\n'),
    cues,
  };
}

/** "webgpu" when the browser exposes a usable adapter, otherwise "wasm". */
export async function pickDevice(gpu = globalThis.navigator?.gpu) {
  try {
    return (await gpu?.requestAdapter?.()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

let pipelinePromise = null;
let loadedDevice = null;

async function loadPipeline(onStatus) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  const base = new URL(`${ORT_ROOT}/`, self.location.href).href;
  // Renamed to .js on the server so it is served as JavaScript (nginx has no type for .mjs).
  env.backends.onnx.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.asyncify.js`, wasm: `${base}ort-wasm-simd-threaded.asyncify.wasm` };

  const progress = (event) => {
    if (event?.status === 'progress' && Number.isFinite(event.progress)) {
      onStatus?.({ phase: 'downloading', progress: Math.min(1, event.progress / 100) });
    }
  };
  const load = (device) => pipeline('automatic-speech-recognition', WHISPER_MODELS[device].id, { device, dtype: WHISPER_MODELS[device].dtype, progress_callback: progress });
  let device = await pickDevice();
  onStatus?.({ phase: 'downloading', progress: null });
  try {
    const asr = await load(device);
    loadedDevice = device;
    return asr;
  } catch (error) {
    if (device !== 'webgpu') throw error;
    console.warn('[whisper] WebGPU failed, using WebAssembly:', error);
    device = 'wasm';
    const asr = await load(device);
    loadedDevice = device;
    return asr;
  }
}

/** Which backend the loaded model runs on ("webgpu" | "wasm"), or null before the first use. */
export function whisperDevice() {
  return loadedDevice;
}

/**
 * Transcribe 16 kHz mono WAV bytes in the browser.
 * @param {Uint8Array} wav
 * @param {{ language?: string, onStatus?: (s: { phase: 'downloading'|'transcribing', progress: number|null }) => void }} options
 * @returns {Promise<{ srt: string, vtt: string, device: string }>}
 */
export async function transcribeOnDevice(wav, { language = 'auto', onStatus } = {}) {
  const samples = wavToFloat32(wav);
  if (!pipelinePromise) pipelinePromise = loadPipeline(onStatus).catch((error) => { pipelinePromise = null; throw error; });
  const asr = await pipelinePromise;
  onStatus?.({ phase: 'transcribing', progress: null });
  const output = await asr(samples, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    task: 'transcribe',
    ...(language && language !== 'auto' ? { language } : {}),
  });
  const { srt, vtt, cues } = chunksToCaptions(output?.chunks, samples.length / SAMPLE_RATE);
  if (!cues.length) throw Object.assign(new Error('No speech detected in the audio.'), { code: 'no_speech' });
  return { srt, vtt, device: loadedDevice };
}
