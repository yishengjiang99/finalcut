---
title: "How the GBK SoundFont renderer turns MIDI into sound"
description: "How the GBK SoundFont renderer works: MIDI notes become voices, run through envelopes, a filter and LFOs, then send effects and a mastering bus."
date: 2026-10-29
updated: 2026-10-29
publish: true
product: gbk
keyword: SoundFont renderer
tags: [gbk, soundfont, midi, dsp]
hero: hero.jpg
ogImage: og-card.jpg
image_alt: "Share card reading How the GBK SoundFont renderer turns MIDI into sound, over a waveform strip, from the GBK blog"
heroAlt: "Piano roll note bars in amber, teal and blue above two waveform traces on a dark background, the path from MIDI notes to rendered audio"
properNouns: [GBK, MIDI, SoundFont, DSP, AudioWorklet, Web, Audio]
---

[GBK](https://compose.grepawk.com/) is a music workstation that runs in the browser. Its instruments are SoundFonts: banks of recorded samples with rules for how each sample should be played. The SoundFont renderer that plays them is not a library. It is a custom synthesizer, written in TypeScript against the SoundFont 2.01 spec, and it runs inside an AudioWorklet. The same engine plays what you hear while you work and renders the WAV file when you export, so the mix you approved is the mix you get. This post walks through what happens between a MIDI note arriving and sound leaving. The full source of the main engine file is public: [sf2-renderer.ts](https://github.com/yishengjiang99/gbk/blob/main/src/sf2-renderer.ts).

The renderer is the end of a chain. When the workstation's agent tools write a song (see [the tools post](https://grepawk.com/blog/gbk-webmcp-music-workstation-tools) for that side), the notes still have to become audio somewhere, and that somewhere is this engine.

## From a MIDI event to a voice in the SoundFont renderer

Raw MIDI reaches the app from a few directions: a connected keyboard over Web MIDI, a MIDI file being played back by the scheduler, or you clicking notes into the piano roll. A decoder turns bytes into events (note on, note off, control change, pitch bend, channel pressure, poly pressure, program change), and every source builds its engine messages through one shared module, so a bend or a pedal from any source means the same thing downstream.

A SoundFont preset is a list of regions. Each region owns one sample and a set of rules: a key range, a velocity range, tuning, a volume envelope, a filter setting, loop points, and more. When a note on arrives, the engine walks the preset's regions and starts one voice for every region whose key range contains the note and whose velocity range contains the velocity. Layered presets are just several regions answering the same note. A note on with velocity 0 is treated as a note off, as the MIDI spec requires.

Before the new voices start, the engine checks exclusive classes. Drum kits use these so a closed hi-hat cuts an open one. Voices in the same class, on the same channel and preset, get a 5 ms fast release instead of ringing on.

Polyphony is capped at 64 voices by default. The voice pool is preallocated and the render loop allocates nothing, which matters inside an AudioWorklet. When the pool is full and a new note needs a voice, the engine frees the quietest one, ranked by envelope level times voice gain, and gives it to the new note. The cut is hard, not a fade. In practice the quietest voice is usually one already fading out, but at the limit the cut is real and immediate.

## One voice: sample playback, envelopes, filter, modulation

A voice plays its sample back at a rate that does the pitch work. If the sample was recorded at its root key and the note is a semitone up, the rate is 2^(100/1200) times the sample rate ratio, with coarse and fine tuning and the region's scale tuning folded in. The read position advances by that rate each output frame, and the sample value comes from linear interpolation between the two nearest samples:

```ts
function readSampleMono(data: Float32Array, pos: number): number {
  // Non-finite / absurd positions (pathological tuning) read silence.
  if (!Number.isFinite(pos) || !(Math.abs(pos) < 9e15)) return 0;
  const i = Math.trunc(pos);
  const f = pos - i;
  const len = data.length;
  const a = i >= 0 && i < len ? data[i] : 0;
  const b = i + 1 >= 0 && i + 1 < len ? data[i + 1] : 0;
  return a + (b - a) * f;
}
```

Loops follow the sample modes in the file. Mode 1 loops for as long as the key is held. Mode 3 loops while held and then plays the rest of the sample as a tail once the key is released. A loop shorter than two samples is ignored and the region plays once, because a loop that small cannot sound like anything but a click.

The volume envelope has the six SoundFont stages: delay, attack, hold, decay, sustain, release. Attack rises in a straight line. Decay and release fall at a constant rate in decibels per second, ending 96 dB down, which is the spec's picture of silence. Envelope times are stored as timecents, where 1200 timecents is a doubling of time, and hold and decay times shift with the note number when the file asks for key tracking.

There is a second envelope, the modulation envelope, with the same stages but a convex attack and linear decay. It does not touch volume. It pushes pitch and filter cutoff. Two triangle LFOs run alongside it: a modulation LFO that can drive pitch, cutoff, and volume (that last one is tremolo), and a vibrato LFO that drives pitch only. All three are evaluated per sample, per voice, so a filter sweep follows the envelope exactly rather than in control-rate steps.

The filter is a two-pole lowpass, an RBJ biquad, with its coefficients recomputed only when the cutoff moves. Cutoff is stored in absolute cents, converted with Hz = 8.176 * 2^(cents/1200), then shifted per frame by the modulation envelope and LFO. Resonance is given in centibels; as Q rises, the voice gain is turned down by the matching amount so the filter peak does not add net level. When the filter is fully open and Q is zero, the voice skips it entirely.

Underneath all of this sits the SoundFont modulator system, which is how MIDI controllers get wired to sound parameters. A modulator says: take a source (velocity, a CC, the pitch wheel, pressure), run it through a curve (linear, concave, convex, or switch), scale it, and add it to a destination parameter. The spec's default modulators do most of the everyday work:

```ts
mod(0x0587, 48, 960),   // CC7 volume -> attenuation, concave
mod(0x028a, 17, 1000),  // CC10 pan -> pan, bipolar
mod(0x058b, 48, 960),   // CC11 expression -> attenuation, concave
mod(0x0081, 6, 50),     // CC1 mod wheel -> vibrato depth
```

So CC7 and CC11 do not have special-case code in the engine. They land on the voice gain because the default modulators say so, and a SoundFont that defines its own modulators can rewire them. Velocity works the same way, pushing both attenuation and filter cutoff. Pitch bend is a modulator too, scaled by the channel's pitch wheel sensitivity, which defaults to plus or minus 2 semitones and can be set with the standard RPN messages. Pan per voice uses a simple linear law: left gain (1 - pan) / 2, right gain (1 + pan) / 2.

The pedal and channel messages are handled where the spec puts them. Sustain (CC64) defers note offs until the pedal lifts. Sostenuto (CC66) captures the notes held when it engages and defers only those. Soft pedal (CC67) is read at note on and makes new voices quieter and darker, by 60 centibels of attenuation and 600 cents of cutoff. CC120 kills a channel's voices at once; CC123 sends normal note offs; CC121 resets the channel. SoundFont NRPN messages can offset any generator on a channel, and program change picks the preset by bank and program, with channel 10 (index 9) always reading the drum bank, bank 128.

## Sends, effects, and the master bus

While a voice renders, some of its output is also tapped into two send buses, in proportion to the region's chorus and reverb send values. CC91 and CC93 feed those sends through modulators as well. A file-format quirk matters here: the 2.04 default modulator set drops the CC91 and CC93 entries, so the engine adds them back itself for voices that lack them. Otherwise the standard "reverb" and "chorus" knobs on a controller would do nothing with modern files.

The reverb is a Freeverb-style design: eight lowpass feedback comb filters and four series allpass filters per channel, with tunings scaled to the output sample rate. The send bus is summed to mono and fed in at the level Freeverb uses, and the wet return is scaled to match the level FluidSynth produces by default. The chorus is two modulated delay lines, the right one a quarter cycle behind the left, with a 12 ms base delay, 4 ms of depth, a 0.6 Hz rate, and a wet level of 0.7 by default. Both effects are global and send-based. There are no per-voice insert effects. Room size, damping, and the chorus parameters can be changed while playing.

The dry voice mix and the wet returns are summed, and then the whole thing runs through a master bus that the SoundFont spec does not define at all. It exists because 64 voices of raw samples can be very loud. The stages run in a fixed order:

1. Master gain, -3 dB by default.
2. A stereo-linked compressor (threshold -6 dB, ratio 4:1, 6 dB soft knee, 5 ms attack, 100 ms release) that reads the peak of both channels and turns both down together, so the stereo image does not wobble.
3. A lookahead peak limiter with 1.5 ms of lookahead and a ceiling of -0.3 dBFS.
4. A safety soft clip that is exact below 90 percent of the ceiling and approaches the ceiling through a tanh curve, so the output can never exceed it.

After the bus, each track gets its own pan (an orchestra seating pan, not the per-voice pan) and a fader that glides to its target with a 10 ms time constant, which is what makes mute and solo changes click-free.

## The same engine renders the export

Exporting a WAV does not switch synthesizers. The project is turned into a plan of frame-scheduled events, the plan is handed to the same AudioWorklet running in an OfflineAudioContext, and the worklet confirms the sequence is loaded before rendering starts, so every event is in place before frame 0. A parallel path runs the same processor core in Web Workers, one engine per track, and gets sample-identical results. The only step after synthesis is a single whole-file gain, set by measuring the loudness of the whole render (target -16 LUFS, capped at -1 dB true peak). One gain for the whole file, so the dynamics written into the song, velocities and CC swells included, survive unchanged.

## What it does not do

Some edges are worth stating plainly. There is no portamento or legato; notes start where they start. Pitch bend is per channel, so there is no per-note bend or MPE. Note off velocity is ignored. Pedals are read as on or off at the halfway point, with no half-pedal shading. The engine's own program change reads the bank from CC0 only; the bank LSB (CC32) is folded in by the parts of the app that resolve presets outside the engine. And the cut that frees a voice when the pool is full, described above, is a real cut. These are the current limits of the code, not aspirations.

## Try it

Open GBK, load a SoundFont, and play. Everything in this post, the voices, the pedal behavior, the reverb sends, the limiter catching a loud chord, is running in your browser tab, in the AudioWorklet, with nothing synthesized on a server.
