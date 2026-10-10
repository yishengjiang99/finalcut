// Build/dev config for the NEW /v2 editor only. The existing editor keeps using vite.config.js
// (`npm run build` -> dist/), unchanged. This one writes dist/v2/ and is served under /v2/.
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Cross-origin isolation for the /v2 page only (enables the multithreaded ffmpeg core).
export const V2_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  root: path.join(ROOT, 'v2'),
  base: '/v2/',
  publicDir: path.join(ROOT, 'v2', 'public'),
  build: {
    outDir: path.join(ROOT, 'dist', 'v2'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  server: { port: 5174, headers: V2_ISOLATION_HEADERS, fs: { allow: [ROOT] } },
  preview: { port: 4174, headers: V2_ISOLATION_HEADERS },
});
