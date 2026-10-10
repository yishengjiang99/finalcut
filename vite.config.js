import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
// Self-hosted ffmpeg.wasm cores, copied from node_modules by scripts/copy-ffmpeg-core.mjs.
// The editor loads them from /v2/ffmpeg-core/ (the path nginx serves with COOP/COEP/CORP and
// application/wasm), so dev and preview serve that path and the build ships a copy.
const CORE_DIR = path.join(ROOT, 'v2', 'public', 'ffmpeg-core')
const CORE_URL = '/v2/ffmpeg-core/'
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

function ffmpegCore() {
  const serve = (req, res, next) => {
    const url = (req.url || '').split('?')[0]
    if (!url.startsWith(CORE_URL)) return next()
    const file = path.join(CORE_DIR, path.normalize(url.slice(CORE_URL.length)))
    if (!file.startsWith(CORE_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404
      return res.end('ffmpeg core not found; run `node scripts/copy-ffmpeg-core.mjs`')
    }
    const type = file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.json') ? 'application/json' : 'text/javascript'
    res.writeHead(200, { 'Content-Type': type, 'Cross-Origin-Resource-Policy': 'same-origin', ...ISOLATION_HEADERS })
    createReadStream(file).pipe(res)
  }
  let outDir
  return {
    name: 'finalcut-ffmpeg-core',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir) },
    configureServer(server) { server.middlewares.use(serve) },
    configurePreviewServer(server) { server.middlewares.use(serve) },
    closeBundle() {
      if (process.env.VITEST) return
      if (!existsSync(CORE_DIR)) throw new Error('ffmpeg cores are missing; run `node scripts/copy-ffmpeg-core.mjs` before building')
      cpSync(CORE_DIR, path.join(outDir, 'v2', 'ffmpeg-core'), { recursive: true })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), ffmpegCore()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  build: {
    sourcemap: true,           // already default in dev, but explicit is fine
  },
  esbuild: {
    // Sometimes helps sourcemap stability (tradeoff: slightly slower transforms)
    sourcemap: 'inline',
  },
  mode: 'production',
  base: '/', // Ensure assets are served from the root `/`
  server: {
    headers: ISOLATION_HEADERS,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: { headers: ISOLATION_HEADERS },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/tests/playwright/**',
      '**/.claude/**', // other checkouts of this repo (agent worktrees)
    ],
  },
})
