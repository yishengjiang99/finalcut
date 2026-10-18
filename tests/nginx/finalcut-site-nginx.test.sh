#!/usr/bin/env bash
# Real-nginx test of scripts/nginx/finalcut-site-nginx.sh against a copy of the PRODUCTION
# grepawk.com site file (nginx/test/live-site-finalcut.conf, captured read-only by
# server-inspect.yml) plus an unrelated vhost. Runs nginx as root on 127.0.0.1:80/443 in a scratch
# prefix (the installer's smoke checks use those ports), so run it on a CI runner or a scratch box.
#   sudo bash tests/nginx/finalcut-site-nginx.test.sh            # uses the local nginx
#   bash tests/nginx/finalcut-site-nginx.test.sh --docker        # ubuntu:22.04 nginx 1.18.0 (= prod)
# Needs a built dist/ (npm run build).
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
REPO="$PWD"
if [[ "${1:-}" == "--docker" ]]; then
  # Ubuntu 22.04 ships nginx 1.18.0, the same version as production.
  exec docker run --rm -e DEBIAN_FRONTEND=noninteractive -v "$REPO:/repo:ro" -w /repo ubuntu:22.04 \
    bash -c 'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends nginx curl openssl ca-certificates >/dev/null && bash /repo/tests/nginx/finalcut-site-nginx.test.sh'
