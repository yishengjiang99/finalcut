# FilmCraft agent (`POST /api/filmcraft/agent`)

Natural language → one or more FilmCraft calls. The server only **plans**; the browser runs the calls
through `window.filmcraft` on grepawk.com/filmcraft (same origin, so no CORS or auth involved).

## Request

```json
{ "prompt": "cut the clip at 5 seconds and add a fade",
  "state":   { "...": "optional window.filmcraft.inspect() snapshot (first 12k chars used)" },
  "history": [ { "prompt": "...", "calls": [ ... ], "results": [ ... ] } ] }
```

Limits: prompt ≤ 2000 chars, body ≤ 256 KB, last 8 history steps, 60 requests / 15 min / IP.

## Response

```json
{ "calls": [ { "kind": "execute", "id": "timeline.razor", "params": { "time": 1270080000000 } },
             { "kind": "request", "method": "ui.inspect", "params": {} } ],
  "explanation": "Split at 5 s and applied a cross dissolve.",
  "done": true,
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

`/filmcraft-agent.js` (from `public/`) defines `window.filmcraftAgent(prompt, {maxSteps, dryRun})`:

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
