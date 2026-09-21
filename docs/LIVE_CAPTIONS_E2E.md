# Live captions E2E (grepawk.com)

Offline-safe by default. Hits production FinalCut when enabled.

```bash
FINALCUT_LIVE_E2E=1 npm run test:live-captions
```

Optional base URL (default `https://grepawk.com`):

```bash
FINALCUT_LIVE_E2E=1 FINALCUT_LIVE_BASE_URL=https://grepawk.com npm run test:live-captions
```

Flow covered:

1. `GET /api/sample-access-token`
2. Silent fixture → `POST /api/generate-captions` expects **422**
3. Speech fixture → generate → `POST /api/translate-captions` (`srtContent` / `targetLanguage: es`) → timestamps preserved
4. Sync multipart `POST /api/process-video` `burn_subtitles` (not `/api/jobs/...`)

Requires prod `ALLOW_UNAUTH_SAMPLE_MODE` and OpenAI/xAI keys on the box.
