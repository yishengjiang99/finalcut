# Live agentic prompt eval

`npm run eval:agentic` sends a fixed set of edit prompts to xAI using the exact `/api/v2/chat` system prompt and web tool list. It prints a table of the tools the model called. `--ffmpeg` is on by default: for run 0 of each prompt, it replays the chosen calls with the native ffmpeg CLI on a generated `testsrc2` clip and checks the final size, SAR and number of encodes.

```
XAI_API_KEY=... npm run eval:agentic -- --runs 3            # all prompts
XAI_API_KEY=... npm run eval:agentic -- --only bw_instagram # one prompt
```

- **Opt-in only.** It calls a paid API and its results vary between runs, so it is not part of `npm test` (vitest only collects `*.test.*`), not part of `test:smoke`, and not in any workflow under `.github/workflows`.
- **When to run it:** every time you change `src/tools.js`, `src/server/chat.js` (system prompt), `src/server/v2.js` (web tools and guidance), `src/clientTurn.js` / `src/useCallAPI.js` (tool loop), or the filter builders in `src/wasm/ops/process.js` / `src/server/ffmpegOps.js`.
- **Key handling:** the key is read from `XAI_API_KEY` (or `XAI_API_TOKEN`) and never printed.
