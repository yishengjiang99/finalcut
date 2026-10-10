#!/usr/bin/env bash
# Runs the production installer (scripts/nginx/finalcut-v2-nginx.sh) inside a real nginx:1.18.0
# container (same major as production): preflight, install, idempotent re-install, /v2 headers,
# existing routes unchanged, and a forced failure (broken snippet) that must be restored with nginx
# still serving. Needs docker and a built dist/ (npm run build && npm run build:v2).
#   tests/nginx/installer-docker.sh [port]
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT="${1:-8082}"; NAME="finalcut-ngx-inst-$$"; W="$(mktemp -d)"
trap 'docker logs "$NAME" 2>&1 | tail -20 || true; docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
sed 's#__V2_INCLUDE__##' nginx/test/nginx.test.conf.tmpl > "$W/seed.conf"
docker run -d --name "$NAME" -p "$PORT:8080" -v "$W/seed.conf:/tmp/seed.conf:ro" \
  -v "$PWD/dist:/srv/dist:ro" -v "$PWD/nginx:/srv/nginx:ro" -v "$PWD/scripts/nginx:/opt/inst:ro" \
  nginx:1.18.0 sh -c 'cp /tmp/seed.conf /etc/nginx/nginx.conf && exec nginx -g "daemon off;"' >/dev/null
B="http://127.0.0.1:$PORT"
for i in $(seq 1 30); do curl -fs "$B/" >/dev/null && break; sleep 1; done
tests/e2e/compare-route-headers.sh --dump "$B" > "$W/before.txt"
ex() { docker exec -e FINALCUT_NGINX_RELOAD="nginx -s reload" -e FINALCUT_DEPLOY_ID=ci "$NAME" bash /opt/inst/finalcut-v2-nginx.sh "$@"; }
ex preflight /srv
ex install /srv
ex install /srv
[[ "$(docker exec "$NAME" grep -c finalcut-v2.locations.conf /etc/nginx/nginx.conf)" == 1 ]] || { echo "include not added exactly once" >&2; exit 1; }
sleep 1
tests/e2e/check-v2-headers.sh "$B"
tests/e2e/compare-route-headers.sh "$W/before.txt" "$B"
# Forced failure: point the site at an app dir whose snippet is broken; install must fail, restore
# the config byte-for-byte, and nginx must keep serving.
docker exec "$NAME" sh -c 'mkdir -p /tmp/bad/nginx /tmp/bad/dist/v2 && echo "location /v2/ { bogus_directive on; }" > /tmp/bad/nginx/finalcut-v2.locations.conf && cp /srv/nginx/finalcut-v2-headers.conf /tmp/bad/nginx/ && touch /tmp/bad/dist/v2/index.html && sed -i "s#root /srv/dist;#root /tmp/bad/dist;#" /etc/nginx/nginx.conf && nginx -s reload'
sleep 1
pre="$(docker exec "$NAME" sh -c 'md5sum /etc/nginx/nginx.conf /etc/nginx/snippets/*')"
if ex install /tmp/bad; then echo "install of a broken snippet should have failed" >&2; exit 1; fi
post="$(docker exec "$NAME" sh -c 'md5sum /etc/nginx/nginx.conf /etc/nginx/snippets/*')"
[[ "$pre" == "$post" ]] || { echo "config not restored after failed install" >&2; diff <(echo "$pre") <(echo "$post"); exit 1; }
docker exec "$NAME" nginx -t
curl -fsS -o /dev/null "$B/index.html"
echo "installer OK (nginx 1.18): preflight, install, idempotent, /v2 headers, existing routes unchanged, broken snippet restored"
