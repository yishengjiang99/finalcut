import React, { useState, useRef } from 'react';

// Convert MIDI note number to frequency (Hz)
export function midiNoteToFrequency(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

// Read a variable-length quantity (VLQ) from a Uint8Array at a given offset.
// Returns the decoded integer value and the number of bytes consumed.
export function readVLQ(data, offset) {
  let value = 0;
  let bytesRead = 0;
  let byte;
  do {
    if (offset + bytesRead >= data.length) {
      throw new Error('Unexpected end of data while reading VLQ');
    }
    byte = data[offset + bytesRead];
    value = (value << 7) | (byte & 0x7F);
    bytesRead++;
  } while (byte & 0x80);
  return { value, bytesRead };
}

// Parse a MIDI file (ArrayBuffer) and return note events with tick-based timing.
// Returns { notes, timeDivision, tempoMicrosPerBeat, format, numTracks }.
export function parseMidi(buffer) {
  const data = new Uint8Array(buffer);
  let offset = 0;

  const readUint32 = (off) =>
    ((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]) >>> 0;
  const readUint16 = (off) => ((data[off] << 8) | data[off + 1]) >>> 0;

  // Validate and parse the header chunk
  const headerTag = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (headerTag !== 'MThd') {
    throw new Error('Invalid MIDI file: missing MThd header');
  }
  offset += 4;

  const headerLength = readUint32(offset);
  offset += 4;

  const format = readUint16(offset);
  const numTracks = readUint16(offset + 2);
  const timeDivision = readUint16(offset + 4);
  offset += headerLength;

  if (timeDivision & 0x8000) {
    throw new Error('SMPTE time division not supported');
  }

  let tempoMicrosPerBeat = 500000; // Default 120 BPM
  const notes = [];

  // Parse each track chunk
  for (let trackIdx = 0; trackIdx < numTracks; trackIdx++) {
    if (offset + 8 > data.length) break;

    const trackTag = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
    if (trackTag !== 'MTrk') break;
    offset += 4;

    const trackLength = readUint32(offset);
    offset += 4;
    const trackEnd = offset + trackLength;

    let tickTime = 0;
    let lastStatus = 0;
    // Map of "channel-note" -> { tick, velocity } for active (sounding) notes
    const activeNotes = {};

    while (offset < trackEnd) {
      const { value: delta, bytesRead } = readVLQ(data, offset);
      offset += bytesRead;
      tickTime += delta;

      let statusByte = data[offset];

      // Running status: if the high bit is not set, reuse the last status byte
      if (statusByte & 0x80) {
        lastStatus = statusByte;
        offset++;
      } else {
        statusByte = lastStatus;
      }

      const eventType = statusByte & 0xF0;

      if (statusByte === 0xFF) {
        // Meta event
        const metaType = data[offset];
        offset++;
        const { value: metaLength, bytesRead: mlb } = readVLQ(data, offset);
        offset += mlb;

        if (metaType === 0x51 && metaLength === 3) {
          // Set Tempo: 3 bytes, microseconds per quarter note
          tempoMicrosPerBeat =
            (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
        }
        offset += metaLength;
      } else if (statusByte === 0xF0 || statusByte === 0xF7) {
        // SysEx event
        const { value: sysexLength, bytesRead: slb } = readVLQ(data, offset);
        offset += slb + sysexLength;
      } else if (eventType === 0x90) {
        // Note On
        const note = data[offset++];
        const velocity = data[offset++];
        if (velocity > 0) {
          activeNotes[`${statusByte & 0x0F}-${note}`] = { tick: tickTime, velocity };
        } else {
          // Note On with velocity 0 is treated as Note Off
          const key = `${statusByte & 0x0F}-${note}`;
          if (activeNotes[key]) {
            notes.push({
              note,
              channel: statusByte & 0x0F,
              startTick: activeNotes[key].tick,
              endTick: tickTime,
              velocity: activeNotes[key].velocity,
            });
            delete activeNotes[key];
          }
        }
      } else if (eventType === 0x80) {
        // Note Off
        const note = data[offset++];
        offset++; // ignore release velocity
        const key = `${statusByte & 0x0F}-${note}`;
        if (activeNotes[key]) {
          notes.push({
            note,
            channel: statusByte & 0x0F,
            startTick: activeNotes[key].tick,
            endTick: tickTime,
            velocity: activeNotes[key].velocity,
          });
          delete activeNotes[key];
        }
      } else if (eventType === 0xA0) {
        offset += 2; // Polyphonic key pressure (aftertouch)
      } else if (eventType === 0xB0) {
        offset += 2; // Control change
      } else if (eventType === 0xC0) {
        offset += 1; // Program change
      } else if (eventType === 0xD0) {
        offset += 1; // Channel pressure
      } else if (eventType === 0xE0) {
        offset += 2; // Pitch bend
      } else {
        // Unknown byte — skip to avoid infinite loops
        offset++;
      }
    }

    // Close any notes that were never explicitly released (end-of-track)
    for (const key of Object.keys(activeNotes)) {
      const [channel, note] = key.split('-').map(Number);
      notes.push({
        note,
        channel,
        startTick: activeNotes[key].tick,
        endTick: tickTime,
        velocity: activeNotes[key].velocity,
      });
    }

    offset = trackEnd;
  }

  return { notes, timeDivision, tempoMicrosPerBeat, format, numTracks };
}

// Convert a tick count to wall-clock seconds given timing parameters.
export function ticksToSeconds(ticks, timeDivision, tempoMicrosPerBeat) {
  return (ticks / timeDivision) * (tempoMicrosPerBeat / 1_000_000);
}

// Encode a Web Audio API AudioBuffer as a 16-bit PCM WAV ArrayBuffer.
export function audioBufferToWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const bytesPerSample = 2; // 16-bit PCM
  const dataSize = numSamples * numChannels * bytesPerSample;

  const wavBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wavBuffer);

  const writeString = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  // RIFF chunk descriptor
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');

  // fmt sub-chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);                                    // sub-chunk size (PCM = 16)
  view.setUint16(20, 1, true);                                     // AudioFormat: PCM = 1
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
  view.setUint16(32, numChannels * bytesPerSample, true);          // BlockAlign
  view.setUint16(34, 16, true);                                    // BitsPerSample

  // data sub-chunk
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channel samples and write as little-endian int16
  let byteOffset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = audioBuffer.getChannelData(ch)[i];
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(byteOffset, clamped * 0x7FFF, true);
      byteOffset += 2;
    }
  }

  return wavBuffer;
}

