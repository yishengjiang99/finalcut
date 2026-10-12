#!/bin/bash
# Runs the whole wasm bench on this machine (no GitHub): Chromium and WebKit on the host,
# Firefox in the Playwright Docker image (Playwright's Firefox does not start under every
# macOS setup; the container also gives a Linux data point). One JSON per browser x core in
# test-results/bench/<label>/, then a markdown table.
#   tests/bench/run-local.sh baseline                                   # node_modules cores (0.12.10)
#   tests/bench/run-local.sh phase1 --core-root ~/ffmpeg.wasm/packages  # a locally built fork
# Env: BROWSERS="chromium webkit firefox", MODES="st mt", FIREFOX=docker|host|skip, plus any
# extra wasm-bench.mjs flags after the label (e.g. --ops thumbnail,ffprobe --soak-runs 10).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
LABEL=${1:?usage: run-local.sh <label> [--core-root <dir>] [wasm-bench flags]}; shift
BROWSERS=${BROWSERS:-chromium webkit firefox}
MODES=${MODES:-st mt}
FIREFOX=${FIREFOX:-docker}
OUT=test-results/bench/$LABEL
mkdir -p "$OUT"

# --core-root has to be mounted into the container, so pull it out of the flags.
CORE_ROOT=; ARGS=()
while [ $# -gt 0 ]; do
  if [ "$1" = --core-root ]; then CORE_ROOT=$(cd "$2" && pwd); shift 2; else ARGS+=("$1"); shift; fi
done

[ -f tests/fixtures/bench/src-1080p-60s.mp4 ] || node tests/bench/make-fixtures.mjs
PW=$(node -p "require('@playwright/test/package.json').version")
NM=$(cd node_modules && pwd -P)   # node_modules may be a symlink (git worktree)

for b in $BROWSERS; do
  for m in $MODES; do
    echo "### $LABEL: $b / $m"
    if [ "$b" = firefox ] && [ "$FIREFOX" = skip ]; then echo "skipped"; continue; fi
    if [ "$b" = firefox ] && [ "$FIREFOX" = docker ]; then
      docker run --rm --ipc=host -v "$ROOT":/work -v "$NM":/work/node_modules:ro \
        ${CORE_ROOT:+-v "$CORE_ROOT":/cores:ro} -w /work "mcr.microsoft.com/playwright:v$PW-noble" \
        node tests/bench/wasm-bench.mjs --browsers firefox --modes "$m" --out "$OUT/firefox-$m.json" \
        ${CORE_ROOT:+--core-root /cores} ${ARGS[@]+"${ARGS[@]}"}
    else
      node tests/bench/wasm-bench.mjs --browsers "$b" --modes "$m" --out "$OUT/$b-$m.json" \
        ${CORE_ROOT:+--core-root "$CORE_ROOT"} ${ARGS[@]+"${ARGS[@]}"}
    fi
  done
done
node tests/bench/report.mjs "$OUT"/*.json | tee "$OUT/report.md"
