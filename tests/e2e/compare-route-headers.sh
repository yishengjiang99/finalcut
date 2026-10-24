#!/usr/bin/env bash
# Prove the /v2 include does not change existing routes: dump headers for existing paths and diff
# them (Date/ETag/Last-Modified/Content-Length/Server/Expires are dropped; the hashed main bundle is
# labelled "<main-asset>" so a rebuilt-but-identical bundle compares equal). Transport-level
# differences are normalised so the gate survives the HTTP/1.1 -> HTTP/2 switch: the status line is
# reduced to its code, header names are lower-cased, and Connection / Strict-Transport-Security /
# Vary (HSTS and gzip_vary are added site-wide on purpose) are dropped, and so is exactly
# `cache-control: no-cache` (the HTML shell revalidates on purpose: / , /index.html, /success and the
# 404 pages; tests/e2e/check-site-seo.sh asserts it on / and /index.html). /success is the SPA's only
# client-side route (Stripe checkout return); other unknown paths are real 404s by design.
#   tests/e2e/compare-route-headers.sh http://127.0.0.1:8081 http://127.0.0.1:8080   # live vs live
#   tests/e2e/compare-route-headers.sh --dump https://grepawk.com > before.txt         # snapshot
#   tests/e2e/compare-route-headers.sh before.txt https://grepawk.com                  # snapshot vs live
# Each side may be a base URL or a file written by --dump.
set -euo pipefail
paths=(/ /index.html /legal/privacy.html /api/health /sample-lake.mp4.README /success /ffmpeg.wasm /ffmpeg.js)
dump() {
  local base="$1" asset p
  asset="$(curl -fsS "$base/" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1 || true)"
  for p in "${paths[@]}" ${asset:+"$asset"}; do
    [[ "$p" == "$asset" ]] && echo "== <main-asset>" || echo "== $p"
    curl -s -o /dev/null -D - "$base$p" | tr -d '\r' \
      | sed -E 's#^HTTP/[0-9.]+ ([0-9]{3}).*#STATUS \1#; s#^([A-Za-z0-9-]+):#\L\1:#' \
      | grep -viE '^cache-control: no-cache$' | grep -viE '^(date|etag|last-modified|content-length|server|expires|connection|strict-transport-security|vary):' | grep -v '^$' | sort
  done
}
side() { if [[ -f "$1" ]]; then cat "$1"; else dump "$1"; fi; }
if [[ "${1:-}" == "--dump" ]]; then dump "$2"; exit 0; fi
# A path that was a 404 before and a 200 after is an additive change (a newly shipped static file,
# e.g. /sample-lake.mp4.README the first time it is deployed): report it and compare it as equal.
# Any other difference, including header changes on routes that were already 200, still fails.
normalise() {  # normalise <this-side-file> <other-side-file>: collapse 404->200 blocks into a marker
  awk -v other="$2" -v me="$3" '
    BEGIN { while ((getline l < other) > 0) { if (l ~ /^== /) c = l; else if (l ~ /^STATUS /) ost[c] = l } }
    function flush() { if (p == "") return
      if ((me == "A" && st == "STATUS 404" && ost[p] == "STATUS 200") || (me == "B" && st == "STATUS 200" && ost[p] == "STATUS 404")) {
        print p; print "ADDITIVE 404->200"; if (me == "B") print "NOTE: " p " is new (404 -> 200), treated as additive" > "/dev/stderr"
      } else printf "%s", buf
      buf = "" }
    /^== / { flush(); p = $0; st = ""; buf = $0 "\n"; next }
    { if ($0 ~ /^STATUS /) st = $0; buf = buf $0 "\n" }
    END { flush() }' "$1"
}
A="$1"; B="$2"
TA="$(mktemp)"; TB="$(mktemp)"; trap 'rm -f "$TA" "$TB"' EXIT
side "$A" > "$TA"; side "$B" > "$TB"
if diff <(normalise "$TA" "$TB" A) <(normalise "$TB" "$TA" B); then
  echo "existing routes: headers identical ($(side "$A" | grep -c '^== ') paths)"
else
  echo "FAIL: headers differ"; exit 1
fi
