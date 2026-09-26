#!/usr/bin/env bash

set -euo pipefail

HOST="${FINALCUT_DEPLOY_HOST:-root@grepawk.com}"
APP_DIR="${FINALCUT_DEPLOY_DIR:-/home/finalcut/apps/pages/finalcut}"

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
  --exclude ".DS_Store" \
  --exclude "ios/FinalCut.xcodeproj/project.xcworkspace/xcuserdata/" \
  ./ "${HOST}:${APP_DIR}/"

ssh "${HOST}" "cd '${APP_DIR}' && npm ci --production=false && npm run build && sudo systemctl restart finalcut && sudo systemctl is-active --quiet finalcut"

echo "Deployed to https://grepawk.com"
