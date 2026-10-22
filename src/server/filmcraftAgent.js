// POST /api/filmcraft/agent — natural language -> filmcraft tool calls (docs/filmcraft-agent.md).
// The server only PLANS: it returns calls the browser runs via window.filmcraft.execute/request.
// Stateless: multi-step plans post results back in `history`. Kill switch: FILMCRAFT_AGENT_DISABLED=true.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { readFileSync } from 'fs';
import { XAI_API_TOKEN } from './config.js';
import { XAI_UTILITY_MODEL, XAI_CHAT_COMPLETIONS_URL } from './xai.js';

export const CATALOG = JSON.parse(readFileSync(new URL('./filmcraft/catalog.json', import.meta.url), 'utf8'));
const BY_KEY = new Map(CATALOG.map(e => [`${e.kind}:${e.id}`, e]));
const BY_ID = new Map(CATALOG.map(e => [e.id, e]));

export const LIMITS = { prompt: 2000, state: 12000, history: 8, historyChars: 8000, calls: 20, tools: 40,
  snapshotChars: 10000, tracks: 24, clipsPerTrack: 40, media: 60, steps: 6 };

const num = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : undefined);
const str = (v, n = 80) => (v === undefined || v === null ? undefined : String(v).slice(0, n));
/** Keep the first and last clips of a long track, with a marker for the elided middle. */
function headTail(list, max) {
  if (list.length <= max) return { items: list, omitted: 0 };
  const h = Math.ceil(max / 2);
  return { items: [...list.slice(0, h), ...list.slice(list.length - (max - h))], omitted: list.length - max };
}

/**
 * Normalize the client's compact project snapshot (docs/filmcraft-agent.md) and cap its size.
 * Shape: {tracks:[{id,kind:'video'|'audio',index,name,muted,locked,clips:[{id,name,source,start,end,in,out}]}],
 *         media:[{name,type,duration}], playhead?, duration?}. Times are seconds.
 */
export function compactSnapshot(raw, { clipsPerTrack = LIMITS.clipsPerTrack, maxChars = LIMITS.snapshotChars } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const build = per => {
    const tracks = (Array.isArray(raw.tracks) ? raw.tracks : []).slice(0, LIMITS.tracks).map((t, i) => {
      const { items, omitted } = headTail(Array.isArray(t?.clips) ? t.clips : [], per);
      const out = { id: str(t?.id ?? `${t?.kind === 'audio' ? 'A' : 'V'}${(t?.index ?? i) + 1}`, 40), kind: t?.kind === 'audio' ? 'audio' : 'video',
        index: Number.isInteger(t?.index) ? t.index : i, name: str(t?.name), muted: t?.muted ? true : undefined, locked: t?.locked ? true : undefined,
        clips: items.map(c => ({ id: str(c?.id, 40), name: str(c?.name), source: str(c?.source, 120),
          start: num(c?.start), end: num(c?.end), in: num(c?.in), out: num(c?.out) })) };
      if (omitted) out.omittedClips = omitted;
      return out;
    });
    const media = (Array.isArray(raw.media) ? raw.media : []).slice(0, LIMITS.media)
      .map(m => ({ name: str(m?.name, 120), type: str(m?.type, 20), duration: num(m?.duration) }));
    return { tracks, media, playhead: num(raw.playhead), duration: num(raw.duration) };
  };
  let snap = build(clipsPerTrack);
  while (JSON.stringify(snap).length > maxChars && clipsPerTrack > 2) snap = build(clipsPerTrack = Math.floor(clipsPerTrack / 2));
  if (JSON.stringify(snap).length > maxChars) snap.media = snap.media.slice(0, 10);
  return snap;
}

