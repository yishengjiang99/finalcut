// JSON body limits. Every JSON route gets a small default; only the routes whose clients really send
// large JSON get more:
//   /api/chat, /api/v2/chat  web + iOS chat: up to 4 base64 JPEG thumbnails of <= 300 KB each
//                            (clientExecution.js MAX_THUMBNAILS/MAX_THUMBNAIL_BYTES, ~1.6 MB encoded),
//                            plus conversation history and the project snapshot.
//   /api/translate-captions, /api/streaming-captions/translate  whole caption tracks (SRT / segments).
// Media uploads are multipart (multer, own limits) and never go through these parsers.
import express from 'express';

export const DEFAULT_JSON_LIMIT = '1mb';
export const LARGE_JSON_ROUTES = Object.freeze({
  '/api/chat': '16mb',
  '/api/v2/chat': '16mb',
  '/api/translate-captions': '10mb',
  '/api/streaming-captions/translate': '10mb',
});

export function jsonBodyParser({ defaultLimit = DEFAULT_JSON_LIMIT, routes = LARGE_JSON_ROUTES } = {}) {
  const fallback = express.json({ limit: defaultLimit });
  const byPath = new Map(Object.entries(routes).map(([p, limit]) => [p, express.json({ limit })]));
  return (req, res, next) => (byPath.get(req.path) || fallback)(req, res, next);
}
