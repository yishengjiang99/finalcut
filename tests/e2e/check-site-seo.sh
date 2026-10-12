#!/usr/bin/env bash
# Post-deploy checks for the SEO / performance / server changes on the main site.
#   tests/e2e/check-site-seo.sh https://grepawk.com
# Optional: TELEMETRY_SMOKE_ID=deploy-smoke-<id> also POSTs one telemetry event with that anon_id
# (the caller deletes it on the server with scripts/telemetry-smoke-cleanup.mjs).
set -uo pipefail
BASE="${1:?base url}"; HOST="${BASE#https://}"; HOST="${HOST%%/*}"
fails=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
hdr() { curl -s -o /dev/null -D - -m 20 "$@" | tr -d '\r'; }
code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@"; }
expect_code() { local want="$1"; shift; local got; got="$(code "$@")"; [[ "$got" == "$want" ]] && ok "${*: -1} -> $got" || bad "${*: -1} -> $got (want $want)"; }
has() { grep -qiE "$2" <<<"$1" && ok "$3" || bad "$3"; }

html="$(curl -fsS -m 20 "$BASE/")"
h="$(hdr "$BASE/")"
has "$h" '^strict-transport-security: max-age=31536000$' "HSTS max-age=31536000 on /"
grep -qi '^strict-transport-security:.*preload' <<<"$h" && bad "HSTS must not preload" || ok "HSTS without preload"
[[ "$(curl -s -o /dev/null -m 20 --http2 -w '%{http_version}' "$BASE/")" == 2 ]] && ok "HTTP/2 on 443" || bad "HTTP/2 on 443"
has "$html" '<h1[ >]' "pre-rendered <h1> in the HTML"
[[ "$(grep -o '<h1[ >]' <<<"$html" | wc -l)" == 1 ]] && ok "exactly one <h1>" || bad "exactly one <h1>"
has "$html" '<link rel="canonical" href="https://grepawk.com/"' "canonical"
has "$html" 'property="og:image" content="https://grepawk.com/og/finalcap-og-1200x630.jpg"' "og:image"
has "$html" 'application/ld\+json' "JSON-LD"
grep -q 'sourceMappingURL' <<<"$html" && bad "sourcemap reference in HTML" || ok "no sourcemap in HTML"

# Static guide pages (scripts/build-task-pages.mjs): 200, one h1, own canonical, FAQPage JSON-LD,
# listed in the sitemap, linked from the landing page; old/variant URLs 301 to the clean URL.
sitemap="$(curl -fsS -m 20 "$BASE/sitemap.xml")"
for slug in add-subtitles translate-subtitles add-lyrics-to-video; do
  page="$(curl -fsS -m 20 "$BASE/$slug")" || { bad "/$slug not 200"; continue; }
  [[ "$(grep -o '<h1[ >]' <<<"$page" | wc -l)" == 1 ]] && ok "/$slug one <h1>" || bad "/$slug one <h1>"
  has "$page" "<link rel=\"canonical\" href=\"https://$HOST/$slug\">" "/$slug canonical"
  has "$page" '"@type":"FAQPage"' "/$slug FAQPage JSON-LD"
  has "$page" "page_view" "/$slug page_view telemetry"
  has "$sitemap" "<loc>https://$HOST/$slug</loc>" "/$slug in sitemap"
  has "$html" "href=\"/$slug\"" "/$slug linked from the landing page"
  expect_code 301 "$BASE/$slug/"
done
expect_code 301 "$BASE/lyric-captions"

# Blog (scripts/build-blog.mjs): /blog, every post listed in the sitemap, rss.xml; one h1, own
# canonical, BlogPosting JSON-LD on each post; /blog/ redirects to /blog.
blog="$(curl -fsS -m 20 "$BASE/blog")" && ok "/blog -> 200" || bad "/blog not 200"
has "$blog" "<link rel=\"canonical\" href=\"https://$HOST/blog\">" "/blog canonical"
has "$blog" '"@type":"Blog"' "/blog Blog JSON-LD"
has "$sitemap" "<loc>https://$HOST/blog</loc>" "/blog in sitemap"
expect_code 301 "$BASE/blog/"
expect_code 200 "$BASE/blog/rss.xml"
has "$(hdr "$BASE/blog/rss.xml")" '^content-type: (application|text)/(rss\+)?xml' "rss.xml xml"
posts="$(grep -oE "<loc>https://$HOST/blog/[a-z0-9-]+</loc>" <<<"$sitemap" | sed -E 's#</?loc>##g')"
[[ -n "$posts" ]] && ok "blog posts in sitemap ($(wc -l <<<"$posts"))" || bad "no blog posts in sitemap"
for u in $posts; do
  page="$(curl -fsS -m 20 "$u")" || { bad "$u not 200"; continue; }
  [[ "$(grep -o '<h1[ >]' <<<"$page" | wc -l)" == 1 ]] && ok "$u one <h1>" || bad "$u one <h1>"
  has "$page" "<link rel=\"canonical\" href=\"$u\">" "$u canonical"
  has "$page" '"@type":"BlogPosting"' "$u BlogPosting JSON-LD"
  has "$blog" "href=\"/blog/${u##*/}\"" "$u linked from /blog"
