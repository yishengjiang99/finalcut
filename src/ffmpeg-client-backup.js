// ffmpeg-loader.js
// Complete module for loading @ffmpeg/ffmpeg with reliable core loading
// Usage: import { ffmpeg, loadFFmpeg, fetchFile, toBlobURL } from './ffmpeg-loader.js';

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile as utilFetchFile, toBlobURL as utilToBlobURL } from '@ffmpeg/util';

export const ffmpeg = new FFmpeg();
export const toBlobURL = utilToBlobURL;

// Optional: listen to logs/progress (very useful for debugging)
ffmpeg.on('log', ({ message }) => {
  console.log('[ffmpeg log]', message);
});

ffmpeg.on('progress', ({ progress, time }) => {
  console.log(`[ffmpeg progress] ${Math.round(progress * 100)}% - time: ${time}`);
});

let isLoaded = false;

/**
 * Load FFmpeg with core for maximum compatibility
 * Uses CDN with progress tracking like the official playground
 */
export async function loadFFmpeg({
  log = true,                    // enable verbose logging
  coreVersion = '0.12.10',       // core version matching playground
  multiThread = false,           // use multi-threaded version
  onProgress = null,             // optional progress callback: ({ url, received }) => void
} = {}) {
  if (isLoaded) return;

  if (log) {
    console.log(`[ffmpeg] Starting load with ${multiThread ? 'multi-threaded' : 'single-threaded'} core...`);
  }

  // Use cdn.jsdelivr.net as primary CDN (same as playground)
  const corePackage = multiThread ? '@ffmpeg/core-mt' : '@ffmpeg/core';
  const baseURL = `https://cdn.jsdelivr.net/npm/${corePackage}@${coreVersion}/dist/umd`;

  try {
    // Create progress callback wrapper
    const progressCallback = onProgress ? ({ url, received }) => {
      onProgress({ url, received });
    } : null;

    if (log) {
      console.log(`[ffmpeg] Loading from cdn.jsdelivr.net (${corePackage}@${coreVersion})...`);
    }

    // Terminate any existing instance before loading (safely handle errors)
    try {
      ffmpeg.terminate();
    } catch (err) {
      // Ignore errors if FFmpeg was never loaded or already terminated
      if (log) {
        console.log('[ffmpeg] No previous instance to terminate');
      }
    }

    // Load core JavaScript
    const coreURL = await toBlobURL(
      `${baseURL}/ffmpeg-core.js`,
      'text/javascript',
      true,
      progressCallback
    );

    // Load WebAssembly
    const wasmURL = await toBlobURL(
      `${baseURL}/ffmpeg-core.wasm`,
      'application/wasm',
      true,
      progressCallback
    );

    // Load configuration based on mode
    const loadConfig = {
      coreURL,
      wasmURL,
    };

    // Load worker for multi-threaded version
    if (multiThread) {
      const workerURL = await toBlobURL(
        `${baseURL}/ffmpeg-core.worker.js`,
        'text/javascript',
        true,
        progressCallback
      );
      loadConfig.workerURL = workerURL;
    }

    // Load FFmpeg with the downloaded assets
    await ffmpeg.load(loadConfig);

    isLoaded = true;
    if (log) {
      console.log(`[ffmpeg] Successfully loaded (${multiThread ? 'multi-threaded' : 'single-threaded'} mode)`);
    }

  } catch (err) {
    console.error('[ffmpeg] Failed to load:', err);
    throw new Error(
      `Failed to load FFmpeg. ` +
      `Please check your internet connection and try again. ` +
      `Error: ${err?.message || 'Unknown error'}`
    );
  }
}

/**
 * Helper to convert File/Blob/URL to Uint8Array (compatible with ffmpeg FS)
 * Re-exported from @ffmpeg/util for convenience
 */
export const fetchFile = utilFetchFile;

// Example usage (uncomment to test):
/*
async function example() {
  await loadFFmpeg({ log: true });

  // Write a file to in-memory FS
  await ffmpeg.writeFile('input.mp4', await fetchFile('https://example.com/video.mp4'));

  // Run command
  await ffmpeg.exec(['-i', 'input.mp4', '-c:v', 'copy', 'output.mp4']);

  // Read result
  const data = await ffmpeg.readFile('output.mp4');
  console.log('Output size:', data.length);

  // Create downloadable Blob
  const blob = new Blob([data.buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  console.log('Download URL:', url);
}

example().catch(console.error);
*/