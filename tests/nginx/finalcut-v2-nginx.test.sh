#!/usr/bin/env bash
# Harness for scripts/nginx/finalcut-v2-nginx.sh against a fake /etc/nginx with stubbed nginx/systemctl.
# Real `nginx -t` of the snippet is covered by the nginx-v2 job in .github/workflows/v2-editor.yml.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
SCRIPT="$REPO/scripts/nginx/finalcut-v2-nginx.sh"
fail=0; ok() { echo "ok   - $*"; }; bad() { echo "FAIL - $*"; fail=1; }

setup() {
  T="$(mktemp -d)"; export FINALCUT_NGINX_SUDO="" FINALCUT_NGINX_DIR="$T/etc/nginx" FINALCUT_NGINX_BACKUP_ROOT="$T/backups"
  mkdir -p "$T/etc/nginx/sites-available" "$T/etc/nginx/sites-enabled" "$T/etc/nginx/conf.d" "$T/bin" "$T/app/nginx" "$T/app/dist/v2"
  cp "$REPO"/nginx/finalcut-v2*.conf "$T/app/nginx/"; echo '<html>' > "$T/app/dist/v2/index.html"
  echo 'http { include sites-enabled/*; }' > "$T/etc/nginx/nginx.conf"
  cat > "$T/etc/nginx/sites-available/grepawk" <<CONF
server {
    listen 443 ssl;
    server_name grepawk.com;
    root $T/app/dist;
    location / { try_files \$uri /index.html; }
}
CONF
  cat > "$T/etc/nginx/sites-available/other" <<CONF
server { server_name other.example; root /srv/other; }
CONF
  ln -s ../sites-available/grepawk "$T/etc/nginx/sites-enabled/grepawk"
  ln -s ../sites-available/other "$T/etc/nginx/sites-enabled/other"
  cat > "$T/bin/nginx" <<'STUB'
#!/bin/sh
[ "$1" = "-v" ] && { echo "nginx version: nginx/1.18.0 (stub)" >&2; exit 0; }
[ -f "$STUB_DIR/nginx-t-fail" ] && { echo "nginx: [emerg] stub failure" >&2; exit 1; }
echo "nginx: configuration file test is successful" >&2; exit 0
STUB
  cat > "$T/bin/systemctl" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_DIR/systemctl.log"
[ -f "$STUB_DIR/reload-fail" ] && [ "$(cat "$STUB_DIR/reload-fail")" = once ] && { rm "$STUB_DIR/reload-fail"; exit 1; }
exit 0
STUB
  chmod +x "$T/bin/"*; export PATH="$T/bin:$PATH" STUB_DIR="$T"
  TARGET="$T/etc/nginx/sites-available/grepawk"; ORIG="$(cat "$TARGET")"; OTHER="$(cat "$T/etc/nginx/sites-available/other")"
}
reloads() { [ -f "$T/systemctl.log" ] && wc -l < "$T/systemctl.log" || echo 0; }

