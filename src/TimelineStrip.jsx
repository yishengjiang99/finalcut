import React, { useEffect, useRef, useState } from 'react';

// Timeline strip for the active clip — the web counterpart of the iOS timeline
// layout rethink (2026-10-27). The chat stream stays the editor's spine, but the
// clip being edited gets a persistent, visible timeline docked above the
// composer: a real filmstrip with a ruler, a playhead that follows (and can
// scrub) the active card's preview, and trim handles on the selection itself —
// instead of trim points that exist only as numbers in a chat prompt.
// The Trim button follows this app's idiom for UI shortcuts (sample chips,
// caption commands): it fills the composer with the equivalent prompt and
// focuses it, so the edit runs through the same planner/quota path as a
// typed instruction.

const FRAME_COUNT = 12;
const frameCache = new Map(); // mediaId -> { url, frames: [dataURL], duration }

function fmtClock(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSeconds(t) {
  const v = Math.round(t * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function rulerStep(duration) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120];
  return steps.find((s) => duration / s <= 12) ?? 120;
}

// Grab FRAME_COUNT thumbnails spread across the clip with an offscreen video
// (same technique as VideoPreview's poster grab). Same-origin and blob: URLs
// keep the canvas untainted.
function grabFrames(url, duration, onDone) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 72;
  const ctx = canvas.getContext('2d');
  const frames = [];
  let i = 0;
  let dead = false;
  const times = Array.from({ length: FRAME_COUNT }, (_, k) =>
    Math.min(duration * (k + 0.5) / FRAME_COUNT, Math.max(0, duration - 0.05)));
  const cleanup = () => { dead = true; v.removeAttribute('src'); v.load(); };
  const next = () => {
    if (dead) return;
    if (i >= times.length) { onDone(frames); cleanup(); return; }
    try { v.currentTime = times[i]; } catch (_) { onDone(frames); cleanup(); }
  };
  v.addEventListener('loadeddata', next);
  v.addEventListener('seeked', () => {
    if (dead) return;
    try {
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL('image/jpeg', 0.6));
    } catch (_) { /* tainted or undecodable frame: skip it */ }
    i += 1;
    next();
  });
  v.addEventListener('error', () => { if (!dead) { onDone(frames); cleanup(); } });
  return cleanup;
}

