#!/usr/bin/env bash
# Guarded install of the /v2 nginx snippet on the production host. Runs ON the server (as root or
# with sudo), invoked over SSH by .github/workflows/deploy-grepawk.yml.
#
#   finalcut-v2-nginx.sh preflight <app_dir>   # read-only: can we manage nginx? exactly one target?
#   finalcut-v2-nginx.sh install   <app_dir>   # backup -> install snippets -> include -> nginx -t -> reload
#   finalcut-v2-nginx.sh rollback  [deploy_id] # restore the last backup -> nginx -t -> reload
#
# preflight changes nothing and can be piped over ssh before any file is shipped:
#   ssh host 'bash -s -- preflight /app/dir' < scripts/nginx/finalcut-v2-nginx.sh
# FINALCUT_DEPLOY_ID (e.g. the Actions run id) is stored with the backup; `rollback <id>` only
# restores a backup taken by that same deploy, so a failure before the backup never restores an
# older deploy's config.
#
# Scope: the ONLY server-config edit is one `include` line added right after the unique
# `root <app_dir>/dist;` line, i.e. inside this site's server block. Other sites are untouched.
# Any failure after the backup restores it (and reloads if nginx had already been reloaded).
set -Eeuo pipefail

# Overridable for the local test harness only (tests/nginx/finalcut-v2-nginx.test.sh).
NGINX_DIR="${FINALCUT_NGINX_DIR:-/etc/nginx}"
SNIPPET_DIR="${NGINX_DIR}/snippets"
SNIPPETS=(finalcut-v2.locations.conf finalcut-v2-headers.conf)
BACKUP_ROOT="${FINALCUT_NGINX_BACKUP_ROOT:-/var/backups/finalcut-nginx}"
read -r -a RELOAD <<<"${FINALCUT_NGINX_RELOAD:-systemctl reload nginx}"   # CI container: "nginx -s reload"
MARK='# finalcut /v2 (managed by deploy-grepawk.yml)'
INCLUDE_LINE="include ${SNIPPET_DIR}/finalcut-v2.locations.conf; ${MARK}"
SUDO=""; [[ $(id -u) -eq 0 ]] || SUDO="sudo -n"
SUDO="${FINALCUT_NGINX_SUDO-$SUDO}"   # test harness sets this to empty

log() { echo "[nginx-v2] $*"; }
die() { echo "[nginx-v2] ERROR: $*" >&2; exit 1; }