done

js="$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' <<<"$html" | head -1)"
if [[ -n "$js" ]]; then
  h="$(hdr -H 'Accept-Encoding: gzip, br' "$BASE$js")"
  has "$h" '^content-encoding: (gzip|br)' "main JS compressed"
  has "$h" '^cache-control:.*immutable' "main JS immutable cache"
  curl -s -m 30 "$BASE$js" | tail -c 300 | grep -q 'sourceMappingURL' && bad "main JS has a sourceMappingURL" || ok "main JS has no sourcemap"
  expect_code 404 "$BASE$js.map"
else bad "main JS not found in HTML"; fi
mp4="$(curl -s -m 30 "$BASE$js" | grep -oE '/assets/[A-Za-z0-9_.-]+\.mp4' | head -1)"
[[ -z "$mp4" ]] && mp4="$(grep -oE '/assets/[A-Za-z0-9_.-]+\.mp4' <<<"$html" | head -1)"
if [[ -n "$mp4" ]]; then has "$(hdr "$BASE$mp4")" '^cache-control: public, max-age=31536000, immutable' "hero video long cache ($mp4)"; else bad "hero video URL not found"; fi
css="$(grep -oE '/assets/[A-Za-z0-9_.-]+\.css' <<<"$html" | head -1)"
[[ -n "$css" ]] && has "$(hdr -H 'Accept-Encoding: gzip' "$BASE$css")" '^content-encoding: gzip' "CSS gzip"

h="$(hdr "$BASE/robots.txt")"; has "$h" '^content-type: text/plain' "robots.txt text/plain"
has "$(curl -s -m 20 "$BASE/robots.txt")" '^Sitemap: https://grepawk.com/sitemap.xml' "robots.txt sitemap line"
h="$(hdr "$BASE/sitemap.xml")"; has "$h" '^content-type: (application|text)/xml' "sitemap.xml xml"
expect_code 404 "$BASE/this-page-does-not-exist-$RANDOM"
expect_code 200 "$BASE/success"
has "$(hdr "$BASE/legal")" '^location: .*/legal/privacy\.html' "/legal -> /legal/privacy.html"
expect_code 200 "$BASE/legal/privacy.html"
expect_code 200 "$BASE/og/finalcap-og-1200x630.jpg"
has "$(hdr "$BASE/og/finalcap-og-1200x630.jpg")" '^content-type: image/jpeg' "OG image is a JPEG"
expect_code 200 "$BASE/favicon.ico"
expect_code 200 "$BASE/site.webmanifest"

h="$(hdr "https://www.$HOST/x?y=1")"
has "$h" '^HTTP/[0-9.]+ 301' "https://www -> 301"; has "$h" "^location: https://$HOST/x\\?y=1\$" "https://www -> apex, path kept"
h="$(hdr "http://$HOST/x")"; has "$h" "^location: https://$HOST/x\$" "http:// apex -> https apex"
h="$(hdr "http://www.$HOST/x")"; has "$h" "^location: https://$HOST/x\$" "http://www -> https apex (one hop)"

# /v2 belongs to the v2 workstream (gated by check-v2-headers.sh); informational here.
echo "info /v2 -> $(code "$BASE/v2"), /v2/ -> $(code "$BASE/v2/")"

if [[ -n "${TELEMETRY_SMOKE_ID:-}" ]]; then
  got="$(curl -s -o /dev/null -D - -m 20 -X POST -H 'Content-Type: application/json' \
    --data "{\"event\":\"landing_view\",\"anon_id\":\"$TELEMETRY_SMOKE_ID\",\"platform\":\"web\",\"props\":{\"path\":\"/\"}}" \
    "$BASE/api/telemetry" | tr -d '\r')"
  has "$got" '^HTTP/[0-9.]+ 204' "POST /api/telemetry -> 204 (stored)"
  grep -qi '^set-cookie' <<<"$got" && bad "telemetry response sets a cookie" || ok "telemetry sets no cookie"
  expect_code 400 -X POST -H 'Content-Type: application/json' --data '{"event":"nope","anon_id":"x"}' "$BASE/api/telemetry"
fi

echo "site checks: $fails failure(s)"
[[ $fails -eq 0 ]]
