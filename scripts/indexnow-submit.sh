#!/usr/bin/env bash
# indexnow-submit.sh <host> <key> <sitemap.xml> : tell IndexNow (Bing, Yandex, Seznam, Naver, ...)
# that the URLs in the sitemap changed. Key file: https://<host>/<key>.txt (public by design).
# Never fails the caller: logs the HTTP status and response and always exits 0.
set -uo pipefail
host="$1"; key="$2"; sitemap="$3"
urls="$(grep -oE '<loc>[^<]+</loc>' "$sitemap" | sed -E 's#</?loc>##g' | grep -E "^https://${host//./\\.}/" || true)"
if [[ -z "$urls" ]]; then echo "indexnow: no $host URLs in $sitemap; skipped"; exit 0; fi
kf="$(curl -s -m 15 "https://$host/$key.txt" || true)"
if [[ "$kf" != "$key" ]]; then echo "indexnow: https://$host/$key.txt does not serve the key yet; skipped"; exit 0; fi
body="$(python3 -c 'import json,sys; h,k,u=sys.argv[1],sys.argv[2],sys.argv[3].split(); print(json.dumps({"host":h,"key":k,"keyLocation":f"https://{h}/{k}.txt","urlList":u}))' "$host" "$key" "$urls")"
echo "indexnow: submitting $(wc -w <<<"$urls") URL(s) for $host"
resp="$(curl -s -m 30 -o /tmp/indexnow-resp.txt -w '%{http_code}' -X POST https://api.indexnow.org/indexnow \
  -H 'Content-Type: application/json; charset=utf-8' --data "$body" || echo 000)"
echo "indexnow: HTTP $resp $(head -c 300 /tmp/indexnow-resp.txt 2>/dev/null)"
case "$resp" in 200|202) echo "indexnow: accepted";; *) echo "::warning title=IndexNow::submission for $host returned HTTP $resp (non-fatal)";; esac
exit 0