// Render MIDI notes using OfflineAudioContext and return an AudioBuffer.
export async function renderMidiOffline(notes, timeDivision, tempoMicrosPerBeat, sampleRate = 44100) {
  if (notes.length === 0) throw new Error('No notes to render');

  const lastTick = Math.max(...notes.map((n) => n.endTick));
  const totalDuration = ticksToSeconds(lastTick, timeDivision, tempoMicrosPerBeat);
  // Add a short tail so the last note's release envelope has room to fade
  const totalSamples = Math.ceil((totalDuration + 1.0) * sampleRate);

  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

  // Master gain to keep the mix from clipping when many notes overlap
  const masterGain = offlineCtx.createGain();
  masterGain.gain.value = 0.6;
  masterGain.connect(offlineCtx.destination);

  notes.forEach(({ note, startTick, endTick, velocity }) => {
    const startTime = ticksToSeconds(startTick, timeDivision, tempoMicrosPerBeat);
    const endTime = ticksToSeconds(endTick, timeDivision, tempoMicrosPerBeat);
    const freq = midiNoteToFrequency(note);
    const amp = (velocity / 127) * 0.4;
    const attackTime = 0.01;
    const releaseTime = 0.08;

    const osc = offlineCtx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const gainNode = offlineCtx.createGain();
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(amp, startTime + attackTime);
    // Sustain at full amp until release
    const releaseStart = Math.max(startTime + attackTime, endTime - releaseTime);
    gainNode.gain.setValueAtTime(amp, releaseStart);
    gainNode.gain.linearRampToValueAtTime(0, endTime + releaseTime);

    osc.connect(gainNode);
    gainNode.connect(masterGain);

    osc.start(startTime);
    osc.stop(endTime + releaseTime + 0.01);
  });

  return offlineCtx.startRendering();
}

// ─── React Component ──────────────────────────────────────────────────────────

