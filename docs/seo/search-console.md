# Google Search Console + Bing Webmaster Tools for grepawk.com (FinalCap)

The site already serves what the consoles need: `https://grepawk.com/robots.txt` (with a `Sitemap:`
line), `https://grepawk.com/sitemap.xml`, a canonical URL on every page and real 404s.

## 1. Verify the site in Google Search Console

Pick ONE of these.

### Option A, recommended: Domain property (DNS TXT record)
Covers https/http and www/apex at once.
1. Open https://search.google.com/search-console and sign in with the Google account that should own the site.
2. Click the property menu (top left), then **Add property**, then **Domain**. Enter `grepawk.com` and click **Continue**.
3. Google shows a TXT record like `google-site-verification=AbC123...`. Copy it.
4. In the DNS provider for grepawk.com (the domain's nameservers; if they are DigitalOcean, that is
   DigitalOcean > Networking > Domains > grepawk.com), add a record:
   type **TXT**, host/name **@**, value the full `google-site-verification=...` string, TTL default (3600).
5. Wait a few minutes (up to an hour), go back to Search Console and click **Verify**.

### Option B: URL-prefix property (HTML file)
Covers `https://grepawk.com/` only. Use this if DNS is hard to change.
1. In Search Console: **Add property**, then **URL prefix**, then enter `https://grepawk.com/` and click **Continue**.
2. Under **HTML file**, download the file. It is named like `google1234567890abcdef.html`.
3. Send that file name (or the file) to the agent/engineer. It goes into `public/` unchanged, e.g.
   `public/google1234567890abcdef.html`, containing exactly the line Google gave:
   `google-site-verification: google1234567890abcdef.html`
4. Push to `main`. The Deploy grepawk.com workflow ships it. Check
   `https://grepawk.com/google1234567890abcdef.html` returns that line (200), then click **Verify**.
   Keep the file in `public/` forever; removing it unverifies the property.

## 2. Submit the sitemap (after verification)
1. In Search Console, open the grepawk.com property, then **Indexing > Sitemaps**.
2. Under **Add a new sitemap**, enter `sitemap.xml` (full URL `https://grepawk.com/sitemap.xml`) and click **Submit**.
3. Status should become **Success** within minutes to a day. "Couldn't fetch" right after submitting is normal; check again later.
4. Optional: **URL inspection**, paste `https://grepawk.com/`, then **Request indexing**.

## 3. Bing Webmaster Tools (also feeds DuckDuckGo, Yahoo, ChatGPT search)
1. Open https://www.bing.com/webmasters and sign in.
2. Choose **Import from Google Search Console** and authorize. It imports the verified site and its sitemap. Nothing else is needed.
3. Alternative without Google: **Add site** `https://grepawk.com/`, then verify with a DNS CNAME/TXT or an
   XML file (`BingSiteAuth.xml`, which goes into `public/` the same way as the Google file), then
   **Sitemaps > Submit sitemap** `https://grepawk.com/sitemap.xml`.

## 4. What to watch afterwards
- **Pages** (Indexing > Pages): `/` and `/legal/*` should be "Indexed". Unknown paths now return 404 and should not be indexed.
- **Performance**: queries such as "ai video editor", "edit video in browser", "add captions to video", "crop video to 9:16".
- **Core Web Vitals** report, once there is enough traffic.

## Updating the sitemap
`public/sitemap.xml` is static. When a new public page is added, add a `<url>` entry and update
`<lastmod>`. Search engines re-read it on their own; there is no need to resubmit.