export default function TimelineStrip({ media, getVideoEl, onTrimPrompt, open, onToggle }) {
  const [duration, setDuration] = useState(0);
  const [frames, setFrames] = useState([]);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [playhead, setPlayhead] = useState(0);
  const laneRef = useRef(null);
  const dragRef = useRef(null);

  // Probe duration + build the filmstrip when the active clip changes.
  useEffect(() => {
    if (!media) return undefined;
    const cached = frameCache.get(media.id);
    if (cached && cached.url === media.url) {
      setDuration(cached.duration);
      setFrames(cached.frames);
      setSel({ start: 0, end: cached.duration });
      setPlayhead(0);
      return undefined;
    }
    let dead = false;
    let cancelGrab = null;
    const probe = document.createElement('video');
    probe.muted = true;
    probe.preload = 'metadata';
    probe.src = media.url;
    probe.addEventListener('loadedmetadata', () => {
      if (dead) return;
      const d = probe.duration || 0;
      setDuration(d);
      setSel({ start: 0, end: d });
      setPlayhead(0);
      if (Number.isFinite(d) && d > 0) {
        cancelGrab = grabFrames(media.url, d, (got) => {
          if (dead) return;
          frameCache.set(media.id, { url: media.url, frames: got, duration: d });
          setFrames(got);
        });
      }
    });
    return () => {
      dead = true;
      if (cancelGrab) cancelGrab();
      probe.removeAttribute('src');
      probe.load();
    };
  }, [media]);

  // Playhead follows the active card's preview element while it plays.
  useEffect(() => {
    if (!open) return undefined;
    let raf = 0;
    const tick = () => {
      const el = getVideoEl?.();
      if (el && Number.isFinite(el.currentTime)) {
        setPlayhead((prev) => (Math.abs(prev - el.currentTime) > 0.03 ? el.currentTime : prev));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, getVideoEl, media]);

  if (!media) return null;

  const pct = (t) => (duration > 0 ? (t / duration) * 100 : 0);
  const timeAt = (clientX) => {
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  const seekPreview = (t) => {
    const el = getVideoEl?.();
    if (el) {
      try { el.currentTime = t; } catch (_) { /* preview not mounted yet */ }
    }
    setPlayhead(t);
  };

  const onLanePointerDown = (e) => {
    if (dragRef.current) return;
    seekPreview(timeAt(e.clientX));
  };

  const startHandleDrag = (which) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = which;
    const move = (ev) => {
      const t = timeAt(ev.clientX);
      setSel((prev) => {
        if (which === 'start') return { ...prev, start: Math.min(Math.max(0, t), prev.end - 0.5) };
        return { ...prev, end: Math.max(Math.min(duration, t), prev.start + 0.5) };
      });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const step = rulerStep(duration || 0);
  const ticks = [];
  for (let t = 0; t <= (duration || 0) + 0.001; t += step) ticks.push(t);
  const isFullRange = sel.start <= 0.05 && sel.end >= duration - 0.05;
  const selLen = Math.max(0, sel.end - sel.start);

  if (!open) {
    return (
      <button type="button" className="tl-strip tl-slim" onClick={onToggle} aria-label="Expand timeline">
        <span className="tl-slim-caret">▸</span>
        <span className="tl-slim-label">Timeline</span>
        <span className="tl-slim-meta">
          {media.label} · {fmtClock(duration)}
          {!isFullRange && duration > 0 ? ` · ✂ ${fmtClock(sel.start)}–${fmtClock(sel.end)}` : ''}
        </span>
      </button>
    );
  }

  return (
    <div className="tl-strip" data-testid="timeline-strip">
      <div className="tl-head">
        <button type="button" className="tl-collapse" onClick={onToggle} aria-label="Collapse timeline">▾</button>
        <span className="tl-title">Timeline</span>
        <span className="tl-meta">{media.label} · {fmtClock(duration)}</span>
        <span className="tl-head-spacer" />
        <span className="tl-sel-readout">
          {isFullRange
            ? 'Full clip selected — drag the handles to trim'
            : `✂ ${fmtClock(sel.start)} – ${fmtClock(sel.end)} · ${fmtSeconds(selLen)}s selected`}
        </span>
      </div>

      <div className="tl-ruler" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} className="tl-tick" style={{ left: `${pct(t)}%` }}>{fmtClock(t)}</span>
        ))}
      </div>

      <div
        className="tl-lane"
        ref={laneRef}
        onPointerDown={onLanePointerDown}
        role="slider"
        aria-label="Timeline: click to seek, drag the edge handles to select a trim range"
        aria-valuetext={`Playhead ${fmtClock(playhead)} of ${fmtClock(duration)}`}
      >
        <div className="tl-film">
          {frames.length > 0
            ? frames.map((src, i) => <img key={i} src={src} alt="" draggable="false" />)
            : <div className="tl-film-empty">{duration > 0 ? 'Loading frames…' : 'Reading clip…'}</div>}
        </div>
        <div className="tl-dim" style={{ left: 0, width: `${pct(sel.start)}%` }} />
        <div className="tl-dim" style={{ left: `${pct(sel.end)}%`, width: `${100 - pct(sel.end)}%` }} />
        <div className="tl-playhead" style={{ left: `${pct(playhead)}%` }}>
          <span className="tl-playhead-tag">{fmtClock(playhead)}</span>
        </div>
        <div
          className="tl-handle tl-handle-start"
          style={{ left: `${pct(sel.start)}%` }}
          onPointerDown={startHandleDrag('start')}
          role="slider"
          aria-label="Trim start"
          aria-valuetext={fmtClock(sel.start)}
        >‹</div>
        <div
          className="tl-handle tl-handle-end"
          style={{ left: `${pct(sel.end)}%` }}
          onPointerDown={startHandleDrag('end')}
          role="slider"
          aria-label="Trim end"
          aria-valuetext={fmtClock(sel.end)}
        >›</div>
      </div>

      <div className="tl-actions">
        <button
          type="button"
          className="chip-btn primary"
          disabled={isFullRange || duration <= 0}
          onClick={() => onTrimPrompt(`Trim the video to keep only seconds ${fmtSeconds(sel.start)} to ${fmtSeconds(sel.end)}`)}
        >
          ✂ Trim to selection
        </button>
        <button
          type="button"
          className="chip-btn"
          disabled={isFullRange}
          onClick={() => setSel({ start: 0, end: duration })}
        >
          Reset range
        </button>
        <span className="tl-actions-hint">Trim fills the composer — press ↑ to run it, like any other edit.</span>
      </div>
    </div>
  );
}
