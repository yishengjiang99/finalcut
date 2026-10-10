# /v2 editor tests (ffmpeg.wasm)

```bash
npm ci
npx playwright install --with-deps chromium   # once
npm run build:v2                              # copies cores, fetches + verifies GPL source (~104 MB, cached in .cache/), builds dist/v2
npm run test:e2e:v2                           # mt (COOP/COEP) + st (no isolation) projects
E2E_BENCH=1 npm run test:e2e:v2 -- v2-bench   # optional: 30 s 1080p benchmark (needs system ffmpeg)
```

- `server.mjs` serves `dist/v2` under `/v2/` with the same headers as `nginx/finalcut-v2.locations.conf`
  (`ISOLATE=0` drops COOP/COEP to force the single-thread fallback). Timings land in
  `test-results/e2e-v2/timings-{mt,st}.json`.
- Every test installs a network guard (Playwright `route` + `request` events + CDP) and fails on any
  third-party request, any non-GET outside `ALLOWED_WRITE_ENDPOINTS`, any legacy media route, any
  body > 64 KB or with a media/multipart content type, or any body containing the fixture's bytes.
- `check-v2-headers.sh <base>`: header smoke for `/v2` (also usable against production after a deploy).
- `compare-route-headers.sh <baseline> <candidate>`: proves existing routes' headers are identical.
- Fixture: `fixtures/testclip-6s.mp4` (320x240, 25 fps, keyframe every 1 s, 440 Hz AAC), made with
  `ffmpeg -f lavfi -i testsrc2=size=320x240:rate=25:duration=6 -f lavfi -i sine=frequency=440:duration=6 -c:v libx264 -preset veryfast -g 25 -pix_fmt yuv420p -c:a aac -b:a 64k -movflags +faststart -shortest testclip-6s.mp4`.

iOS contract (safe against production: GETs and requests rejected before any side effect):

```bash
npm run test:contract:ios -- --base http://localhost:3001
node tests/contract/ios-endpoints.mjs --base https://grepawk.com --record before.json   # before deploy
node tests/contract/ios-endpoints.mjs --base https://grepawk.com --compare before.json  # after deploy
```

GPL Corresponding Source (`/v2/vendor/ffmpeg/source/`): `scripts/fetch-ffmpeg-source.mjs` downloads every
archive in `vendor/ffmpeg-source.lock.json`, verifies the pinned SHA-256/size (plus the git commit id embedded in
GitHub tarballs and SDL2's sha512 from Emscripten), and fails the build on any mismatch. `npm run source:verify`
re-checks the cache offline. `v2-licenses.pw.mjs` asserts every same-origin link on `/legal/licenses.html`
and the source index resolves, `SHA256SUMS` equals the lock, and no written-offer text remains. Needs `tar`
(xz), `unzip` and `git` on PATH.
