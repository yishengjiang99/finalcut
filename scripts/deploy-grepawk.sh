#!/usr/bin/env bash

set -euo pipefail

HOST="${FINALCUT_DEPLOY_HOST:-root@grepawk.com}"
APP_DIR="${FINALCUT_DEPLOY_DIR:-/home/finalcut/apps/pages/finalcut}"
# FINALCUT_PREBUILT_DIST=1 (used by .github/workflows/deploy-grepawk.yml): dist/ was built on the
# runner (npm run build && npm run build:v2) and already uploaded to ${APP_DIR}/dist.new; the server
# only runs npm ci, swaps dist.new -> dist (keeping the old one as dist.prev for rollback) and
# restarts. Unset: legacy behaviour (build on the server; /v2 is not built).
PREBUILT="${FINALCUT_PREBUILT_DIST:-0}"

echo "Deploying current checkout to ${HOST}:${APP_DIR}"

# Record the deployed commit (prod has no usable .git; /api/health reads REVISION).
# "-dirty" means tracked files differ from HEAD in the checkout being deployed.
if REVISION="$(git rev-parse --short HEAD 2>/dev/null)"; then
  if ! git diff --quiet HEAD -- 2>/dev/null; then
    REVISION="${REVISION}-dirty"
  fi
  printf '%s\n' "${REVISION}" > REVISION
  echo "Revision: ${REVISION}"
else
  echo "WARNING: not a git checkout; REVISION file not written" >&2
  rm -f REVISION
fi

rsync -az --delete \
  --include "/REVISION" \
  --exclude ".git/" \
  --exclude ".env*" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude "/dist.new/" \
  --exclude "/dist.prev/" \
  --exclude "/dist.failed/" \
  --exclude "/.dist-swapped-by" \
  --exclude "/.cache/" \
  --exclude "/v2/public/ffmpeg-core/" \
  --exclude "/v2/public/vendor/" \
  --exclude "/test-results/" \
  --exclude "/playwright-report/" \
  --exclude ".DS_Store" \
  --exclude "ios/FinalCut.xcodeproj/project.xcworkspace/xcuserdata/" \
  ./ "${HOST}:${APP_DIR}/"

if [[ "${PREBUILT}" == "1" ]]; then
  ssh "${HOST}" "set -e; cd '${APP_DIR}'; test -f dist.new/index.html; test -f dist.new/v2/index.html; npm ci --production=false; rm -rf dist.prev; if [ -d dist ]; then mv dist dist.prev; fi; mv dist.new dist; echo '${FINALCUT_DEPLOY_ID:-manual}' > .dist-swapped-by; sudo systemctl restart finalcut && sudo systemctl is-active --quiet finalcut"
else
  ssh "${HOST}" "cd '${APP_DIR}' && npm ci --production=false && npm run build && sudo systemctl restart finalcut && sudo systemctl is-active --quiet finalcut"
fi

echo "Deployed to https://grepawk.com"
