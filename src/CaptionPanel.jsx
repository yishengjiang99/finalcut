import React from 'react';
import { SIZE_SCALES, POSITION_RANGE } from './captionTrack.js';

/** Style controls and export actions for a caption track. Style changes update the overlay live. */
export default function CaptionPanel({ track, disabled = false, onStyle, onExport, onSrt, onAss, onRemove }) {
  if (!track) return null;
  const { positionFromBottomPct, sizeScale } = track.style;
  return (
    <div className="cap-panel" data-testid="caption-panel">
      <div className="cap-row">
        <label htmlFor={`cap-pos-${track.id}`}>Height from bottom <b>{positionFromBottomPct}%</b></label>
        <input
          id={`cap-pos-${track.id}`}
          type="range"
          min={POSITION_RANGE.min}
          max={POSITION_RANGE.max}
          step="1"
          value={positionFromBottomPct}
          disabled={disabled}
          onChange={(e) => onStyle({ positionFromBottomPct: Number(e.target.value) })}
        />
      </div>
      <div className="cap-row" role="group" aria-label="Caption size">
        <span>Size</span>
        <div className="cap-sizes">
          {SIZE_SCALES.map(({ id, label, scale }) => (
            <button key={id} type="button" className={`chip-btn${Math.abs(sizeScale - scale) < 0.01 ? ' on' : ''}`} disabled={disabled} onClick={() => onStyle({ sizeScale: scale })}>{label}</button>
          ))}
        </div>
      </div>
      <p className="cap-note">Preview only. The captions are burned into the video when you export.</p>
      <div className="rc-actions">
        <button type="button" className="chip-btn primary" disabled={disabled} onClick={onExport}>Export…</button>
        <button type="button" className="chip-btn" onClick={onSrt}>⬇ SRT</button>
        <button type="button" className="chip-btn" onClick={onAss}>⬇ ASS</button>
        <button type="button" className="chip-btn" disabled={disabled} onClick={onRemove}>Remove captions</button>
      </div>
    </div>
  );
}
