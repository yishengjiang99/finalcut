#!/usr/bin/env bash
# Guarded install of the FinalCut site settings (HSTS, gzip, http2, www -> apex, http -> apex,
# real 404s, /legal redirect, asset caching) on the production host. Runs ON the server as root
# (or with sudo), invoked over SSH by .github/workflows/deploy-grepawk.yml AFTER the /v2 snippet
# installer (scripts/nginx/finalcut-v2-nginx.sh).
#
#   finalcut-site-nginx.sh preflight <app_dir>   # read-only checks
#   finalcut-site-nginx.sh install   <app_dir>   # backup -> edits -> nginx -t -> reload -> smoke;
#                                                #   any failure restores the backup and reloads
#   finalcut-site-nginx.sh rollback  [deploy_id] # restore this deploy's backup -> nginx -t -> reload
#
# Edits, all inside the ONE config file that holds `root <app_dir>/dist;` (other sites untouched):
#   1. `listen 443 ssl;`                          -> `listen 443 ssl http2;`
#   2. 443 block `server_name grepawk.com www.grepawk.com;` -> `server_name grepawk.com;`
#   3. port-80 block `return 301 https://$host$request_uri;` -> `return 301 https://grepawk.com$request_uri;`
#   4. `include .../finalcut-site.conf;` right after the root line (snippet: HSTS, gzip, /success,
#      /legal redirect, asset caching)
#   5. `location /` fallback `try_files $uri $uri/ /index.html;` -> `try_files $uri $uri/ =404;`
#      + `error_page 404 /404.html;`
#   6. a managed `server { listen 443 ssl http2; server_name www.grepawk.com; return 301 ... }`
#      appended to the file, reusing the site's own certificate lines.
# Note: `http2` on a listen socket applies to every server block sharing 0.0.0.0:443 (nginx
# negotiates the protocol per connection, before the Host is known).
# Smoke after reload compares status codes of other sites/paths with a pre-change snapshot.
set -Eeuo pipefail

NGINX_DIR="${FINALCUT_NGINX_DIR:-/etc/nginx}"
SNIPPET_DIR="${NGINX_DIR}/snippets"
SNIPPETS=(finalcut-site.conf finalcut-site-headers.conf)
BACKUP_ROOT="${FINALCUT_SITE_BACKUP_ROOT:-/var/backups/finalcut-nginx-site}"
read -r -a RELOAD <<<"${FINALCUT_NGINX_RELOAD:-systemctl reload nginx}"
read -r -a NGINX_TEST <<<"${FINALCUT_NGINX_TEST:-nginx -t}"
APEX="${FINALCUT_APEX:-grepawk.com}"
WWW="www.${APEX}"
SMOKE="${FINALCUT_SITE_SMOKE:-1}"            # test harness sets 0
MARK='# finalcut site (managed by deploy-grepawk.yml)'
BEGIN_WWW="# BEGIN finalcut www-redirect (managed by deploy-grepawk.yml)"
END_WWW="# END finalcut www-redirect"
SUDO=""; [[ $(id -u) -eq 0 ]] || SUDO="sudo -n"
SUDO="${FINALCUT_NGINX_SUDO-$SUDO}"

log() { echo "[nginx-site] $*"; }
die() { echo "[nginx-site] ERROR: $*" >&2; exit 1; }

