#!/usr/bin/env bash

set -euo pipefail

HOST="${FINALCUT_DEPLOY_HOST:-root@grepawk.com}"
APP_DIR="${FINALCUT_DEPLOY_DIR:-/home/finalcut/apps/pages/finalcut}"

echo "Deploying current checkout to ${HOST}:${APP_DIR}"

rsync -az --delete \
  --exclude ".git/" \
  --exclude ".env*" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude ".DS_Store" \
  --exclude "ios/FinalCut.xcodeproj/project.xcworkspace/xcuserdata/" \
  ./ "${HOST}:${APP_DIR}/"

ssh "${HOST}" "cd '${APP_DIR}' && npm ci --production=false && npm run build && sudo systemctl restart finalcut && sudo systemctl is-active --quiet finalcut"

echo "Deployed to https://grepawk.com"
