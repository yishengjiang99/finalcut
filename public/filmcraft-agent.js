// FilmCraft agent helper (docs/filmcraft-agent.md). Load on the /filmcraft page, then:
//   const r = await filmcraftAgent('cut the second clip at 5 seconds and add a fade');
// Plans on the server (POST /api/filmcraft/agent), runs the calls locally via window.filmcraft.
// Each step sends a fresh compact project snapshot; the server keeps no state.
(function () {
  var TPS = 254016000000; // FilmCraft ticks per second
  var sec = function (t) { return typeof t === 'number' ? Math.round((t / TPS) * 1000) / 1000 : undefined; };
  var first = function () { for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i]; };

  async function safe(fn) { try { return await fn(); } catch (e) { return undefined; } }

  /** Compact snapshot: tracks (+clips) from sequence.inspect, media from project.items + files(). */
  async function snapshot() {
    var fc = window.filmcraft;
    var seq = (await safe(function () { return fc.execute('sequence.inspect', {}); })) || {};
    if (seq && seq.result) seq = seq.result;
    var tracks = [];
    [['video', seq.video || []], ['audio', seq.audio || []]].forEach(function (pair) {
      pair[1].forEach(function (t, i) {
        tracks.push({
          id: first(t.id, (pair[0] === 'audio' ? 'A' : 'V') + (i + 1)), kind: pair[0], index: i,
          name: first(t.name, t.label), muted: !!first(t.muted, t.mute), locked: !!first(t.locked, t.lock),
          clips: (t.items || t.clips || []).filter(function (c) { return first(c.clip, c.id) !== undefined; }).map(function (c) {
            var start = first(c.start, c.timelineStart), end = first(c.end, typeof start === 'number' && typeof c.duration === 'number' ? start + c.duration : undefined);
            return { id: first(c.clip, c.id), name: first(c.name, c.label), source: first(c.source, c.media, c.path),
              start: sec(start), end: sec(end), in: sec(first(c.in, c.mediaIn, c.media_in)), out: sec(first(c.out, c.mediaOut, c.media_out)) };
          }),
        });
      });
    });
    var media = [];
    var rows = await safe(function () { return fc.execute('project.items', { recursive: true }); });
    rows = rows && (rows.result || rows.items || rows);
    if (Array.isArray(rows)) rows.forEach(function (r) { media.push({ name: first(r.name, r.label), type: first(r.kind, r.type), duration: sec(r.duration) }); });
    var files = await safe(function () { return fc.files(); });
    if (Array.isArray(files)) files.forEach(function (f) { if (!media.some(function (m) { return m.name === f.path; })) media.push({ name: f.path, type: f.kind }); });
    return { tracks: tracks, media: media, playhead: sec(first(seq.playhead, seq.time)), duration: sec(seq.duration) };
  }

  async function plan(body, endpoint) {
    var res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(json.error || 'agent HTTP ' + res.status);
    return json;
  }
  async function run(calls) {
    var fc = window.filmcraft, results = [];
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      try { results.push({ ok: true, value: c.kind === 'request' ? await fc.request(c.method, c.params || {}) : await fc.execute(c.id, c.params || {}) }); }
      catch (e) { results.push({ ok: false, error: String((e && e.message) || e) }); break; }
    }
    return results;
  }
  window.filmcraftAgentSnapshot = snapshot;
  window.filmcraftAgent = async function (prompt, opts) {
    opts = opts || {};
    var endpoint = opts.endpoint || '/api/filmcraft/agent', maxSteps = opts.maxSteps || 6, history = [], last;
    for (var step = 0; step < maxSteps; step++) {
      last = await plan({ prompt: prompt, snapshot: await snapshot(), history: history }, endpoint);
      if (opts.dryRun) return last;
      var results = await run(last.calls);
      history.push({ prompt: prompt, calls: last.calls, results: results });
      if (last.done || !last.calls.length || results.some(function (r) { return !r.ok; })) break;
    }
    return Object.assign({}, last, { history: history });
  };
})();