fi
[[ $(id -u) -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
[[ -f dist/index.html && -f dist/404.html ]] || { echo "build dist/ first" >&2; exit 1; }

W="$(mktemp -d)"; E="$W/etc/nginx"; APP="$W/app"
mkdir -p "$E/sites-enabled" "$E/snippets" "$W/cert" "$W/www/photo" "$APP/nginx" "$W/backups"
cleanup() { nginx -c "$E/nginx.conf" -s stop 2>/dev/null || true; [[ -n "${KEEP:-}" ]] || rm -rf "$W"; }
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=grepawk.com \
  -keyout "$W/cert/privkey.pem" -out "$W/cert/fullchain.pem" >/dev/null 2>&1
ln -s "$REPO/dist" "$APP/dist"
rw() { sed -e "s#/etc/nginx#$E#g" -e "s#/etc/letsencrypt/live/grepawk.com#$W/cert#g" \
           -e "s#/home/finalcut/apps/pages/finalcut#$APP#g" -e "s#/var/www#$W/www#g" "$@"; }
for f in nginx/*.conf; do rw "$f" > "$APP/nginx/$(basename "$f")"; done
cp "$APP/nginx/finalcut-v2.locations.conf" "$APP/nginx/finalcut-v2-headers.conf" "$E/snippets/"
rw nginx/test/live-site-finalcut.conf > "$E/sites-enabled/finalcut"
echo ok > "$W/www/photo/index.html"
cat > "$E/sites-enabled/photo" <<CONF
server { listen 80; server_name photo.grepawk.com; return 301 https://\$host\$request_uri; }
server { listen 443 ssl; server_name photo.grepawk.com;
  ssl_certificate $W/cert/fullchain.pem; ssl_certificate_key $W/cert/privkey.pem;
  root $W/www/photo; location / { try_files \$uri \$uri/ =404; } }
CONF
cp /etc/nginx/mime.types "$E/mime.types"
cat > "$E/nginx.conf" <<CONF
user root; worker_processes 1; pid $W/nginx.pid; error_log $W/error.log;
events { worker_connections 256; }
http { include $E/mime.types; default_type application/octet-stream; access_log off;
  gzip on; include $E/sites-enabled/*; }
CONF
export FINALCUT_NGINX_DIR="$E" FINALCUT_SITE_BACKUP_ROOT="$W/backups" FINALCUT_NGINX_SUDO="" \
       FINALCUT_NGINX_TEST="nginx -t -q -c $E/nginx.conf" FINALCUT_NGINX_RELOAD="nginx -c $E/nginx.conf -s reload" \
       FINALCUT_DEPLOY_ID=ci
nginx -c "$E/nginx.conf"
sleep 1
H() { curl -sk -o /dev/null -D - --resolve "$1:443:127.0.0.1" "https://$1$2" -H 'Accept-Encoding: gzip' "${@:3}" | tr -d '\r'; }
C() { curl -sk -o /dev/null -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1$2"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
[[ "$(C grepawk.com /nope)" == 200 ]] || fail "baseline: unknown path should be SPA 200 before install"
md5_before="$(md5sum "$E/sites-enabled/finalcut" | cut -d' ' -f1)"

# 1. forced failure: snippet passes nginx -t but breaks "/" -> post-reload smoke must roll back
cp -r "$APP" "$W/bad"; rm "$W/bad/dist"; ln -s "$REPO/dist" "$W/bad/dist"
sed -i "s#$APP#$W/bad#g" "$E/sites-enabled/finalcut"; nginx -c "$E/nginx.conf" -s reload; sleep 1
md5_bad="$(md5sum "$E/sites-enabled/finalcut" | cut -d' ' -f1)"
echo 'location = / { return 500; }' >> "$W/bad/nginx/finalcut-site.conf"
if FINALCUT_DEPLOY_ID=fail1 bash scripts/nginx/finalcut-site-nginx.sh install "$W/bad"; then fail "smoke failure should fail install"; fi
[[ "$(md5sum "$E/sites-enabled/finalcut" | cut -d' ' -f1)" == "$md5_bad" ]] || fail "site file not restored after smoke failure"
[[ ! -e "$E/snippets/finalcut-site.conf" ]] || fail "snippet not removed on rollback"
# 2. forced failure: snippet fails nginx -t
printf 'bogus_directive on;\n' > "$W/bad/nginx/finalcut-site.conf"
if FINALCUT_DEPLOY_ID=fail2 bash scripts/nginx/finalcut-site-nginx.sh install "$W/bad"; then fail "broken snippet should fail install"; fi
[[ "$(md5sum "$E/sites-enabled/finalcut" | cut -d' ' -f1)" == "$md5_bad" ]] || fail "site file not restored after nginx -t failure"
sed -i "s#$W/bad#$APP#g" "$E/sites-enabled/finalcut"; nginx -c "$E/nginx.conf" -s reload; sleep 1
[[ "$(md5sum "$E/sites-enabled/finalcut" | cut -d' ' -f1)" == "$md5_before" ]] || fail "test fixture mismatch"
[[ "$(C grepawk.com /)" == 200 ]] || fail "nginx not serving after failed installs"

# 3. real install, then idempotent re-install
bash scripts/nginx/finalcut-site-nginx.sh preflight "$APP"
bash scripts/nginx/finalcut-site-nginx.sh install "$APP"
cp "$E/sites-enabled/finalcut" "$W/after1"
bash scripts/nginx/finalcut-site-nginx.sh install "$APP"
cmp -s "$W/after1" "$E/sites-enabled/finalcut" || fail "re-install changed the site file"
[[ "$(grep -c "snippets/finalcut-site.conf;" "$E/sites-enabled/finalcut")" == 1 ]] || fail "include not exactly once"
[[ "$(grep -c 'finalcut-v2.locations.conf' "$E/sites-enabled/finalcut")" == 1 ]] || fail "v2 include changed"

# 4. behaviour
h="$(H grepawk.com /)"; grep -qi '^strict-transport-security: max-age=31536000$' <<<"$h" || fail "HSTS missing on /"
grep -qi '^cross-origin-opener-policy: same-origin' <<<"$h" || fail "COOP on / changed (must stay as before)"
[[ "$(curl -sk --http2 -o /dev/null -w '%{http_version}' --resolve grepawk.com:443:127.0.0.1 https://grepawk.com/)" == 2 ]] || fail "no http2"
js="$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)"
h="$(H grepawk.com "$js")"; grep -qi '^content-encoding: gzip' <<<"$h" || fail "js not gzipped"
grep -qi 'immutable' <<<"$h" || fail "js not immutable"
mp4="$(ls dist/assets/*.mp4 | head -1)"; mp4="/assets/$(basename "$mp4")"
h="$(H grepawk.com "$mp4")"; grep -qi '^cache-control: public, max-age=31536000, immutable' <<<"$h" || fail "mp4 cache"
grep -qi '^strict-transport-security' <<<"$h" || fail "mp4 lost HSTS"; grep -qi '^x-content-type-options: nosniff' <<<"$h" || fail "mp4 lost nosniff"
[[ "$(C grepawk.com /nope)" == 404 ]] || fail "unknown path not 404"
curl -sk --resolve grepawk.com:443:127.0.0.1 https://grepawk.com/nope | grep -q 'noindex' || fail "custom 404 page"
[[ "$(C grepawk.com /success)" == 200 ]] || fail "/success"
[[ "$(C grepawk.com /legal/privacy.html)" == 200 ]] || fail "legal page"
for slug in add-subtitles translate-subtitles add-lyrics-to-video; do
  h="$(H grepawk.com "/$slug")"; grep -q '^HTTP/[0-9.]* 200' <<<"$h" || fail "/$slug not 200"
  grep -qi '^content-type: text/html' <<<"$h" || fail "/$slug not text/html"
  grep -qi '^strict-transport-security' <<<"$h" || fail "/$slug lost HSTS"
  curl -sk --resolve grepawk.com:443:127.0.0.1 "https://grepawk.com/$slug" | grep -q "<link rel=\"canonical\" href=\"https://grepawk.com/$slug\">" || fail "/$slug canonical"
  for v in "/$slug/" "/$slug.html"; do h="$(H grepawk.com "$v")"; grep -qi "^location: https\?://grepawk.com/$slug\$\|^location: /$slug\$" <<<"$h" || fail "$v redirect"; done
done
# Blog (scripts/build-blog.mjs): /blog, each post and rss.xml are 200 with server-level headers;
# slash / .html / index.html variants redirect to the clean URL.
[[ -f dist/blog/index.html ]] || fail "dist/blog/index.html missing"
h="$(H grepawk.com /blog)"; grep -q '^HTTP/[0-9.]* 200' <<<"$h" || fail "/blog not 200"
grep -qi '^content-type: text/html' <<<"$h" || fail "/blog not text/html"; grep -qi '^strict-transport-security' <<<"$h" || fail "/blog lost HSTS"
for v in /blog/ /blog/index.html; do h="$(H grepawk.com "$v")"; grep -qi '^location: \(https\?://grepawk.com\)\?/blog$' <<<"$h" || fail "$v redirect"; done
[[ "$(C grepawk.com /blog/rss.xml)" == 200 ]] || fail "/blog/rss.xml"
[[ "$(C grepawk.com /blog/no-such-post)" == 404 ]] || fail "/blog/no-such-post not 404"
for d in dist/blog/*/; do slug="$(basename "$d")"
  h="$(H grepawk.com "/blog/$slug")"; grep -q '^HTTP/[0-9.]* 200' <<<"$h" || fail "/blog/$slug not 200"
  grep -qi '^content-type: text/html' <<<"$h" || fail "/blog/$slug not text/html"
  curl -sk --resolve grepawk.com:443:127.0.0.1 "https://grepawk.com/blog/$slug" | grep -q "<link rel=\"canonical\" href=\"https://grepawk.com/blog/$slug\">" || fail "/blog/$slug canonical"
  for v in "/blog/$slug/" "/blog/$slug.html" "/blog/$slug/index.html"; do h="$(H grepawk.com "$v")"; grep -qi "^location: \(https\?://grepawk.com\)\?/blog/$slug\$" <<<"$h" || fail "$v redirect"; done
done
# Blog media: modern image types, immutable cache, byte ranges on video.
for f in $(ls dist/media/blog 2>/dev/null | grep -E '\.(avif|webp|mp4)$' | sort -t. -k2,2 -u); do
  h="$(H grepawk.com "/media/blog/$f")"; grep -q '^HTTP/[0-9.]* 200' <<<"$h" || fail "/media/blog/$f not 200"
  grep -qi '^cache-control: public, max-age=31536000, immutable' <<<"$h" || fail "/media/blog/$f cache"
  case "$f" in *.avif) grep -qi '^content-type: image/avif' <<<"$h" || fail "avif type";; *.webp) grep -qi '^content-type: image/webp' <<<"$h" || fail "webp type";;
    *.mp4) grep -qi '^content-type: video/mp4' <<<"$h" || fail "mp4 type"
      r="$(curl -sk -o /dev/null -D - -r 0-99 --resolve grepawk.com:443:127.0.0.1 "https://grepawk.com/media/blog/$f" | tr -d '\r')"; grep -q '^HTTP/[0-9.]* 206' <<<"$r" || fail "mp4 range not 206";; esac
