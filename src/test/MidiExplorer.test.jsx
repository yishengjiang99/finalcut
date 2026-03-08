import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MidiExplorer, {
  midiNoteToFrequency,
  readVLQ,
  parseMidi,
  ticksToSeconds,
  audioBufferToWav,
  renderMidiOffline,
} from '../MidiExplorer.jsx';

// ── Helper: build a minimal MIDI Type-0 file (ArrayBuffer) ─────────────────
// Creates a single-track MIDI with the given note events already
// encoded so parseMidi() can read them back.
function buildMidiBuffer({ bpm = 120, timeDivision = 480, noteEvents = [] } = {}) {
  // Each noteEvent: { note, velocity, onTick, offTick }
  const microsecondsPerBeat = Math.round(60_000_000 / bpm);

  // Build track data byte-by-byte
  const trackBytes = [];

  const pushVLQ = (val) => {
    if (val === 0) { trackBytes.push(0); return; }
    const buf = [];
    while (val > 0) { buf.unshift(val & 0x7F); val >>= 7; }
    for (let i = 0; i < buf.length - 1; i++) buf[i] |= 0x80;
    buf.forEach((b) => trackBytes.push(b));
  };

  // Tempo meta-event at tick 0
  pushVLQ(0);           // delta
  trackBytes.push(0xFF, 0x51, 0x03);
  trackBytes.push((microsecondsPerBeat >> 16) & 0xFF);
  trackBytes.push((microsecondsPerBeat >> 8) & 0xFF);
  trackBytes.push(microsecondsPerBeat & 0xFF);

  // Collect all on/off ticks sorted
  const events = [];
  for (const { note, velocity = 64, onTick, offTick } of noteEvents) {
    events.push({ tick: onTick, type: 'on', note, velocity });
    events.push({ tick: offTick, type: 'off', note });
  }
  events.sort((a, b) => a.tick - b.tick);

  let currentTick = 0;
  for (const ev of events) {
    pushVLQ(ev.tick - currentTick);
    currentTick = ev.tick;
    if (ev.type === 'on') {
      trackBytes.push(0x90, ev.note, ev.velocity);
    } else {
      trackBytes.push(0x80, ev.note, 0x00);
    }
  }

  // End-of-track meta-event
  pushVLQ(0);
  trackBytes.push(0xFF, 0x2F, 0x00);

  const trackLen = trackBytes.length;

  // Assemble full MIDI file
  // MThd = 4(tag) + 4(length field) + 6(header data) = 14 bytes
  // MTrk = 4(tag) + 4(length field) + trackLen bytes
  const totalLen = 14 + 4 + 4 + trackLen;
  const buf = new ArrayBuffer(totalLen);
  const view = new DataView(buf);
  let off = 0;

  // MThd
  'MThd'.split('').forEach((c) => view.setUint8(off++, c.charCodeAt(0)));
  view.setUint32(off, 6); off += 4;
  view.setUint16(off, 0); off += 2; // format 0
  view.setUint16(off, 1); off += 2; // 1 track
  view.setUint16(off, timeDivision); off += 2;

  // MTrk
  'MTrk'.split('').forEach((c) => view.setUint8(off++, c.charCodeAt(0)));
  view.setUint32(off, trackLen); off += 4;
  for (const b of trackBytes) view.setUint8(off++, b);

  return buf;
}

// ── Minimal mock AudioBuffer ───────────────────────────────────────────────
function makeMockAudioBuffer(length = 100, numChannels = 2, sampleRate = 44100) {
  const channels = Array.from({ length: numChannels }, () => new Float32Array(length));
  return {
    length,
    numberOfChannels: numChannels,
    sampleRate,
    getChannelData: (ch) => channels[ch],
  };
}

