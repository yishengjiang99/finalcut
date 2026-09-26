# `GET /api/health`

No auth, no session, no rate limit, no quota, `Cache-Control: no-store`.

```json
{
  "ok": true,
  "version": "0.0.1",
  "commit": "771b91b",
  "uptimeSec": 3605,
  "ffmpeg": { "version": "4.4.2-0ubuntu0.22.04.1", "heic": false, "heicVia": null },
  "db": "ok"
}
```

- `commit`: `GIT_COMMIT` env, otherwise `git rev-parse --short HEAD` read once at startup, otherwise `null`.
- `ffmpeg`: probed once at startup. `heic` is true when a real HEIC sample decodes with
  ffmpeg (`heicVia: "ffmpeg"`) or when `heif-convert` is installed (`heicVia: "heif-convert"`).
- `db`: `SELECT 1` with a 1s timeout, cached for 5s. Values are `"ok"`, `"error"`, or
  `"disabled"` (`MYSQL_DISABLED=true`). A DB error is reported but keeps HTTP 200.
- Status is **200** when healthy and **503** with `ok: false` when ffmpeg is missing
  (critical dependency).