find_target() { # prints the real path of the single config file that serves <app_dir>/dist
  local app_dir="$1" root_line files=() f real
  root_line="root ${app_dir}/dist;"
  while IFS= read -r f; do
    real="$(readlink -f "$f")"
    [[ " ${files[*]-} " == *" $real "* ]] || files+=("$real")
  done < <($SUDO grep -RlF "$root_line" "$NGINX_DIR/sites-enabled" "$NGINX_DIR/conf.d" "$NGINX_DIR/nginx.conf" 2>/dev/null || true)
  [[ ${#files[@]} -eq 1 ]] || die "expected exactly 1 nginx config containing '${root_line}', found ${#files[@]}: ${files[*]-none}"
  local n; n="$($SUDO grep -cF "$root_line" "${files[0]}")"
  [[ "$n" -eq 1 ]] || die "'${root_line}' appears ${n} times in ${files[0]}; refusing to guess which server block"
  echo "${files[0]}"
}

do_preflight() {
  local app_dir="${1:?app_dir}"
  command -v nginx >/dev/null || die "nginx binary not found"
  [[ -z "$SUDO" ]] || $SUDO true 2>/dev/null || die "no passwordless sudo for $(id -un)"
  $SUDO nginx -t >/dev/null 2>&1 || die "current nginx config does not pass 'nginx -t'; not touching it"
  local target; target="$(find_target "$app_dir")"
  $SUDO test -w "$target" || die "cannot write $target"
  $SUDO test -d "$SNIPPET_DIR" || log "note: ${SNIPPET_DIR} does not exist yet (will be created)"
  if $SUDO grep -qF "$MARK" "$target"; then log "include already present"; else log "include not present yet"; fi
  log "preflight ok: target=${target} nginx=$($SUDO nginx -v 2>&1 | sed 's/.*: //')"
}

restore() { # $1 = backup dir
  local bk="$1" target
  target="$(cat "$bk/TARGET")"
  log "restoring ${target} and snippets from ${bk}"
  $SUDO sh -c 'cat "$1" > "$2"' sh "$bk/target.conf" "$target"
  for s in "${SNIPPETS[@]}"; do
    if [[ -f "$bk/$s" ]]; then $SUDO cp -a "$bk/$s" "$SNIPPET_DIR/$s"; else $SUDO rm -f "$SNIPPET_DIR/$s"; fi
  done
  $SUDO nginx -t && $SUDO "${RELOAD[@]}" && log "restored + reloaded"
}

do_install() {
  local app_dir="${1:?app_dir}"
  do_preflight "$app_dir"
  [[ -f "${app_dir}/nginx/finalcut-v2.locations.conf" && -f "${app_dir}/nginx/finalcut-v2-headers.conf" ]] || die "snippets missing in ${app_dir}/nginx"
  [[ -f "${app_dir}/dist/v2/index.html" ]] || die "${app_dir}/dist/v2/index.html missing; ship dist before installing nginx"
  local target bk
  target="$(find_target "$app_dir")"
  bk="${BACKUP_ROOT}/$(date -u +%Y%m%dT%H%M%SZ)"
  $SUDO mkdir -p "$bk" "$SNIPPET_DIR"
  $SUDO cp -a "$target" "$bk/target.conf"
  echo "${FINALCUT_DEPLOY_ID:-manual}" | $SUDO tee "$bk/DEPLOY_ID" >/dev/null
  echo "$target" | $SUDO tee "$bk/TARGET" >/dev/null
  for s in "${SNIPPETS[@]}"; do [[ -f "$SNIPPET_DIR/$s" ]] && $SUDO cp -a "$SNIPPET_DIR/$s" "$bk/$s"; done
  echo "$bk" | $SUDO tee "${BACKUP_ROOT}/LAST" >/dev/null
  log "backup: ${bk}"

  trap 'log "install failed; rolling back"; restore "$bk"; exit 1' ERR
  for s in "${SNIPPETS[@]}"; do $SUDO install -m 0644 "${app_dir}/nginx/$s" "$SNIPPET_DIR/$s"; done
  if $SUDO grep -qF "$MARK" "$target"; then
    log "include already present in ${target}"
  else
    local root_line="root ${app_dir}/dist;"
    # Append the include right after the unique root line (same server block, same indentation).
    $SUDO awk -v rl="$root_line" -v inc="$INCLUDE_LINE" '
      { print }
      index($0, rl) && !done { match($0, /^[ \t]*/); print substr($0, RSTART, RLENGTH) inc; done=1 }
    ' "$target" | $SUDO tee "${target}.finalcut-new" >/dev/null
    $SUDO sh -c 'cat "$1" > "$2"' sh "${target}.finalcut-new" "$target"   # rewrite in place: keeps inode/owner/mode
    $SUDO rm -f "${target}.finalcut-new"
    log "added include to ${target}:"
    $SUDO diff -u "$bk/target.conf" "$target" || true
  fi
  $SUDO nginx -t
  $SUDO "${RELOAD[@]}"
  trap - ERR
  log "installed + reloaded"
}

do_rollback() {
  local want="${1:-}" bk
  [[ -f "${BACKUP_ROOT}/LAST" ]] || { log "no backup recorded; nothing to roll back"; return 0; }
  bk="$($SUDO cat "${BACKUP_ROOT}/LAST")"
  if [[ -n "$want" && "$($SUDO cat "$bk/DEPLOY_ID" 2>/dev/null || true)" != "$want" ]]; then
    log "last backup (${bk}) is not from deploy ${want}; nginx was not changed by this deploy, nothing to roll back"
    return 0
  fi
  restore "$bk"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  preflight) do_preflight "$@" ;;
  install) do_install "$@" ;;
  rollback) do_rollback "$@" ;;
  *) die "usage: $0 preflight|install <app_dir> | rollback [deploy_id]" ;;
esac