# 1. happy path + idempotent
setup
bash "$SCRIPT" preflight "$T/app" >/dev/null 2>&1 && ok "preflight passes" || bad "preflight"
bash "$SCRIPT" install "$T/app" > "$T/out" 2>&1 && ok "install succeeds" || { bad "install"; cat "$T/out"; }
[ "$(grep -c 'finalcut-v2.locations.conf' "$TARGET")" = 1 ] && ok "include added once" || bad "include count"
awk '/root .*\/dist;/{getline n; exit !(n ~ /^    include .*finalcut-v2.locations.conf;/)}' "$TARGET" && ok "include right after root, same indent" || bad "include placement"
[ -f "$T/etc/nginx/snippets/finalcut-v2.locations.conf" ] && [ -f "$T/etc/nginx/snippets/finalcut-v2-headers.conf" ] && ok "snippets installed" || bad "snippets"
[ "$(cat "$T/etc/nginx/sites-available/other")" = "$OTHER" ] && ok "other site untouched" || bad "other site changed"
[ -L "$T/etc/nginx/sites-enabled/grepawk" ] && ok "symlink preserved" || bad "symlink replaced"
[ "$(reloads)" = 1 ] && ok "reloaded once" || bad "reloads=$(reloads)"
bash "$SCRIPT" install "$T/app" >/dev/null 2>&1; [ "$(grep -c 'finalcut-v2.locations.conf' "$TARGET")" = 1 ] && ok "idempotent re-install" || bad "duplicate include"
bash "$SCRIPT" rollback >/dev/null 2>&1   # LAST now = backup taken during the 2nd install (already had include)
# 2. nginx -t fails after edit -> restored, no reload of the bad config
setup
touch "$T/nginx-t-fail.later"
# make nginx -t pass in preflight but fail after the edit: flip the flag when snippets appear
cat > "$T/bin/nginx" <<'STUB'
#!/bin/sh
[ "$1" = "-v" ] && exit 0
if [ -f "$FINALCUT_NGINX_DIR/snippets/finalcut-v2.locations.conf" ]; then echo "nginx: [emerg] stub" >&2; exit 1; fi
exit 0
STUB
chmod +x "$T/bin/nginx"
bash "$SCRIPT" install "$T/app" > "$T/out" 2>&1 && bad "install should fail" || ok "install fails when nginx -t fails"
[ "$(cat "$TARGET")" = "$ORIG" ] && ok "target restored byte-for-byte" || bad "target not restored"
[ ! -f "$T/etc/nginx/snippets/finalcut-v2.locations.conf" ] && ok "new snippets removed" || bad "snippet left behind"
grep -q 'rolling back' "$T/out" && ok "rollback logged" || bad "no rollback log"
# 3. reload fails once -> restored + reloaded
setup; echo once > "$T/reload-fail"
bash "$SCRIPT" install "$T/app" > "$T/out" 2>&1 && bad "install should fail" || ok "install fails when reload fails"
[ "$(cat "$TARGET")" = "$ORIG" ] && ok "target restored after reload failure" || bad "not restored"
# 4. explicit rollback after a good install
setup; bash "$SCRIPT" install "$T/app" >/dev/null 2>&1
bash "$SCRIPT" rollback >/dev/null 2>&1 && [ "$(cat "$TARGET")" = "$ORIG" ] && [ ! -f "$T/etc/nginx/snippets/finalcut-v2.locations.conf" ] && ok "rollback restores pre-install state" || bad "rollback"
# 4b. rollback scoped to a deploy id
setup; FINALCUT_DEPLOY_ID=run-1 bash "$SCRIPT" install "$T/app" >/dev/null 2>&1; AFTER="$(cat "$TARGET")"
bash "$SCRIPT" rollback run-2 >/dev/null 2>&1 && [ "$(cat "$TARGET")" = "$AFTER" ] && ok "rollback for another deploy id is a no-op" || bad "foreign rollback"
bash "$SCRIPT" rollback run-1 >/dev/null 2>&1 && [ "$(cat "$TARGET")" = "$ORIG" ] && ok "rollback for own deploy id restores" || bad "own rollback"
# 4c. preflight via stdin (as the workflow runs it) changes nothing
setup; bash -s -- preflight "$T/app" < "$SCRIPT" >/dev/null 2>&1 && [ ! -e "$T/etc/nginx/snippets" ] && [ ! -e "$T/backups" ] && [ "$(cat "$TARGET")" = "$ORIG" ] && ok "stdin preflight is read-only" || bad "stdin preflight"
# 4d. install refuses without dist/v2
setup; rm -rf "$T/app/dist/v2"; bash "$SCRIPT" install "$T/app" >/dev/null 2>&1 && bad "should refuse" || { [ "$(cat "$TARGET")" = "$ORIG" ] && ok "install refuses when dist/v2 missing"; }
# 5. ambiguous target -> preflight refuses, nothing changed
setup; cp "$T/etc/nginx/sites-available/grepawk" "$T/etc/nginx/conf.d/dup.conf"
bash "$SCRIPT" install "$T/app" > "$T/out" 2>&1 && bad "should refuse" || ok "refuses ambiguous target"
[ "$(cat "$TARGET")" = "$ORIG" ] && [ ! -d "$T/etc/nginx/snippets" -o ! -f "$T/etc/nginx/snippets/finalcut-v2.locations.conf" ] && ok "nothing changed" || bad "changed despite refusal"
# 6. current config broken -> refuse
setup; touch "$T/nginx-t-fail"
bash "$SCRIPT" preflight "$T/app" >/dev/null 2>&1 && bad "should refuse" || ok "refuses when current config fails nginx -t"
exit $fail
