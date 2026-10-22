// FilmCraft agent helper (docs/filmcraft-agent.md). Load on the /filmcraft page, then:
//   const r = await filmcraftAgent('cut the second clip at 5 seconds and add a fade');
// Plans on the server (POST /api/filmcraft/agent), runs the calls locally via window.filmcraft.
// Each step sends a fresh compact project snapshot; the server keeps no state.
(function () {
  var TPS = 254016000000; // FilmCraft ticks per second
  var sec = function (t) { return typeof t === 'number' ? Math.round((t / TPS) * 1000) / 1000 : undefined; };
  var first = function () { for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i]; };

  async function safe(fn) { try { return await fn(); } catch (e) { return undefined; } }

  // Real shapes (filmcraft engine, see docs/filmcraft-agent.md "Snapshot fields"):
  //  sequence.inspect -> {video:[track], audio:[track], playhead, duration, markers:[{name,start}], selection:[clipId]}
  //    track = {id, name, muted, locked, enabled, solo, items:[{clip, item, link, name, label(color!), start, end,
  //             sourceIn, sourceOut, enabled, speed, gainDb}]}   (times in ticks)
  //  project.items -> {rows:[{item, name, cells:{"Media Duration":..}} | {bin, name}]}
  //  files() -> [{path:"/files/intro.mp4", kind:"blob"}]
  async function snapshot() {
    var fc = window.filmcraft;
    var seq = (await safe(function () { return fc.execute('sequence.inspect', {}); })) || {};
    if (seq && seq.result) seq = seq.result;
    var proj = await safe(function () { return fc.execute('project.items', { recursive: true }); });
    var rows = proj && (Array.isArray(proj) ? proj : proj.rows || proj.items) || [];
    var itemName = {}, media = [];
    rows.forEach(function (r) {
      if (r && r.item !== undefined) {
        itemName[r.item] = r.name;
        var c = r.cells || {};
        media.push({ item: r.item, name: r.name, type: c['Video Info'] ? 'video' : c['Audio Info'] ? 'audio' : undefined, duration: c['Media Duration'] || undefined });
      }
    });
    var files = await safe(function () { return fc.files(); });
    if (Array.isArray(files)) files.forEach(function (f) {
      var base = String(f.path || '').split('/').pop();
      var m = media.find(function (x) { return x.name === base; });
      if (m) m.path = f.path; else media.push({ name: base, path: f.path });
    });
    var tracks = [];
    [['video', seq.video || []], ['audio', seq.audio || []]].forEach(function (pair) {
      pair[1].forEach(function (t, i) {
        tracks.push({
          id: first(t.id, (pair[0] === 'audio' ? 'A' : 'V') + (i + 1)), kind: pair[0], index: i,
          name: t.name, muted: !!t.muted, locked: !!t.locked, enabled: t.enabled === false ? false : undefined, solo: t.solo ? true : undefined,
          clips: (t.items || []).filter(function (c) { return c.clip !== undefined; }).map(function (c) {
            return { id: c.clip, item: c.item, link: c.link === null ? undefined : c.link, name: c.name, source: itemName[c.item],
              start: sec(c.start), end: sec(c.end), in: sec(c.sourceIn), out: sec(c.sourceOut),
              enabled: c.enabled === false ? false : undefined, speed: c.speed !== undefined && c.speed !== 1 ? c.speed : undefined };
          }),
        });
      });
    });
    var markers = (seq.markers || []).map(function (m) { return { name: m.name, start: sec(m.start) }; });
    return { tracks: tracks, media: media, markers: markers, selection: seq.selection || [], playhead: sec(seq.playhead), duration: sec(seq.duration) };
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