// ── Mock OfflineAudioContext ───────────────────────────────────────────────
class MockOfflineAudioContext {
  constructor(channels, length, sampleRate) {
    this.sampleRate = sampleRate;
    this._length = length;
    this._channels = channels;
  }
  createOscillator() {
    return {
      type: '',
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
  }
  get destination() { return {}; }
  startRendering() {
    return Promise.resolve(makeMockAudioBuffer(this._length, this._channels, this.sampleRate));
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('midiNoteToFrequency', () => {
  it('returns 440 Hz for MIDI note 69 (A4)', () => {
    expect(midiNoteToFrequency(69)).toBeCloseTo(440, 1);
  });

  it('returns 880 Hz for MIDI note 81 (one octave above A4)', () => {
    expect(midiNoteToFrequency(81)).toBeCloseTo(880, 1);
  });

  it('returns 220 Hz for MIDI note 57 (one octave below A4)', () => {
    expect(midiNoteToFrequency(57)).toBeCloseTo(220, 1);
  });

  it('returns ~261.63 Hz for MIDI note 60 (Middle C)', () => {
    expect(midiNoteToFrequency(60)).toBeCloseTo(261.63, 1);
  });
});

describe('readVLQ', () => {
  it('decodes a single-byte value (no continuation bits)', () => {
    const data = new Uint8Array([0x40]); // 64
    const { value, bytesRead } = readVLQ(data, 0);
    expect(value).toBe(64);
    expect(bytesRead).toBe(1);
  });

  it('decodes a two-byte VLQ value', () => {
    // 0x81 0x00 encodes 128
    const data = new Uint8Array([0x81, 0x00]);
    const { value, bytesRead } = readVLQ(data, 0);
    expect(value).toBe(128);
    expect(bytesRead).toBe(2);
  });

  it('decodes zero correctly', () => {
    const data = new Uint8Array([0x00]);
    const { value, bytesRead } = readVLQ(data, 0);
    expect(value).toBe(0);
    expect(bytesRead).toBe(1);
  });

  it('respects the offset parameter', () => {
    const data = new Uint8Array([0xFF, 0x40]); // skip first byte
    const { value, bytesRead } = readVLQ(data, 1);
    expect(value).toBe(64);
    expect(bytesRead).toBe(1);
  });

  it('throws on unexpected end of data', () => {
    const data = new Uint8Array([0x81]); // continuation bit set but no next byte
    expect(() => readVLQ(data, 0)).toThrow();
  });
});

describe('ticksToSeconds', () => {
  it('converts ticks to seconds correctly at 120 BPM, 480 PPQ', () => {
    // 120 BPM → 500000 µs/beat, 480 ticks/beat
    // 480 ticks = 1 beat = 0.5 s
    expect(ticksToSeconds(480, 480, 500_000)).toBeCloseTo(0.5);
  });

  it('returns 0 for 0 ticks', () => {
    expect(ticksToSeconds(0, 480, 500_000)).toBe(0);
  });

  it('handles different tempos', () => {
    // 60 BPM → 1_000_000 µs/beat, 480 ticks/beat → 480 ticks = 1 s
    expect(ticksToSeconds(480, 480, 1_000_000)).toBeCloseTo(1.0);
  });
});

describe('parseMidi', () => {
  it('throws on a buffer with invalid header', () => {
    const buf = new ArrayBuffer(14);
    new Uint8Array(buf).set([0x00, 0x00, 0x00, 0x00]);
    expect(() => parseMidi(buf)).toThrow('Invalid MIDI file');
  });

  it('parses a valid MIDI file with a single note', () => {
    const buf = buildMidiBuffer({
      bpm: 120,
      timeDivision: 480,
      noteEvents: [{ note: 60, velocity: 80, onTick: 0, offTick: 480 }],
    });
    const result = parseMidi(buf);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].note).toBe(60);
    expect(result.notes[0].velocity).toBe(80);
    expect(result.notes[0].startTick).toBe(0);
    expect(result.notes[0].endTick).toBe(480);
    expect(result.timeDivision).toBe(480);
    expect(result.tempoMicrosPerBeat).toBe(500_000);
    expect(result.format).toBe(0);
    expect(result.numTracks).toBe(1);
  });

  it('parses a MIDI file with multiple notes', () => {
    const buf = buildMidiBuffer({
      noteEvents: [
        { note: 60, velocity: 64, onTick: 0, offTick: 240 },
        { note: 64, velocity: 64, onTick: 240, offTick: 480 },
        { note: 67, velocity: 64, onTick: 480, offTick: 720 },
      ],
    });
    const result = parseMidi(buf);
    expect(result.notes).toHaveLength(3);
  });

  it('reads the tempo from a Set Tempo meta-event', () => {
    const buf = buildMidiBuffer({ bpm: 60 }); // 60 BPM → 1_000_000 µs/beat
    const result = parseMidi(buf);
    expect(result.tempoMicrosPerBeat).toBe(1_000_000);
  });

  it('returns empty notes array for a MIDI file with no note events', () => {
    const buf = buildMidiBuffer({ noteEvents: [] });
    const result = parseMidi(buf);
    expect(result.notes).toHaveLength(0);
  });
});

describe('audioBufferToWav', () => {
  it('produces a buffer starting with the RIFF header', () => {
    const mockBuf = makeMockAudioBuffer(100, 2, 44100);
    const wavBuf = audioBufferToWav(mockBuf);
    const view = new DataView(wavBuf);
    const riff = String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
    );
    expect(riff).toBe('RIFF');
  });

  it('encodes the WAVE format identifier', () => {
    const mockBuf = makeMockAudioBuffer(100, 2, 44100);
    const wavBuf = audioBufferToWav(mockBuf);
    const view = new DataView(wavBuf);
    const wave = String.fromCharCode(
      view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)
    );
    expect(wave).toBe('WAVE');
  });

  it('sets the correct sample rate in the fmt chunk', () => {
    const sampleRate = 44100;
    const mockBuf = makeMockAudioBuffer(100, 2, sampleRate);
    const wavBuf = audioBufferToWav(mockBuf);
    const view = new DataView(wavBuf);
    expect(view.getUint32(24, true)).toBe(sampleRate);
  });

