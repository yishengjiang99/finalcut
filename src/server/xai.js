// xAI model ids. Use real ids from GET /v1/models, not retired names: xAI silently serves
// "grok-3" with grok-4.3, and removes old names later ("grok-beta" now returns 404).
export const XAI_CHAT_MODEL = process.env.XAI_CHAT_MODEL || 'grok-4.3';
// One-shot text jobs: caption translation, the FFmpeg CLI string, the lyric fallback.
export const XAI_UTILITY_MODEL = process.env.XAI_UTILITY_MODEL || 'grok-4.3';
export const XAI_CHAT_COMPLETIONS_URL = 'https://api.x.ai/v1/chat/completions';
