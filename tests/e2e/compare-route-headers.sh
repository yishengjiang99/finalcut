#!/usr/bin/env bash
# Prove the /v2 include does not change existing routes: dump headers for existing paths and diff
# them (Date/ETag/Last-Modified/Content-Length/Server/Expires are dropped; the hashed main bundle is
# labelled "<main-asset>" so a rebuilt-but-identical bundle compares equal).
#   tests/e2e/compare-route-headers.sh http://127.0.0.1:8081 http://127.0.0.1:8080   # live vs live
#   tests/e2e/compare-route-headers.sh --dump https://grepawk.com > before.txt         # snapshot
#   tests/e2e/compare-route-headers.sh before.txt https://grepawk.com                  # snapshot vs live
# Each side may be a base URL or a file written by --dump.
set -euo pipefail
paths=(/ /index.html /legal/privacy.html /api/health /BigBuckBunny.mp4.README /some/spa/route /ffmpeg.wasm /ffmpeg.js)
dump() {
  local base="$1" asset p
  asset="$(curl -fsS "$base/" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1 || true)"
  for p in "${paths[@]}" ${asset:+"$asset"}; do
    [[ "$p" == "$asset" ]] && echo "== <main-asset>" || echo "== $p"
    curl -s -o /dev/null -D - "$base$p" | tr -d '\r' | grep -viE '^(date|etag|last-modified|content-length|server|expires):' | grep -v '^$' | sort
  done
}
side() { if [[ -f "$1" ]]; then cat "$1"; else dump "$1"; fi; }
if [[ "${1:-}" == "--dump" ]]; then dump "$2"; exit 0; fi
A="$1"; B="$2"
if diff <(side "$A") <(side "$B"); then
  echo "existing routes: headers identical ($(side "$A" | grep -c '^== ') paths)"
else
  echo "FAIL: headers differ"; exit 1
fi
