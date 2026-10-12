#!/usr/bin/env bash
# Copy recent hashed build files from the live dist into the new dist before the swap, so a browser
# holding an older index.html (cached document or an open tab lazy-loading a chunk) still finds its
# /assets/index-<hash>.js instead of a 404 and a blank page. Never overwrites a file in the new
# build. Only files built in the last MAX_DAYS (default 7) are carried, so old bundles age out.
# Usage: carry-hashed-assets.sh <old_dist> <new_dist>
set -euo pipefail
OLD="$1"; NEW="$2"; MAX_DAYS="${CARRY_ASSETS_MAX_DAYS:-7}"
n=0
for sub in assets v2/assets; do
  [ -d "$OLD/$sub" ] && [ -d "$NEW/$sub" ] || continue
  while IFS= read -r -d '' f; do
    rel="${f#"$OLD/"}"
    if [ ! -e "$NEW/$rel" ]; then
      mkdir -p "$(dirname "$NEW/$rel")"
      cp -p "$f" "$NEW/$rel"
      n=$((n + 1))
    fi
  done < <(find "$OLD/$sub" -type f -mtime "-$MAX_DAYS" -print0)
done
echo "carried $n previous hashed asset(s) into $NEW"
