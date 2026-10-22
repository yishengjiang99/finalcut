// WebMCP tools for the FinalCap / FinalCut chat editor (docs/webmcp.md). Registers in-page tools for browser
// agents through the WebMCP proposal (github.com/webmachinelearning/webmcp). Does nothing unless the
// browser exposes modelContext (document.modelContext per the current spec, navigator.modelContext in
// older drafts). Off switch: remove the <script> tag, or open the page with ?nowebmcp.
// The tools call window.finalcutApp, a thin bridge App.jsx sets up over the same handlers the buttons
// use, so they hit the existing endpoints only.
(() => {
  "use strict";
  if (new URLSearchParams(location.search).has("nowebmcp")) return;
  const ctx = (typeof document !== "undefined" && document.modelContext) || (typeof navigator !== "undefined" && navigator.modelContext);
  if (!ctx) return;

  const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v === undefined ? null : v) }] });
  const fail = (e) => ({ isError: true, content: [{ type: "text", text: "Error: " + String((e && e.message) || e) }] });
  async function confirmUser(client, msg) {
    try {
      if (client && typeof client.requestUserInteraction === "function")
        return !!(await client.requestUserInteraction(async () => window.confirm(msg)));
    } catch (e) { /* fall through */ }
    return window.confirm(msg);
  }
  const guard = async (client, msg, fn) => (await confirmUser(client, msg)) ? fn() : text("Cancelled by the user.");
  const app = (wait) => new Promise((ok, bad) => {
    if (window.finalcutApp && window.finalcutApp.send) return ok(window.finalcutApp);
    if (!wait) return bad(new Error("The editor is not open. Call finalcut.open_editor first."));
    const t = setTimeout(() => bad(new Error("The editor did not open in time.")), wait);
    window.addEventListener("finalcut:ready", () => { clearTimeout(t); ok(window.finalcutApp); }, { once: true });
  });

  const obj = (props, required) => ({ type: "object", properties: props || {}, required: required || [], additionalProperties: false });
  const tools = [];
  const tool = (name, description, inputSchema, run, readOnly) => tools.push(Object.assign({
    name, description, inputSchema,
    async execute(input, client) { try { return await run(input || {}, client); } catch (e) { return fail(e); } },
  }, readOnly ? { annotations: { readOnlyHint: true } } : {}));

  tool("finalcut.open_editor", "Open the chat video editor with the free sample video (from the landing page). The page reloads into the editor; tools re-register.",
    obj(), async () => {
      if (window.finalcutApp && window.finalcutApp.send) return text("The editor is already open.");
      location.href = "/?start=sample"; return text("Opening the editor with the sample video…");
    });
  tool("finalcut.status", "Editor state: whether it is open, busy with an edit, the media clips (ids, labels, which one is active) and the chat so far.",
    obj(), async () => {
      const a = window.finalcutApp;
      if (!a || !a.send) return text({ editorOpen: false });
      return text({ editorOpen: true, busy: a.busy(), media: a.media(), messages: a.messages().slice(-20) });
    }, true);
  tool("finalcut.send_message", "Send a chat message to the Grok video editing assistant, e.g. 'trim seconds 5-15 and add burned-in captions'. Edits apply to the active clip. Waits for the turn to finish and returns its reply.",
    obj({ text: { type: "string", description: "The message or edit request" } }, ["text"]),
    async ({ text: t }) => { const a = await app(); if (a.busy()) return text("Busy with another edit; try again when it finishes."); return text(await a.send(t)); });
  tool("finalcut.cancel", "Cancel the edit that is running.", obj(), async () => text((await app()).cancel() ? "Cancelled." : "Nothing to cancel."));
  tool("finalcut.select_media", "Make a clip (id from finalcut.status) the target of the next edit.", obj({ id: { type: "number" } }, ["id"]),
    async ({ id }) => text((await (await app()).select(id)) ? "Selected." : "No such clip."));
  tool("finalcut.undo", "Undo an edit: go back to the clip it was made from (default: the active clip).", obj({ id: { type: "number" } }),
    async ({ id }) => text((await (await app()).undo(id)) ? "Undone." : "Nothing to undo."));
  tool("finalcut.add_media_from_url", "Add a same-origin video or audio file (e.g. /BigBuckBunny.mp4) to the project.", obj({ url: { type: "string" } }, ["url"]),
    async ({ url }) => {
      const u = new URL(url, location.href); if (u.origin !== location.origin) throw new Error("Only same-origin URLs are allowed");
      const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status);
      const b = await r.blob(); const name = u.pathname.split("/").pop() || "media";
      await (await app()).addFile(new File([b], name, { type: b.type || (/\.(mp3|wav|m4a)$/i.test(name) ? "audio/mpeg" : "video/mp4") }));
      return text("Added " + name);
    });
  tool("finalcut.remove_media", "Remove a clip from the project. Asks the user to confirm.", obj({ id: { type: "number" } }, ["id"]),
    async ({ id }, client) => { const a = await app(); const m = a.media().find((x) => x.id === Number(id)); if (!m) return text("No such clip.");
      return guard(client, `Remove “${m.label}” from the project?`, async () => text(a.remove(id) ? "Removed." : "Could not remove.")); });
  tool("finalcut.export", "Export (download or share) the active clip, with captions burned in when it has them. Asks the user to confirm.", obj(),
    async (_, client) => { const a = await app(); const m = a.media().find((x) => x.active); if (!m) return text("Add a video or audio file first.");
      return guard(client, `Export “${m.label}”?`, async () => text("Exporting " + a.exportActive())); });

  // Register. Current spec: registerTool(tool, {signal}) (may return a promise). Older drafts: provideContext({tools}).
  const controller = new AbortController(), registered = [];
  (async () => {
    if (typeof ctx.registerTool === "function") {
      for (const t of tools) {
        try { await ctx.registerTool(t, { signal: controller.signal }); registered.push(t.name); }
        catch (e) { try { await ctx.registerTool(t); registered.push(t.name); } catch (e2) { console.warn("[webmcp] registerTool failed", t.name, e2); } }
      }
    } else if (typeof ctx.provideContext === "function") {
      try { await ctx.provideContext({ tools }); tools.forEach((t) => registered.push(t.name)); } catch (e) { console.warn("[webmcp] provideContext failed", e); }
    }
  })();
  window.finalcutWebMCP = { tools, registered, unregister: () => { controller.abort(); try { ctx.unregisterTool && tools.forEach((t) => ctx.unregisterTool(t.name)); } catch (e) {} } };
})();