/** Clip/track ids known to the snapshot (track ids also match by name, case-insensitive). */
function snapshotIds(snap) {
  const clips = new Set(), tracks = new Set(), partial = snap.tracks.some(t => t.omittedClips);
  for (const t of snap.tracks) {
    tracks.add(String(t.id).toLowerCase()); if (t.name) tracks.add(t.name.toLowerCase());
    for (const c of t.clips) if (c.id !== undefined) clips.add(String(c.id));
  }
  return { clips, tracks, partial };
}

/** Return a reason when params reference a clip/track id the snapshot does not have. */
export function checkRefs(params, snap) {
  if (!snap || !snap.tracks.length) return null;
  const ids = snapshotIds(snap);
  const clipRefs = [params.clip, ...(Array.isArray(params.clips) ? params.clips : [])].filter(v => v !== undefined && typeof v !== 'object');
  if (!ids.partial) for (const c of clipRefs) if (!ids.clips.has(String(c))) return `clip ${c} is not in the project snapshot`;
  const t = params.track;
  if (t !== undefined && typeof t !== 'object' && !ids.tracks.has(String(t).toLowerCase())) return `track ${t} is not in the project snapshot`;
  return null;
}
const TICKS_PER_SECOND = 254_016_000_000;

// Always offered: the commands most edits need.
const PINNED = ['playhead.set', 'timeline.razor', 'captions.add', 'captions.newTrack', 'sequence.applyVideoTransition',
  'sequence.applyAudioTransition', 'export.quick', 'export.presets.list', 'ui.inspect', 'edit.undo', 'edit.selectAll'];
const SYNONYMS = {
  cut: ['razor', 'split', 'trim'], split: ['razor'], slice: ['razor'], fade: ['transition', 'dissolve', 'fade'],
  dissolve: ['transition'], caption: ['captions', 'text'], subtitle: ['captions'], subtitles: ['captions'],
  title: ['graphics', 'text'], text: ['graphics', 'captions'], export: ['export', 'quick', 'preset'], render: ['export'],
  save: ['export', 'project'], '1080p': ['export', 'preset'], mp4: ['export', 'format'], volume: ['mixer', 'audio', 'gain'],
  louder: ['gain', 'audio'], quieter: ['gain', 'audio'], mute: ['mute', 'audio'], color: ['lumetri', 'color'],
  blur: ['effects', 'gaussian'], speed: ['speed', 'duration'], delete: ['delete', 'clear', 'remove'], remove: ['delete', 'remove'],
  undo: ['undo', 'history'], play: ['playback'], seconds: ['playhead'], start: ['playhead', 'start'], marker: ['markers'],
};

const tokens = s => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];

/** Keyword retrieval over the catalog: returns up to `max` entries, pinned ones first. */
export function selectTools(prompt, max = LIMITS.tools) {
  const words = new Set();
  for (const t of tokens(prompt)) { words.add(t); for (const s of SYNONYMS[t] || []) words.add(s); }
  const scored = [];
  for (const e of CATALOG) {
    const idT = tokens(e.id), dT = tokens(`${e.d} ${e.cat}`);
    let s = 0;
    for (const w of words) {
      if (w.length < 3 && !/^\d/.test(w)) continue;
      if (idT.some(t => t.startsWith(w))) s += 3;
      if (dT.includes(w)) s += 1;
    }
    if (s > 0) scored.push([s, e]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const out = PINNED.map(id => BY_ID.get(id)).filter(Boolean);
  for (const [, e] of scored) { if (out.length >= max) break; if (!out.includes(e)) out.push(e); }
  return out;
}

/** Validate/repair model calls against the catalog. Returns {calls, rejected}. */
export function validateCalls(raw, snapshot = null) {
  const calls = [], rejected = [];
  for (const c of (Array.isArray(raw) ? raw : []).slice(0, LIMITS.calls)) {
    let id = String(c?.id ?? c?.method ?? '').trim().replace(/^control\./, '');
    let entry = BY_KEY.get(`${c?.kind}:${id}`) || BY_ID.get(id);
    if (!entry) { rejected.push({ call: c, reason: `unknown command ${id || '(none)'}` }); continue; }
    const params = c?.params && typeof c.params === 'object' && !Array.isArray(c.params) ? c.params : {};
    // Required names may list alternatives: "a|b" in the name, or "ticks|\"seconds\":f64" in the type.
    const alts = (name, type) => [...name.split('|'), ...[...String(type).matchAll(/"(\w+)":/g)].map(m => m[1])];
    const missing = entry.a.filter(([name, type, req]) => req && !name.startsWith('…')
      && !alts(name, type).some(n => params[n] !== undefined)).map(([n]) => n);
    if (missing.length) { rejected.push({ call: c, reason: `missing required ${missing.join(', ')} for ${id}` }); continue; }
    const refErr = checkRefs(params, snapshot);
    if (refErr) { rejected.push({ call: c, reason: refErr }); continue; }
    calls.push(entry.kind === 'request' ? { kind: 'request', method: entry.id, params } : { kind: 'execute', id: entry.id, params });
  }
  return { calls, rejected };
}

const clip = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? null); return s.length > n ? `${s.slice(0, n)}…[truncated]` : s; };

