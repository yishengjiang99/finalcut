# FilmCraft agent (`POST /api/filmcraft/agent`)

Natural language → one or more FilmCraft calls. The server only **plans**; the browser runs the calls
through `window.filmcraft` on grepawk.com/filmcraft (same origin, so no CORS or auth involved).

## Request

```json
{ "prompt": "cut the clip at 5 seconds and add a fade",
  "snapshot": { "tracks": [ { "id": "V1", "kind": "video", "index": 0, "name": "Video 1", "muted": false, "locked": false,
                              "clips": [ { "id": 7, "name": "intro.mp4", "source": "intro.mp4", "start": 0, "end": 12.5, "in": 0, "out": 12.5 } ] },
                            { "id": "A2", "kind": "audio", "index": 1, "name": "Music", "clips": [ ... ] } ],
                "media": [ { "name": "intro.mp4", "type": "video", "duration": 12.5 } ],
                "playhead": 0, "duration": 12.5 },
  "state":   { "...": "optional window.filmcraft.inspect() snapshot (first 12k chars used)" },
  "history": [ { "prompt": "...", "calls": [ ... ], "results": [ ... ] } ] }
```

Limits: prompt ≤ 2000 chars, body ≤ 256 KB, last 8 history steps, 60 requests / 15 min / IP.

## Project snapshot (how the agent knows clips and tracks)

The server is stateless. Each request carries a compact snapshot that the client builds fresh
(`window.filmcraftAgentSnapshot()` in the helper) from `filmcraft.execute('sequence.inspect')` (tracks and
their items), `filmcraft.execute('project.items', {recursive:true})` (bin) and `filmcraft.files()` (imported
files). Times are **seconds**. The server re-normalizes it (unknown fields dropped, strings cut) and caps it at
~10 KB: ≤24 tracks, ≤60 media rows; on a long timeline each track keeps its first and last clips and reports
`omittedClips: n` (halving the per-track cap until it fits).

It is injected into the prompt so the model resolves "the second clip", "the music track", etc. to real ids.
Every returned call is then checked: a `clip`/`clips` id or `track` id (or track name) not present in the
snapshot is moved to `rejected`. (Clip-id checks are skipped when clips were elided, since the id may be in
the omitted middle.)

## Multi-step

When later calls depend on earlier results (new clip ids after a razor, a query), the model returns only the
first batch with `done:false`. The client runs it, re-snapshots, and POSTs again with `history` (calls +
results) and the new snapshot, until `done:true`. Steps are capped at 6 (`step`/`maxSteps` in the response;
the 6th response is always `done:true`). The helper stops early on any failed call.

## Response

```json
{ "calls": [ { "kind": "execute", "id": "timeline.razor", "params": { "time": 1270080000000 } },
             { "kind": "request", "method": "ui.inspect", "params": {} } ],
  "explanation": "Split at 5 s and applied a cross dissolve.",
  "done": true, "step": 1, "maxSteps": 6,
  "rejected": [ { "call": { "...": "..." }, "reason": "unknown command made.up" } ] }
```

Run `execute` calls with `filmcraft.execute(id, params)` and `request` calls with
`filmcraft.request(method, params)`, in order. `done:false` means the plan needs results (e.g. it queried
for clip ids): run the calls and POST again with `history` holding the calls and their results. The server
keeps no state.

Errors: 400 bad input, 413 prompt too long, 429 rate limit, 502 LLM failure, 503 disabled / no LLM key.

## How it works

- `src/server/filmcraft/catalog.json`: the 666 core commands from the FilmCraft API dump (regenerate with
  `node scripts/build-filmcraft-catalog.mjs filmcraft-apis.json`). `control.*` entries become `request`
  methods; everything else is an `execute` command id.
- Per request, keyword retrieval (with a small synonym table and a pinned set: razor, playhead, captions,
  transitions, export, inspect) picks ≤ 40 commands for the prompt, so the LLM context stays small.
- xAI (`XAI_API_TOKEN`, `XAI_UTILITY_MODEL`, same client as chat) is given two tools: `filmcraft_call`
  and `finish`. Each returned call is validated against the full catalog: unknown ids are rejected,
  `control.` prefixes / wrong `kind` are repaired, missing required args are rejected (alternatives such as
  `startSeconds|startTime` or `ticks|"seconds":f64` count).
- Time: 254 016 000 000 ticks per second; `{"seconds": n}` is used where a command accepts it.

## Browser helper

`/filmcraft-agent.js` (from `public/`) defines `window.filmcraftAgent(prompt, {maxSteps, dryRun})` (snapshot → plan → run → repeat) and `window.filmcraftAgentSnapshot()`:

```html
<script src="/filmcraft-agent.js"></script>
<script>
  const r = await filmcraftAgent('add a caption saying Hello at the start');
  console.log(r.explanation, r.history);
</script>
```

Or from the devtools console on /filmcraft: `await import('/filmcraft-agent.js'); await filmcraftAgent('export as 1080p mp4')`.

## Kill switch / rollback

Set `FILMCRAFT_AGENT_DISABLED=true` in the server env and restart `finalcut` → the route returns 503;
nothing else changes. Full rollback: revert the PR (the route and files are self-contained).

## Voice (`GET /api/filmcraft/voice/token`)

The FilmCraft page has a mic button that starts an ElevenLabs Conversational AI session. The agent has one
client tool, `edit_video(instruction)`; the page handles it by running `filmcraftAgent(instruction)` and
returns the explanation for the voice to speak. This route returns `{signedUrl, agentId}` (signed wss URL,
key stays on the server). Setup: an `ELEVENLABS_API_KEY` with **convai read/write** permission, then
`node scripts/create-filmcraft-voice-agent.mjs` once and put `FILMCRAFT_VOICE_AGENT_ID=...` in `.env`.
Until both are set it answers 503. Off switch: `FILMCRAFT_VOICE_DISABLED=true`.

## FinalCut chat voice (`GET /api/voice/token`)

The main app's composer has a 🎤 button (`src/VoiceButton.jsx`). It starts a session with a separate ElevenLabs
agent (`FINALCUT_VOICE_AGENT_ID`, created by `scripts/create-finalcut-voice-agent.mjs`). Its client tool
`edit_video(instruction)` calls the same `handleSend` as typing (the request shows in the chat and runs the normal
edit flow) and returns the last assistant reply, shortened, for the voice to speak. Same router as above with its own
path/agent var; 503 until configured. Off switch: `FINALCUT_VOICE_DISABLED=true`.

## Snapshot fields (engine shapes)

`sequence.inspect` returns `{video:[track], audio:[track], playhead, duration, markers, selection}` in ticks. Track:
`{id, name, muted, locked, enabled, solo, items}`; item: `{clip, item, link, name, label, start, end, sourceIn, sourceOut, enabled, speed}`.
Note `label` is the colour label (e.g. "Iris"), not a name. `project.items` returns `{rows:[{item, name, cells}|{bin, name}]}`;
`files()` returns `[{path:"/files/intro.mp4", kind}]`. The helper maps these to clips `{id: clip, item, link, name, source
(project item name), start, end, in, out, enabled?}` and media `{item, name, path, type, duration}`. `link` is a link-group id shared by linked video/audio partners (not a clip id). Ids stay numbers: the engine ignores
or rejects quoted ids, so the server also turns quoted numeric ids in planned calls back into numbers.
