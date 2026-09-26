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

- `commit`: resolved once at startup, in this order:
  1. the `GIT_COMMIT` env var;
  2. the `REVISION` file at the repo root. `scripts/deploy-grepawk.sh` writes it from
     `git rev-parse --short HEAD` on the checkout being deployed, adding `-dirty` when tracked
     files differ from HEAD, and rsyncs it to prod. It is gitignored;
  3. `git rev-parse --short HEAD`, but only when no `REVISION` file exists. The prod folder keeps
     a stale `.git` because rsync excludes `.git/`, so it must not win over `REVISION`;
  4. `null`. An empty `REVISION` file also gives `null`.
- `ffmpeg`: probed once at startup. `heic` is true when a real HEIC sample decodes with
  ffmpeg (`heicVia: "ffmpeg"`) or when `heif-convert` is installed (`heicVia: "heif-convert"`).
- `db`: `SELECT 1` with a 1s timeout, cached for 5s. Values are `"ok"`, `"error"`, or
  `"disabled"` (`MYSQL_DISABLED=true`). A DB error is reported but keeps HTTP 200.
- Status is **200** when healthy and **503** with `ok: false` when ffmpeg is missing
  (critical dependency).