  it('sets PCM audio format (1) in the fmt chunk', () => {
    const mockBuf = makeMockAudioBuffer(100, 1, 44100);
    const wavBuf = audioBufferToWav(mockBuf);
    const view = new DataView(wavBuf);
    expect(view.getUint16(20, true)).toBe(1); // PCM = 1
  });

  it('sets the correct number of channels', () => {
    const mockBuf = makeMockAudioBuffer(100, 2, 44100);
    const wavBuf = audioBufferToWav(mockBuf);
    const view = new DataView(wavBuf);
    expect(view.getUint16(22, true)).toBe(2);
  });

  it('produces the correct total buffer size', () => {
    const numSamples = 100;
    const numChannels = 2;
    const mockBuf = makeMockAudioBuffer(numSamples, numChannels, 44100);
    const wavBuf = audioBufferToWav(mockBuf);
    // 44-byte header + 100 * 2 channels * 2 bytes/sample
    expect(wavBuf.byteLength).toBe(44 + numSamples * numChannels * 2);
  });
});

describe('renderMidiOffline', () => {
  beforeEach(() => {
    global.OfflineAudioContext = MockOfflineAudioContext;
  });

  it('resolves to an AudioBuffer', async () => {
    const notes = [{ note: 60, channel: 0, startTick: 0, endTick: 480, velocity: 64 }];
    const result = await renderMidiOffline(notes, 480, 500_000);
    expect(result).toBeDefined();
    expect(typeof result.getChannelData).toBe('function');
  });

  it('throws when given an empty notes array', async () => {
    await expect(renderMidiOffline([], 480, 500_000)).rejects.toThrow('No notes to render');
  });

  it('accepts a custom sample rate', async () => {
    const notes = [{ note: 69, channel: 0, startTick: 0, endTick: 480, velocity: 80 }];
    const buf = await renderMidiOffline(notes, 480, 500_000, 22050);
    expect(buf.sampleRate).toBe(22050);
  });
});

// ── Component (UI) tests ───────────────────────────────────────────────────

describe('MidiExplorer component', () => {
  beforeEach(() => {
    global.OfflineAudioContext = MockOfflineAudioContext;
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-wav-url');
    global.URL.revokeObjectURL = vi.fn();
  });

  it('renders the heading', () => {
    render(<MidiExplorer />);
    expect(screen.getByText(/MIDI Explorer/i)).toBeInTheDocument();
  });

  it('renders the file input accepting .mid/.midi', () => {
    render(<MidiExplorer />);
    const input = screen.getByLabelText(/Upload MIDI File/i);
    expect(input).toBeInTheDocument();
    expect(input.getAttribute('accept')).toContain('.mid');
  });

  it('does not show the Generate WAV button before a file is loaded', () => {
    render(<MidiExplorer />);
    expect(screen.queryByText(/Generate WAV/i)).not.toBeInTheDocument();
  });

  it('shows MIDI info and Generate button after a valid file is loaded', async () => {
    render(<MidiExplorer />);

    const buf = buildMidiBuffer({
      noteEvents: [{ note: 60, velocity: 64, onTick: 0, offTick: 480 }],
    });
    const file = new File([buf], 'test.mid', { type: 'audio/midi' });
    file.arrayBuffer = () => Promise.resolve(buf);

    const input = screen.getByLabelText(/Upload MIDI File/i);
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate WAV/i })).toBeInTheDocument();
    });

    expect(screen.getByText(/MIDI Info/i)).toBeInTheDocument();
    expect(screen.getByText(/Notes/i)).toBeInTheDocument();
  });

  it('shows an error message when an invalid file is loaded', async () => {
    render(<MidiExplorer />);

    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([0x00, 0x01, 0x02, 0x03]);
    const file = new File([buf], 'bad.mid', { type: 'audio/midi' });
    file.arrayBuffer = () => Promise.resolve(buf);

    const input = screen.getByLabelText(/Upload MIDI File/i);
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/Invalid MIDI file/i)).toBeInTheDocument();
    });
  });

  it('generates a WAV and shows the audio player after clicking Generate', async () => {
    render(<MidiExplorer />);

    const buf = buildMidiBuffer({
      noteEvents: [{ note: 60, velocity: 64, onTick: 0, offTick: 480 }],
    });
    const file = new File([buf], 'song.mid', { type: 'audio/midi' });
    file.arrayBuffer = () => Promise.resolve(buf);

    const input = screen.getByLabelText(/Upload MIDI File/i);
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => screen.getByRole('button', { name: /Generate WAV/i }));

    fireEvent.click(screen.getByRole('button', { name: /Generate WAV/i }));

    await waitFor(() => {
      expect(screen.getByText(/WAV generated successfully/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Download WAV/i)).toBeInTheDocument();
  });
});
