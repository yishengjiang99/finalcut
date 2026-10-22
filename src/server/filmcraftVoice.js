// GET /api/filmcraft/voice/token — signed ElevenLabs Conversational AI URL for the FilmCraft voice agent.
// The ElevenLabs key never leaves the server; the browser gets a short-lived signed wss URL.
// Config: ELEVENLABS_API_KEY (needs convai_write/read scope) + FILMCRAFT_VOICE_AGENT_ID
// (create once with scripts/create-filmcraft-voice-agent.mjs). Kill switch: FILMCRAFT_VOICE_DISABLED=true -> 503.
import express from 'express';
import rateLimit from 'express-rate-limit';

export function createFilmcraftVoiceRouter({ env = process.env, fetchImpl = (...a) => fetch(...a) } = {}) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
  router.get('/api/filmcraft/voice/token', limiter, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const key = env.ELEVENLABS_API_KEY, agentId = env.FILMCRAFT_VOICE_AGENT_ID;
    if (env.FILMCRAFT_VOICE_DISABLED === 'true' || !key || !agentId) return res.status(503).json({ error: 'Voice editing is not configured.' });
    try {
      const r = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
        { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) { console.error(`[filmcraft_voice] signed url answered ${r.status}`); return res.status(502).json({ error: 'Voice service unavailable.' }); }
      const data = await r.json();
      if (typeof data?.signed_url !== 'string') return res.status(502).json({ error: 'Voice service unavailable.' });
      res.json({ signedUrl: data.signed_url, agentId });
    } catch (e) {
      console.error(`[filmcraft_voice] ${e?.name || 'error'}`);
      res.status(502).json({ error: 'Voice service unavailable.' });
    }
  });
  return router;
}
export const filmcraftVoiceRouter = createFilmcraftVoiceRouter();
