# iOS suggestion pills: `GET /api/ios/suggestions`

These are server-driven suggestion pills for the FinalCap iOS app. The endpoint needs no auth
(it works before login), uses no session or database, and has its own per-IP rate limiter
(120 requests per 15 min).

```
GET /api/ios/suggestions?build=<n>&media=video|photo
```

```json
{"suggestions":[{"id":"v-trim-15","label":"Trim to 15s","prompt":"Trim the video to the first 15 seconds.","icon":"scissors"}],"ttl":3600}
```

- The response carries `Cache-Control: public, max-age=<ttl>`.
- `icon` is an SF Symbol name. It is left out when the entry has none.
- Pills come back in config order, and the app shows them in that order.
- `media` defaults to `video` when it is missing or invalid.
- A missing or non-numeric `build` is treated as **10**, the smallest on-device tool set.

## Config

The repo default is `config/ios-suggestions.json`:

```json
{
  "ttl": 3600,
  "video": [ { "id": "v-trim-15", "label": "Trim to 15s", "prompt": "Trim the video to the first 15 seconds.", "icon": "scissors", "tools": ["trim_video"] } ],
  "photo": [ { "id": "p-bw", "label": "Black and white", "prompt": "Make the photo black and white.", "icon": "circle.lefthalf.filled", "tools": ["apply_color_filter"], "minBuild": 10 } ]
}
```

- **Media:** which array an entry is in (`video` or `photo`) decides its media. The older shape,
  `{ "suggestions": [ { ..., "media": ["video", "photo"] } ] }`, is also accepted.
- **Required fields:**
  - `id`: non-empty and unique within its media.
  - `label`: non-empty, at most 24 characters.
  - `prompt`: non-empty, at most 500 characters.
  - `tools`: a non-empty list of known tool names. These are the `src/tools.js` tools plus the
    iOS-only grouped tools, such as `color_adjust`.
- **Optional fields:** `icon`, and `minBuild` / `maxBuild` (both inclusive).
- **`ttl`:** an integer from 0 to 86400. The default is 3600.
- **Internal fields:** `tools`, `media`, `minBuild` and `maxBuild` are never sent to the app.
- **Invalid entries** are skipped, and the server logs a warning.

## Filtering

A pill is returned only when all of these hold:

1. It is in the requested media's list.
2. `build` is within its optional `minBuild` / `maxBuild`.
3. **At least one** of its `tools` is offered to `FinalCap-iOS/<build>` for that media.

Rule 3 uses the same allowlist as `/api/chat` and `/api/tools/schema`
(`src/server/iosToolAllowlist.js`: `minBuild`/`maxBuild`, `GROUPED_EFFECTS_MIN_BUILD`, and
photo/video media types). For example, `["adjust_brightness", "color_adjust"]` keeps showing after
the `adjust_*` tools retire at the grouped-effects cutoff. A video-only tool never shows a pill for
photos. Builds with no on-device tools (9 and below) get an empty list.

## Live override on prod: `IOS_SUGGESTIONS_PATH`

Deploys `rsync --delete` into `/home/finalcut/apps/pages/finalcut`, keeping only `.env*`. So a
config edited inside the app dir is wiped. Keep the live copy outside it:

1. Create the file:
   `sudo -u finalcut mkdir -p /home/finalcut/config && sudo -u finalcut cp /home/finalcut/apps/pages/finalcut/config/ios-suggestions.json /home/finalcut/config/ios-suggestions.json`
2. Add `IOS_SUGGESTIONS_PATH=/home/finalcut/config/ios-suggestions.json` to the app `.env`, then
   run `sudo systemctl restart finalcut`. This restart is needed once, to load the env var.
3. After that, edit the file in place. No restart is needed: the server checks the file's mtime at
   most every 5 s, and clients pick up the change when their `ttl` cache expires. The service user
   `finalcut` must be able to read the file.

If the override is missing, isn't valid JSON, has the wrong shape, or has no valid entries, the
server logs a warning and serves the repo default. It never returns a 500.

## Admin API: change the pills without a prod shell

The same override file can be read and replaced over HTTP, so changing the pills does not need
shell access to prod. There is no database table: storage is the JSON file at `IOS_SUGGESTIONS_PATH`.

| Route | What it does |
| --- | --- |
| `GET /api/admin/ios-suggestions` | The effective config, i.e. what the public endpoint serves now, with `source` (`override` or `default`), `etag`, `overrideConfigured` and `writable`. |
| `PUT /api/admin/ios-suggestions` | Validates the body, then atomically writes the override file. |
| `PUT /api/admin/ios-suggestions?dryRun=1` | Validation only. Writes nothing. Says whether a real PUT would be able to write (`wouldWrite`). |
| `GET /api/admin/ios-suggestions/preview?build=<n>&media=video\|photo` | Exactly what that build gets from `GET /api/ios/suggestions` (`response`), the tools offered to it, and why each other pill is hidden (`hidden`). |

### Auth and exposure

- `Authorization: Bearer <ADMIN_API_TOKEN>`, compared in constant time.
- While `ADMIN_API_TOKEN` is unset, empty or shorter than 24 characters, **every admin route returns
  404**, so nothing is exposed by default.
- A wrong or missing token is a 401 with no detail. The routes have their own rate limits: 30
  requests per 15 min per IP, and a client with 10 failed (401) attempts in 15 min is cut off (429).
  Validation errors (400) do not count as failed attempts.
- The token and the request body are never logged or echoed back. The only log line on success is
  the entry counts and `ttl`. Responses are `Cache-Control: no-store`.
- The body limit is 64 KB (413 above that). Malformed JSON is a 400 `invalid_json`.

