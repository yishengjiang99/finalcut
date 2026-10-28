// jsdom cannot run ffmpeg.wasm. Edits that have a server fallback fail to start in the browser
// (and the tests agree to the upload), so they exercise the server request contract. Steps that
// only run in the browser get small stand-in results.
import { vi } from 'vitest';

const FALLS_BACK_TO_SERVER = ['loadEngine', 'processMedia', 'runCliCommand'];

export const STUB_METADATA = {
  format: { duration: 10, size: 1024 * 1024 },
  streams: [{ codec_type: 'video', width: 1920, height: 1080, codec_name: 'h264', r_frame_rate: '30/1' }],
};

export async function noWasmEngine(importOriginal) {
  const real = await importOriginal();
  const fail = async () => {
    throw Object.assign(new Error('The video engine could not be loaded: no WebAssembly in jsdom'), { code: 'wasm_load_failed' });
  };
  return {
    ...real,
    ...Object.fromEntries(FALLS_BACK_TO_SERVER.map((name) => [name, fail])),
    probeMedia: async () => STUB_METADATA,
    // Caption burn-in only ever runs in the browser; tests make it fail with mockRejectedValueOnce.
    burnSubtitles: vi.fn(async (_options, bytes) => new Uint8Array(10 + (bytes?.byteLength ?? bytes?.length ?? 0))),
    addAudioTrack: vi.fn(async () => new Uint8Array([7, 7, 7])),
    concatClips: vi.fn(async (clips) => new Uint8Array(clips.length)),
    joinClips: vi.fn(async (_options, clips) => new Uint8Array(clips.length)),
    extractSpeechAudio: vi.fn(async () => new Uint8Array([82, 73, 70, 70])),
    thumbnail: async () => new Uint8Array([1]),
  };
}
