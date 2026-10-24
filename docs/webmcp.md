# WebMCP on grepawk.com

[WebMCP](https://github.com/webmachinelearning/webmcp) is a browser proposal that lets a page register
JavaScript "tools" (name, description, JSON-Schema `inputSchema`, `execute`) that a browser agent can
discover and call. Three grepawk sites register tools:

| Site | Script | Repo |
|---|---|---|
| FilmCraft (`grepawk.com/filmcraft/`) | `apps/filmcraft-web/web/webmcp.js` (+ `webmcp-commands.json`) | yishengjiang99/filmcraft |
| FinalCap / FinalCut chat editor (`grepawk.com/`) | `public/webmcp.js` (+ the `window.finalcutApp` bridge in `src/App.jsx`) | yishengjiang99/finalcut |
| AI Music Radar (`music.grepawk.com/`) | `tools/music-radar-site/static/webmcp.js` | yishengjiang99/earsheet |

## API shape and feature detection

The spec (checked 2026-10-22) puts the API on `document.modelContext`:
`await document.modelContext.registerTool(tool, { signal })`, unregistered by aborting the signal.
Earlier drafts and Chrome's first preview used `navigator.modelContext` with `registerTool` /
`unregisterTool(name)` / `provideContext({ tools })`, and passed `execute(input, client)` a client with
`requestUserInteraction(callback)`. The scripts code against all of these:

- `ctx = document.modelContext || navigator.modelContext`; with neither, the script returns and does nothing.
- `registerTool(tool, { signal })` per tool, falling back to `registerTool(tool)`, then to `provideContext({ tools })`.
  Each registration is wrapped in try/catch, so one rejected tool (or a `NotAllowedError` from
  `Permissions-Policy: tools=()`) does not stop the rest.
- Tools return `{ content: [{ type: "text", text }] }` (JSON as text), and `{ isError: true, ... }` on failure.
- Read-only tools carry `annotations: { readOnlyHint: true }`.
- Destructive tools (delete, remove, clear, close, reset, export, overwrite) ask the user first:
  `client.requestUserInteraction(() => confirm(...))` when the agent passes a client that has it,
  otherwise `window.confirm`. Declining returns "Cancelled by the user."
- Each script exposes `window.<app>WebMCP = { tools, registered, unregister }` for debugging.

## Off switch

Shipped to everyone, no flags. To turn it off, remove the `<script src="webmcp.js">` tag, or open
the page with `?nowebmcp` for that page load.

## FilmCraft tools

| Tool | What it does |
|---|---|
| `filmcraft.snapshot` | Tracks with clips (ids, names, start/end/in/out in seconds), media, markers, selection, playhead, duration (the same snapshot `/filmcraft-agent.js` sends). Read-only. |
| `filmcraft.ask(prompt)` | Plain-language edit through the existing `POST /api/filmcraft/agent` via `/filmcraft-agent.js`. While it runs, destructive engine commands it plans ask the user first. |
| `filmcraft.list_commands(query?, limit?)` | Searches the ~650 core engine commands in `webmcp-commands.json` (id, description, params; `!` = required, `ticks` = seconds × 254016000000). Read-only. |
| `filmcraft.execute(command, params)` | Runs any command through `window.filmcraft.execute`. Destructive ids ask the user first. |
| `filmcraft.undo`, `filmcraft.redo` | `edit.undo` / `edit.redo`. |
| `filmcraft.set_playhead(seconds)` | `playhead.set`. |
| `filmcraft.select_clips(clips, add?)` | `timeline.select`. |
| `filmcraft.split_at(seconds, track?, clip?)` | `timeline.razor`. |
| `filmcraft.add_marker(seconds?, name?, comment?)` | `markers.add` on the program. |
| `filmcraft.rename_clip(clip, name)` | `clip.rename`. |
| `filmcraft.add_transition(clip?, effect?, edge?, frames?)` | `sequence.applyVideoTransition`. |
| `filmcraft.apply_effect(effect, clips?)` | `effects.apply`. |
| `filmcraft.add_caption(text, seconds?, durationSeconds?)` | `captions.add`. |
| `filmcraft.delete_clips(clips?, ripple?)` | `edit.clear` / `edit.rippleDelete`. Asks the user first. |
| `filmcraft.export(path?, format?, quality?)` | `file.exportMedia`. Asks the user first. |
| `filmcraft.list_files` | `window.filmcraft.files()`. Read-only. |

`webmcp-commands.json` is generated from the API catalog (entries marked core in the `engine.*` categories).
Only the curated tools sit in the agent's context. The full catalog is fetched lazily by `list_commands`.

## FinalCut chat editor tools

They call `window.finalcutApp`, a small bridge in `App.jsx` over the handlers the buttons already use
(`handleSend`, export, undo, select, remove, upload). No server endpoints were added or changed.

| Tool | What it does |
|---|---|
| `finalcut.open_editor` | From the landing page, opens the editor with the sample video (`/?start=sample`). |
| `finalcut.status` | Editor open or not, busy, media clips (ids, labels, active), last 20 chat messages. Read-only. |
| `finalcut.send_message(text)` | Sends a chat message to the Grok editing assistant (same path as typing it) and returns the reply. |
| `finalcut.cancel` | Cancels the running edit. |
| `finalcut.select_media(id)` | Makes a clip the target of the next edit. |
| `finalcut.undo(id?)` | Goes back to the clip an edit was made from. |
| `finalcut.add_media_from_url(url)` | Adds a same-origin media file (e.g. `/sample-lake.mp4`). |
| `finalcut.remove_media(id)` | Removes a clip. Asks the user first. |
| `finalcut.export` | Exports the active clip (download or share sheet, with captions burned in when present). Asks the user first. |

## AI Music Radar (music.grepawk.com) tools

The site is a landing page. The tools cover what a visitor does there:
`musicradar.app_info` (description, platforms, pricing, App Store link, demo URL), `musicradar.read_section(section)`,
`musicradar.go_to_section(section)`, `musicradar.play_video(pause?)`, `musicradar.open_web_demo`.
None of them is destructive.

## Testing

Chrome's WebMCP preview (`chrome://flags/#enable-webmcp-testing`, Chrome 146+) is not in the Playwright
Chromium we use, so verification injects a mock before the page loads:

```js
await page.addInitScript(() => {
  const tools = new Map();
  const mc = { registerTool: async (t) => { tools.set(t.name, t); }, unregisterTool: (n) => tools.delete(n),
               __tools: tools, __call: (n, a) => tools.get(n).execute(a || {}, { requestUserInteraction: async (cb) => cb() }) };
  Object.defineProperty(navigator, "modelContext", { value: mc });
});
```

Then assert that `navigator.modelContext.__tools` holds the expected names, run `filmcraft.snapshot`, and run one
safe edit (`filmcraft.add_marker`) followed by `filmcraft.undo`.