done
h="$(H grepawk.com /lyric-captions)"; grep -qi 'location: .*/add-lyrics-to-video$' <<<"$h" || fail "/lyric-captions redirect"
k="$(ls dist/*.txt | grep -E '/[0-9a-f]{32}\.txt$' | head -1)"; [[ -n "$k" ]] || fail "IndexNow key file missing from dist"
[[ "$(curl -sk --resolve grepawk.com:443:127.0.0.1 "https://grepawk.com/$(basename "$k")")" == "$(basename "$k" .txt)" ]] || fail "IndexNow key file not served"
[[ "$(C grepawk.com /robots.txt)" == 200 ]] || fail "robots"
h="$(H grepawk.com /legal)"; grep -qi '^location: .*/legal/privacy.html' <<<"$h" || fail "/legal redirect"
h="$(H www.grepawk.com '/a?b=1')"; grep -qi '^location: https://grepawk.com/a?b=1$' <<<"$h" || fail "www redirect"
h="$(curl -s -o /dev/null -D - -H 'Host: www.grepawk.com' http://127.0.0.1/x | tr -d '\r')"; grep -qi '^location: https://grepawk.com/x$' <<<"$h" || fail "http www redirect"
[[ "$(C grepawk.com /v2/ffmpeg-core/mt/0.13.0-finalcut.3/ffmpeg-core.wasm)" == "$( [[ -f dist/v2/ffmpeg-core/mt/0.13.0-finalcut.3/ffmpeg-core.wasm ]] && echo 200 || echo 404)" ]] || fail "/v2 core"
[[ "$(C photo.grepawk.com /)" == 200 ]] || fail "other vhost"

# 5. rollback by deploy id restores the original file
bash scripts/nginx/finalcut-site-nginx.sh rollback other-id
cmp -s "$W/after1" "$E/sites-enabled/finalcut" || fail "rollback for another deploy id must be a no-op"
bash scripts/nginx/finalcut-site-nginx.sh rollback ci
[[ "$(md5sum "$E/sites-enabled/finalcut" | cut -d' ' -f1)" == "$md5_before" ]] || fail "rollback did not restore"
[[ "$(C grepawk.com /nope)" == 200 ]] || fail "rollback not live"
echo "site installer OK ($(nginx -v 2>&1)): smoke-fail rollback, nginx -t-fail rollback, install, idempotent, HSTS/h2/gzip/cache/404/redirects, other vhost, rollback"