export function buildMessages({ prompt, state, history, snapshot }, tools) {
  const catalog = tools.map(e => `${e.kind === 'request' ? 'request' : 'execute'} ${e.id}(${e.a.map(([n, t, r]) => `${n}${r ? '' : '?'}:${t}`).join(', ')}) — ${e.d}`).join('\n');
  const system = `You control FilmCraft, an in-browser video editor, by planning tool calls the browser will run in order.
Call the tool filmcraft_call once per step (several calls allowed, in execution order). Plan EVERY part of the request, then call finish with a one-sentence explanation. If a call is rejected, fix it.
Only use these commands (kind then id, then params). "?" marks optional params:
${catalog}
Time: params typed "ticks" are integers at ${TICKS_PER_SECOND} ticks per second (5 s = ${5 * TICKS_PER_SECOND}). Where a param allows "seconds", prefer {"seconds": n}.
Use clip/track ids from the editor state when given; if a needed id is unknown, plan a query (e.g. request ui.inspect) and finish with needsResults=true.
Project snapshot (when given) lists tracks and clips with their real ids; times there are seconds. Resolve references like
"the second clip" (order by start on V1 unless a track is named) or "the music track" (audio track by name/source) to those ids. Never invent ids.
Work in batches: if a later step depends on the result of earlier calls (new clip ids after a cut, a query), plan only the first batch and
finish with needsResults=true; the client runs it, re-snapshots and asks again.
Never invent command ids.`;
  const messages = [{ role: 'system', content: system }];
  if (snapshot) messages.push({ role: 'user', content: `Project snapshot:\n${JSON.stringify(snapshot)}` });
  if (state !== undefined) messages.push({ role: 'user', content: `Editor state (window.filmcraft.inspect()):\n${clip(state, LIMITS.state)}` });
  for (const h of (history || []).slice(-LIMITS.history)) {
    messages.push({ role: 'user', content: clip(h.prompt ?? '', 1000) });
    messages.push({ role: 'assistant', content: `Planned calls: ${clip(h.calls ?? [], 2000)}` });
    if (h.results !== undefined) messages.push({ role: 'user', content: `Results of those calls: ${clip(h.results, LIMITS.historyChars / LIMITS.history)}` });
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

const TOOLS = [
  { type: 'function', function: { name: 'filmcraft_call', description: 'One FilmCraft call to run in the browser.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['execute', 'request'] }, id: { type: 'string', description: 'command id or request method' }, params: { type: 'object' } }, required: ['kind', 'id'] } } },
  { type: 'function', function: { name: 'finish', description: 'End the plan.',
    parameters: { type: 'object', properties: { explanation: { type: 'string' }, needsResults: { type: 'boolean', description: 'true if the client should run the calls and post results back for another step' } }, required: ['explanation'] } } },
];

export async function callXai(messages, { fetchImpl = fetch, token = XAI_API_TOKEN, model = XAI_UTILITY_MODEL } = {}) {
  const res = await fetchImpl(XAI_CHAT_COMPLETIONS_URL, {
    method: 'POST', signal: AbortSignal.timeout(45_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0 }),
  });
  if (!res.ok) throw Object.assign(new Error(`xAI ${res.status}`), { status: 502 });
  const data = await res.json();
  return data?.choices?.[0]?.message || {};
}

export function parsePlan(message) {
  const raw = []; let explanation = message?.content || '', needsResults = false;
  for (const tc of message?.tool_calls || []) {
    let args = {}; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { continue; }
    if (tc.function?.name === 'finish') { explanation = args.explanation || explanation; needsResults = !!args.needsResults; }
    else if (tc.function?.name === 'filmcraft_call') raw.push(args);
  }
  return { raw, explanation, needsResults };
}

export const filmcraftAgentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again later.' } });

export function createFilmcraftAgentRouter({ llm = callXai, limiter = filmcraftAgentLimiter, env = process.env, token = () => XAI_API_TOKEN } = {}) {
  const router = express.Router();
  router.post('/api/filmcraft/agent', (req, res, next) => {
    if (env.FILMCRAFT_AGENT_DISABLED === 'true') return res.status(503).json({ error: 'filmcraft agent is disabled' });
    next();
  }, limiter, express.json({ limit: '256kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { prompt, state, history } = req.body || {};
    const snapshot = compactSnapshot(req.body?.snapshot);
    if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'prompt (string) is required' });
    if (prompt.length > LIMITS.prompt) return res.status(413).json({ error: `prompt exceeds ${LIMITS.prompt} chars` });
    if (history !== undefined && !Array.isArray(history)) return res.status(400).json({ error: 'history must be an array' });
    if (!token()) return res.status(503).json({ error: 'LLM not configured' });
    try {
      const tools = selectTools(`${prompt} ${(history || []).map(h => h?.prompt || '').join(' ')}`);
      // Tool loop: acknowledge each call (or report why it was rejected, so the model can repair it)
      // until it calls finish, at most 4 rounds. Still one HTTP request; nothing kept between requests.
      const messages = buildMessages({ prompt, state, history, snapshot }, tools);
      const calls = [], rejected = []; let explanation = '', needsResults = false;
      for (let round = 0; round < 4; round += 1) {
        const message = await llm(messages);
        const plan = parsePlan(message);
        explanation = plan.explanation || explanation; needsResults = plan.needsResults;
        const toolCalls = message?.tool_calls || [];
        if (!toolCalls.length) break;
        messages.push({ role: 'assistant', content: message.content || '', tool_calls: toolCalls });
        let finished = false;
        for (const t of toolCalls) {
          let reply = 'ok';
          if (t.function?.name === 'finish') finished = true;
          else {
            let args = {}; try { args = JSON.parse(t.function?.arguments || '{}'); } catch { /* rejected below */ }
            const v = validateCalls([args], snapshot);
            calls.push(...v.calls);
            if (v.rejected.length) { rejected.push(...v.rejected); reply = `rejected: ${v.rejected[0].reason}. Fix it with another filmcraft_call if possible.`; }
            else reply = 'queued';
          }
          messages.push({ role: 'tool', tool_call_id: t.id, content: reply });
        }
        if (finished || calls.length >= LIMITS.calls) break;
      }
      calls.splice(LIMITS.calls);
      const step = (history || []).length + 1;
      // Step cap: the last allowed step is always final.
      res.json({ calls, explanation, done: !needsResults || !calls.length || step >= LIMITS.steps, step, maxSteps: LIMITS.steps, rejected });
    } catch (error) {
      console.warn(`[filmcraft-agent] ${error.message}`);
      res.status(error.status || 502).json({ error: 'planning failed' });
    }
  });
  return router;
}

export const filmcraftAgentRouter = createFilmcraftAgentRouter();