export default function MidiExplorer() {
  const [midiInfo, setMidiInfo] = useState(null);
  const [status, setStatus] = useState('');
  const [isRendering, setIsRendering] = useState(false);
  const [wavUrl, setWavUrl] = useState(null);
  const [error, setError] = useState(null);
  const parsedMidiRef = useRef(null);
  const fileNameRef = useRef('output');

  const resetOutput = () => {
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    setWavUrl(null);
    setError(null);
    setStatus('');
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    fileNameRef.current = file.name.replace(/\.[^.]+$/, '');
    resetOutput();
    setStatus('Parsing MIDI file…');

    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseMidi(buffer);
      parsedMidiRef.current = parsed;

      const lastTick =
        parsed.notes.length > 0 ? Math.max(...parsed.notes.map((n) => n.endTick)) : 0;
      const duration = ticksToSeconds(
        lastTick,
        parsed.timeDivision,
        parsed.tempoMicrosPerBeat
      );

      setMidiInfo({
        format: parsed.format,
        numTracks: parsed.numTracks,
        noteCount: parsed.notes.length,
        timeDivision: parsed.timeDivision,
        bpm: Math.round(60_000_000 / parsed.tempoMicrosPerBeat),
        duration: duration.toFixed(2),
      });
      setStatus('MIDI file loaded. Ready to generate WAV.');
    } catch (err) {
      setError(err.message);
      setStatus('');
    }
  };

  const handleGenerateWav = async () => {
    if (!parsedMidiRef.current) return;
    const { notes, timeDivision, tempoMicrosPerBeat } = parsedMidiRef.current;
    if (notes.length === 0) {
      setError('No note events found in this MIDI file.');
      return;
    }

    setIsRendering(true);
    resetOutput();
    setStatus('Rendering audio offline using OfflineAudioContext…');

    try {
      const renderedBuffer = await renderMidiOffline(notes, timeDivision, tempoMicrosPerBeat);

      setStatus('Encoding WAV…');
      const wavBuffer = audioBufferToWav(renderedBuffer);
      const blob = new Blob([wavBuffer], { type: 'audio/wav' });
      setWavUrl(URL.createObjectURL(blob));
      setStatus('WAV generated successfully!');
    } catch (err) {
      setError(err.message);
      setStatus('');
    } finally {
      setIsRendering(false);
    }
  };

  const handleDownloadWav = () => {
    if (!wavUrl) return;
    const a = document.createElement('a');
    a.href = wavUrl;
    a.download = `${fileNameRef.current}.wav`;
    a.click();
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const cardStyle = {
    backgroundColor: '#2a2f3a',
    border: '1px solid #3a4250',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
  };

  const buttonBase = {
    width: '100%',
    padding: '10px 20px',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    cursor: 'pointer',
    marginTop: '12px',
  };

  return (
    <div
      style={{
        padding: '24px',
        maxWidth: '600px',
        margin: '0 auto',
        color: '#d8dee9',
        fontFamily: 'Arial, sans-serif',
      }}
    >
      <h2 style={{ color: '#88c0d0', marginTop: 0, marginBottom: '8px' }}>🎵 MIDI Explorer</h2>
      <p style={{ color: '#9099a0', marginBottom: '24px', fontSize: '14px' }}>
        Upload a MIDI file to explore its contents, render audio offline using{' '}
        <code>OfflineAudioContext</code>, and export the result as a WAV file.
      </p>

      {/* File picker */}
      <div style={cardStyle}>
        <label
          htmlFor="midi-file-input"
          style={{ display: 'block', marginBottom: '8px', color: '#a0a8b0', fontSize: '14px' }}
        >
          Upload MIDI File (.mid / .midi)
        </label>
        <input
          id="midi-file-input"
          type="file"
          accept=".mid,.midi"
          onChange={handleFileUpload}
          style={{
            color: '#d8dee9',
            backgroundColor: '#1e2330',
            border: '1px solid #3a4250',
            borderRadius: '6px',
            padding: '8px',
            width: '100%',
            boxSizing: 'border-box',
            fontSize: '13px',
          }}
        />
      </div>

      {/* MIDI metadata */}
      {midiInfo && (
        <div style={cardStyle}>
          <h3 style={{ color: '#88c0d0', marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>
            MIDI Info
          </h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '6px 16px',
              fontSize: '14px',
              marginBottom: '4px',
            }}
          >
            <span style={{ color: '#9099a0' }}>Format</span>
            <span>{midiInfo.format}</span>
            <span style={{ color: '#9099a0' }}>Tracks</span>
            <span>{midiInfo.numTracks}</span>
            <span style={{ color: '#9099a0' }}>Notes</span>
            <span>{midiInfo.noteCount}</span>
            <span style={{ color: '#9099a0' }}>Tempo</span>
            <span>{midiInfo.bpm} BPM</span>
            <span style={{ color: '#9099a0' }}>Duration</span>
            <span>{midiInfo.duration} s</span>
          </div>

          <button
            onClick={handleGenerateWav}
            disabled={isRendering}
            style={{
              ...buttonBase,
              backgroundColor: isRendering ? '#3a4250' : '#5e81ac',
              color: isRendering ? '#6e7681' : '#eceff4',
              cursor: isRendering ? 'not-allowed' : 'pointer',
            }}
          >
            {isRendering ? '⏳ Rendering…' : '🎧 Generate WAV (Offline Mode)'}
          </button>
        </div>
      )}

      {/* Status / error messages */}
      {status && (
        <p style={{ color: '#a3be8c', fontSize: '14px', marginBottom: '12px' }}>{status}</p>
      )}
      {error && (
        <p style={{ color: '#bf616a', fontSize: '14px', marginBottom: '12px' }}>
          ⚠️ {error}
        </p>
      )}

      {/* Playback & download */}
      {wavUrl && (
        <div style={cardStyle}>
          <h3 style={{ color: '#88c0d0', marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>
            Generated Audio
          </h3>
          <audio controls src={wavUrl} style={{ width: '100%', marginBottom: '8px' }} />
          <button
            onClick={handleDownloadWav}
            style={{
              ...buttonBase,
              backgroundColor: '#a3be8c',
              color: '#2e3440',
              fontWeight: 'bold',
            }}
          >
            ⬇️ Download WAV
          </button>
        </div>
      )}
    </div>
  );
}