### PUT body

`{ "ttl": 3600, "video": [ ... ], "photo": [ ... ] }`. It replaces the whole config, so GET the
current one first and edit it. Unlike the file loader (which skips bad entries with a warning), the
API **rejects the whole body** and lists every problem as `{path, message}`:

- `ttl`: integer 0–86400 (3600 if left out). `video` and `photo` are required arrays (`[]` hides
  everything for that media). No other top-level keys; the old `suggestions` shape is not accepted.
- At most 40 entries per media. Unknown entry keys are rejected, so a typo like `minbuild` is caught.
- `id`: 1–64 characters (letters, digits, `.`, `_`, `-`), unique within its media.
- `label`: 1–24 characters. `prompt`: 1–500 characters. No control characters in `label`.
- `icon` (optional): an SF Symbol name.
- `tools`: a non-empty list of known tool names, at most 12, no duplicates. This is an **any-of**
  list: the pill shows for a build when at least one of these tools is offered to it for that media
  (same rule as the public endpoint). The response carries a `warnings` entry when none of the tools
  is on the iOS allowlist at all.
- `minBuild` / `maxBuild` (optional, inclusive integers): the pill is **hidden for builds below
  `minBuild`** (and above `maxBuild`). `minBuild` must not exceed `maxBuild`. Use `minBuild` to
  show a pill only from the build that ships its feature, in addition to `tools`.

### How the write works

1. The body is validated, and the override path is checked: `IOS_SUGGESTIONS_PATH` must be set
   (else 503 `override_path_not_set`) and its directory must exist and be writable by the service
   user (else 503 `override_path_not_writable`). Nothing is written when either check fails.
2. The new JSON is written to a temp file in the same directory and fsync'd. The current override
   is copied to `<file>.bak` (only the previous version is kept). Then the temp file is renamed over
   the override, which is atomic. On any failure the old file stays and the temp file is removed (500
   `write_failed`).
3. Writes are serialized in the process. Send `If-Match: <etag from GET>` to refuse the write when
   someone else changed the config in between (412); omit it to overwrite.
4. The process that handled the PUT serves the new pills at once. Any other process picks the
   change up within about 5 s (the same mtime check as a hand edit). iOS clients refresh when their cached `ttl` expires, so lower `ttl` first if you
   need a change to land sooner.

To roll back, PUT the previous config again, or on the server run
`sudo -u finalcut cp /home/finalcut/config/ios-suggestions.json.bak /home/finalcut/config/ios-suggestions.json`.

### Prod setup (once)

1. Make the override file and a directory the service user can write. The directory itself must be
   writable, because the update writes a temp file next to the override:
   ```
   sudo mkdir -p /home/finalcut/config
   sudo cp -n /home/finalcut/apps/pages/finalcut/config/ios-suggestions.json /home/finalcut/config/ios-suggestions.json
   sudo chown -R finalcut:finalcut /home/finalcut/config
   sudo chmod 755 /home/finalcut/config && sudo chmod 644 /home/finalcut/config/ios-suggestions.json
   ```
2. Generate a long random token **on your own machine** (`openssl rand -hex 32`) and keep it in your
   password manager. Do not paste it into chat, tickets or git.
3. Add both lines to `/home/finalcut/apps/pages/finalcut/.env` (deploys keep `.env*`):
   ```
   IOS_SUGGESTIONS_PATH=/home/finalcut/config/ios-suggestions.json
   ADMIN_API_TOKEN=<the token>
   ```
   Check without printing the secrets:
   `sudo grep -c -E '^(IOS_SUGGESTIONS_PATH|ADMIN_API_TOKEN)=.+' /home/finalcut/apps/pages/finalcut/.env` should print `2`.
4. Restart once to load the env vars: `sudo systemctl restart finalcut`.
5. Check: `curl -s -o /dev/null -w '%{http_code}\n' https://YOUR_HOST/api/admin/ios-suggestions` prints
   `401` (enabled; `404` means the token is unset or shorter than 24 characters), and the same call
   with the Bearer header (below) prints `200` with `"writable": true`.

To turn the admin API off again, remove `ADMIN_API_TOKEN` from `.env` and restart: the routes go
back to 404.

### curl example

```bash
export HOST=https://YOUR_HOST
export ADMIN_API_TOKEN='<your admin token>'   # placeholder: never commit the real value

# 1. Read what is served now (save it, edit it)
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" "$HOST/api/admin/ios-suggestions" \
  | jq '.config' > pills.json

# 2. Validate only
curl -s -X PUT -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'Content-Type: application/json' \
  --data @pills.json "$HOST/api/admin/ios-suggestions?dryRun=1"

# 3. Write it (optionally with If-Match: "<etag from step 1>")
curl -s -X PUT -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'Content-Type: application/json' \
  --data @pills.json "$HOST/api/admin/ios-suggestions"

# 4. See what build 14 gets for a video
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "$HOST/api/admin/ios-suggestions/preview?build=14&media=video" | jq '.response, .hidden'
```

Example pill that only shows from build 15 (and only when `lyric_captions` is offered to that build):

```json
{ "id": "v-zh-captions", "label": "Chinese captions", "prompt": "Add captions in Chinese.", "icon": "captions.bubble", "tools": ["lyric_captions"], "minBuild": 15 }
```

Error codes: 400 `invalid_suggestions` (with `errors`), 400 `invalid_json`, 401 `unauthorized`, 404
(disabled), 412 `precondition_failed`, 413 `body_too_large`, 429 `rate_limited`, 503
`override_path_not_set` / `override_path_not_writable`, 500 `write_failed`.
