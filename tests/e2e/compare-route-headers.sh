#!/usr/bin/env bash
# Prove the /v2 include does not change existing routes: dump headers for existing paths from a
# baseline server and from the server with the include, and diff them (Date/ETag/Last-Modified
# and Content-Length are dropped).
#   tests/e2e/compare-route-headers.sh http://127.0.0.1:8081 http://127.0.0.1:8080
set -euo pipefail
A="$1"; B="$2"
asset="$(curl -fsS "$A/" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1 || true)"
paths=(/ /index.html /legal/privacy.html /api/health /BigBuckBunny.mp4.README /some/spa/route /ffmpeg.wasm /ffmpeg.js)
[[ -n "$asset" ]] && paths+=("$asset")
dump() { for p in "${paths[@]}"; do echo "== $p"; curl -s -o /dev/null -D - "$1$p" | tr -d '\r' | grep -viE '^(date|etag|last-modified|content-length|server|expires):' | sort; done; }
if diff <(dump "$A") <(dump "$B"); then echo "existing routes: headers identical with and without the /v2 include (${#paths[@]} paths)"; else echo "FAIL: headers differ"; exit 1; fi
