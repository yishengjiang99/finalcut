// FilmCraft agent helper (docs/filmcraft-agent.md). Load on the /filmcraft page, then:
//   const r = await filmcraftAgent('cut the clip at 5 seconds and add a fade');
// Plans on the server (POST /api/filmcraft/agent), runs the calls locally via window.filmcraft.
(function () {
  async function plan(body, endpoint) {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `agent HTTP ${res.status}`);
    return json;
  }
  async function run(calls) {
    const fc = window.filmcraft, results = [];
    for (const c of calls) {
      try {
        const value = c.kind === 'request' ? await fc.request(c.method, c.params || {}) : await fc.execute(c.id, c.params || {});
        results.push({ ok: true, value });
      } catch (e) { results.push({ ok: false, error: String(e && e.message || e) }); break; }
    }
    return results;
  }
  window.filmcraftAgent = async function (prompt, { endpoint = '/api/filmcraft/agent', maxSteps = 3, dryRun = false } = {}) {
    const history = []; let last;
    for (let step = 0; step < maxSteps; step++) {
      let state; try { state = await window.filmcraft.inspect(); } catch { state = undefined; }
      last = await plan({ prompt: step ? `${prompt} (continue)` : prompt, state, history }, endpoint);
      if (dryRun) return last;
      const results = await run(last.calls);
      history.push({ prompt, calls: last.calls, results });
      if (last.done || !last.calls.length || results.some(r => !r.ok)) break;
    }
    return { ...last, history };
  };
})();