find_target() {
  local app_dir="$1" root_line files=() f real
  root_line="root ${app_dir}/dist;"
  while IFS= read -r f; do
    real="$(readlink -f "$f")"
    [[ " ${files[*]-} " == *" $real "* ]] || files+=("$real")
  done < <($SUDO grep -RlF "$root_line" "$NGINX_DIR/sites-enabled" "$NGINX_DIR/conf.d" "$NGINX_DIR/nginx.conf" 2>/dev/null || true)
  [[ ${#files[@]} -eq 1 ]] || die "expected exactly 1 nginx config containing '${root_line}', found ${#files[@]}: ${files[*]-none}"
  [[ "$($SUDO grep -cF "$root_line" "${files[0]}")" -eq 1 ]] || die "'${root_line}' is not unique in ${files[0]}"
  echo "${files[0]}"
}

count() { $SUDO grep -cxF -- "$1" "$2" || true; }   # exact whole-line matches

do_preflight() {
  local app_dir="${1:?app_dir}" target
  command -v nginx >/dev/null || die "nginx binary not found"
  $SUDO "${NGINX_TEST[@]}" >/dev/null 2>&1 || die "current nginx config does not pass nginx -t; not touching it"
  target="$(find_target "$app_dir")"
  $SUDO test -w "$target" || die "cannot write $target"
  if $SUDO grep -qF "$MARK" "$target"; then log "already installed in ${target}"; return 0; fi
  [[ "$(count '    listen 443 ssl;' "$target")" == 1 ]] || die "expected one '    listen 443 ssl;' line in ${target}"
  [[ "$(count "    server_name ${APEX} ${WWW};" "$target")" == 2 ]] || die "expected the port-80 and 443 blocks to both have 'server_name ${APEX} ${WWW};'"
  [[ "$(count '    return 301 https://$host$request_uri;' "$target")" == 1 ]] || die "expected one port-80 'return 301 https://\$host\$request_uri;' line"
  [[ "$(count '        try_files $uri $uri/ /index.html;' "$target")" == 1 ]] || die "expected one SPA fallback 'try_files \$uri \$uri/ /index.html;' line"
  [[ "$($SUDO grep -cE '^\s*ssl_certificate(_key)?\s' "$target")" == 2 ]] || die "expected exactly one ssl_certificate + ssl_certificate_key in ${target}"
  log "preflight ok: target=${target}"
}

restore() {
  local bk="$1" target
  target="$(cat "$bk/TARGET")"
  log "restoring ${target} and snippets from ${bk}"
  $SUDO sh -c 'cat "$1" > "$2"' sh "$bk/target.conf" "$target"
  for s in "${SNIPPETS[@]}"; do
    if [[ -f "$bk/$s" ]]; then $SUDO cp -a "$bk/$s" "$SNIPPET_DIR/$s"; else $SUDO rm -f "$SNIPPET_DIR/$s"; fi
  done
  $SUDO "${NGINX_TEST[@]}" && $SUDO "${RELOAD[@]}" && log "restored + reloaded"
}

# status code for https://<host><path> served by THIS machine (no DNS / external network)
code_https() { curl -sk -o /dev/null -m 10 -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1$2" || echo 000; }
code_http() { curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $1" "http://127.0.0.1$2" || echo 000; }
location_of() { curl -sk -o /dev/null -m 10 -w '%{redirect_url}' --resolve "$1:443:127.0.0.1" "https://$1$2" || true; }

# Other sites and paths on this machine that must not change status.
# (Every command here must not fail: with set -E the install's ERR trap also fires inside $(...).)
other_snapshot() {
  local h p
  for h in $($SUDO grep -RhoE '(^|[{;[:space:]])server_name\s+[^;]+;' "$NGINX_DIR/sites-enabled" "$NGINX_DIR/conf.d" 2>/dev/null \
             | sed -E 's/^.*server_name\s+//; s/;$//' | tr ' ' '\n' | grep -E '\.' | grep -vxF -e "$APEX" -e "$WWW" | sort -u || true); do
    echo "https://$h/ $(code_https "$h" /)"
  done
  for p in /music-radar/ /high-priestess/ /music-hear/ /music-reader/privacy.html /api/health /legal/privacy.html /v2 /v2/ffmpeg-core/mt/0.12.10/ffmpeg-core.wasm /.well-known/skadnetwork/; do
    echo "https://${APEX}${p} $(code_https "$APEX" "$p")"
  done
}

smoke_new() { # $1 = file with the pre-change snapshot
  local fail=0 got want
  check() { if [[ "$2" == "$3" ]]; then log "ok   $1 -> $2"; else log "FAIL $1 -> $2 (want $3)"; fail=1; fi; }
  check "https://${APEX}/" "$(code_https "$APEX" /)" 200
  check "https://${APEX}/success" "$(code_https "$APEX" /success)" 200
  check "https://${APEX}/this-page-does-not-exist" "$(code_https "$APEX" /this-page-does-not-exist)" 404
  check "https://${APEX}/legal" "$(code_https "$APEX" /legal)" 301
  check "https://${APEX}/add-subtitles" "$(code_https "$APEX" /add-subtitles)" 200
  check "https://${WWW}/x?y=1 Location" "$(location_of "$WWW" '/x?y=1')" "https://${APEX}/x?y=1"
  check "http://${WWW}/ code" "$(code_http "$WWW" /)" 301
  check "http://${APEX}/ code" "$(code_http "$APEX" /)" 301
  local now; now="$(mktemp)"; other_snapshot > "$now"
  while read -r url want; do
    got="$(awk -v u="$url" '$1==u{print $2}' "$now")"
    check "$url (unchanged)" "$got" "$want"
  done < "$1"
  rm -f "$now"
  return $fail
}

do_install() {
  local app_dir="${1:?app_dir}" target bk snap
  do_preflight "$app_dir"
  for s in "${SNIPPETS[@]}"; do [[ -f "${app_dir}/nginx/$s" ]] || die "${app_dir}/nginx/$s missing"; done
  [[ -f "${app_dir}/dist/404.html" ]] || die "${app_dir}/dist/404.html missing; ship dist before installing"
  target="$(find_target "$app_dir")"
  bk="${BACKUP_ROOT}/$(date -u +%Y%m%dT%H%M%SZ)"
  $SUDO mkdir -p "$bk" "$SNIPPET_DIR"
  $SUDO cp -a "$target" "$bk/target.conf"
  echo "${FINALCUT_DEPLOY_ID:-manual}" | $SUDO tee "$bk/DEPLOY_ID" >/dev/null
  echo "$target" | $SUDO tee "$bk/TARGET" >/dev/null
  for s in "${SNIPPETS[@]}"; do [[ -f "$SNIPPET_DIR/$s" ]] && $SUDO cp -a "$SNIPPET_DIR/$s" "$bk/$s"; done
  echo "$bk" | $SUDO tee "${BACKUP_ROOT}/LAST" >/dev/null
  log "backup: ${bk}"
  snap="$(mktemp)"
  if [[ "$SMOKE" == 1 ]]; then other_snapshot > "$snap"; log "pre-change snapshot:"; sed 's/^/[nginx-site]   /' "$snap"; fi

  trap 'log "install failed; rolling back"; restore "$bk"; exit 1' ERR
  for s in "${SNIPPETS[@]}"; do $SUDO install -m 0644 "${app_dir}/nginx/$s" "$SNIPPET_DIR/$s"; done
  if $SUDO grep -qF "$MARK" "$target"; then
    log "site edits already present in ${target}"
  else
    local root_line="root ${app_dir}/dist;" certs
    certs="$($SUDO grep -E '^\s*ssl_certificate(_key)?\s' "$target" | sed -E 's/^\s*/    /')"
    $SUDO awk -v rl="$root_line" -v inc="include ${SNIPPET_DIR}/finalcut-site.conf; ${MARK}" \
        -v apex="$APEX" -v www="$WWW" '
      $0 == "    listen 443 ssl;" { print "    listen 443 ssl http2;"; next }
      $0 == "    server_name " apex " " www ";" { sn++; if (sn == 2) { print "    server_name " apex ";"; next } }
      $0 == "    return 301 https://$host$request_uri;" { print "    return 301 https://" apex "$request_uri;"; next }
      $0 == "        try_files $uri $uri/ /index.html;" { print "        try_files $uri $uri/ =404;"; print "        error_page 404 /404.html;"; next }
      { print }
      index($0, rl) && !done { match($0, /^[ \t]*/); print substr($0, RSTART, RLENGTH) inc; done = 1 }
    ' "$target" | $SUDO tee "${target}.finalcut-site-new" >/dev/null
    {
      echo ""
      echo "$BEGIN_WWW"
      echo "server {"
      echo "    listen 443 ssl http2;"
      echo "    server_name ${WWW};"
      echo "$certs"
      echo "    ssl_protocols TLSv1.2 TLSv1.3;"
      echo "    ssl_ciphers HIGH:!aNULL:!MD5;"
      echo "    ssl_prefer_server_ciphers on;"
      echo "    add_header Strict-Transport-Security \"max-age=31536000\" always;"
      echo "    return 301 https://${APEX}\$request_uri;"
      echo "}"
      echo "$END_WWW"
    } | $SUDO tee -a "${target}.finalcut-site-new" >/dev/null
    $SUDO sh -c 'cat "$1" > "$2"' sh "${target}.finalcut-site-new" "$target"   # in place: keeps inode/owner/mode
    $SUDO rm -f "${target}.finalcut-site-new"
    log "edited ${target}:"
    $SUDO diff -u "$bk/target.conf" "$target" || true
  fi
  $SUDO "${NGINX_TEST[@]}"
  $SUDO "${RELOAD[@]}"
  if [[ "$SMOKE" == 1 ]]; then sleep 2; smoke_new "$snap"; fi
  trap - ERR
  rm -f "$snap"
  log "installed + reloaded + smoke ok"
}

do_rollback() {
  # Restores the state from before the FIRST install of this deploy id (a deploy may run install
  # more than once; later backups already contain this deploy's edits).
  local want="${1:-}" bk="" d
  [[ -f "${BACKUP_ROOT}/LAST" ]] || { log "no backup recorded; nothing to roll back"; return 0; }
  [[ -n "$want" ]] || want="$($SUDO cat "$($SUDO cat "${BACKUP_ROOT}/LAST")/DEPLOY_ID" 2>/dev/null || true)"
  for d in $(ls -1d "${BACKUP_ROOT}"/*/ 2>/dev/null | sort); do
    if [[ "$($SUDO cat "${d}DEPLOY_ID" 2>/dev/null || true)" == "$want" ]]; then bk="${d%/}"; break; fi
  done
  [[ -n "$bk" ]] || { log "no backup from deploy ${want}; nothing to roll back"; return 0; }
  restore "$bk"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  preflight) do_preflight "$@" ;;
  install) do_install "$@" ;;
  rollback) do_rollback "$@" ;;
  *) die "usage: $0 preflight|install <app_dir> | rollback [deploy_id]" ;;
esac
