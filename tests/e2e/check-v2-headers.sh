#!/usr/bin/env bash
# Header smoke for the /v2 route (works against CI's throwaway nginx, a local test server, or prod
# after a deploy):  tests/e2e/check-v2-headers.sh https://grepawk.com
set -euo pipefail
BASE="${1:-http://127.0.0.1:8080}"
CORE_VERSION="${CORE_VERSION:-0.12.10}"
fail=0
hdr() { curl -fsS -o /dev/null -D - "$BASE$1" | tr -d '\r' | awk -v IGNORECASE=1 -v h="$2" 'tolower($0) ~ "^"tolower(h)":" {sub(/^[^:]*:[ ]*/,""); print; exit}'; }
expect() { # path header expected
  local got; got="$(hdr "$1" "$2" || true)"
  if [[ "$got" == "$3" ]]; then echo "ok   $1  $2: $got"; else echo "FAIL $1  $2: got '${got}', want '$3'"; fail=1; fi
}
html="$(curl -fsS "$BASE/v2/")"
asset="$(grep -oE '/v2/assets/index-[A-Za-z0-9_-]+\.js' <<<"$html" | head -1)"
[[ -n "$asset" ]] || { echo "FAIL could not find /v2 asset in HTML"; exit 1; }
for p in /v2/ "$asset" "/v2/ffmpeg-core/mt/$CORE_VERSION/ffmpeg-core.js" "/v2/ffmpeg-core/mt/$CORE_VERSION/ffmpeg-core.worker.js" \
         "/v2/ffmpeg-core/mt/$CORE_VERSION/ffmpeg-core.wasm" "/v2/ffmpeg-core/st/$CORE_VERSION/ffmpeg-core.wasm"; do
  expect "$p" Cross-Origin-Opener-Policy same-origin
  expect "$p" Cross-Origin-Embedder-Policy require-corp
  expect "$p" Cross-Origin-Resource-Policy same-origin
  expect "$p" X-Content-Type-Options nosniff
done
expect "/v2/ffmpeg-core/mt/$CORE_VERSION/ffmpeg-core.wasm" Content-Type application/wasm
expect "/v2/ffmpeg-core/st/$CORE_VERSION/ffmpeg-core.wasm" Content-Type application/wasm
code="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/v2")"
[[ "$code" == 301* && "$code" == */v2/ ]] && echo "ok   /v2 -> /v2/" || { echo "FAIL /v2 redirect: $code"; fail=1; }
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v2/vendor/ffmpeg/source/SHA256SUMS")"
[[ "$code" == 200 ]] && echo "ok   /v2/vendor/ffmpeg/source/SHA256SUMS 200" || { echo "FAIL source SHA256SUMS: $code"; fail=1; }
ct="$(hdr /v2/vendor/ffmpeg/source/SHA256SUMS Content-Type || true)"
[[ "$ct" == text/plain* ]] && echo "ok   SHA256SUMS Content-Type: $ct" || { echo "FAIL SHA256SUMS Content-Type: $ct"; fail=1; }
exit $fail
