// @vitest-environment node
// Deterministic end-to-end mock of the agentic timeline workflow (spec §16):
// a scripted Grok planner + a fake on-device executor (speaking the REAL
// device vocabulary of TimelineToolExecutor.swift) drive the real
// POST /api/chat client-execution loop. No network, no ffmpeg, no media.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../server/config.js', () => ({
  XAI_API_TOKEN: 'test-xai-token',
  PORT: 3001,
  TMP_DIR: '/tmp',
  IS_PRODUCTION: false,
  OPENAI_API_KEY: 'test-openai-key',
  SESSION_SECRET: 'test-session-secret',
  APP_BASE_URL: null,
  ALLOW_UNAUTH_SAMPLE_MODE: true,
  SAMPLE_TOKEN_TTL_MS: 600000,
  IOS_FREE_DAILY_INFERENCE_LIMIT: 3,
}));

const db = vi.hoisted(() => ({
  saveLesson: vi.fn().mockResolvedValue(undefined),
  enqueueChatInteraction: vi.fn(),
  findUserByApiToken: vi.fn(),
  consumeDailyInference: vi.fn(),
}));
vi.mock('../db.js', () => db);

vi.mock('fluent-ffmpeg', () => {
  const fn = () => { throw new Error('ffmpeg must not run in client mode'); };
  fn.ffprobe = () => {};
  fn.getAvailableEncoders = (cb) => cb(null, {});
  return { default: fn };
});

import express from 'express';
import { chatRouter } from '../server/chat.js';
import { issueSampleAccessToken } from '../server/middleware.js';
import { TIMELINE_TOOLS_MIN_BUILD } from '../server/iosToolAllowlist.js';

const TIMELINE_UA = `FinalCap-iOS/${TIMELINE_TOOLS_MIN_BUILD}`;
const realFetch = globalThis.fetch;
const xaiCalls = [];
let xaiResponder = null;
let server;
let base;
let token;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function completion(message) {
  return { id: 'cmpl', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] };
}
function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url).startsWith('https://api.x.ai/')) {
      const body = JSON.parse(init.body);
      xaiCalls.push(body);
      return xaiResponder(body);
    }
    return realFetch(url, init);
  });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(chatRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  xaiCalls.length = 0;
  xaiResponder = null;
  db.consumeDailyInference.mockReset();
  db.findUserByApiToken.mockReset();
  const issue = issueSampleAccessToken;
  token = issue();
});

// ─── Fake device (mirrors TimelineToolExecutor result shapes) ────────────────

function makeDevice() {
  return {
    assets: [
      { id: 'asset-beach', type: 'video', label: 'beach.mov', duration: 10, hasAudio: true },
      { id: 'asset-restaurant', type: 'video', label: 'restaurant.mov', duration: 8, hasAudio: true },
      { id: 'asset-hotel', type: 'video', label: 'hotel.mov', duration: 12, hasAudio: true },
      { id: 'asset-music', type: 'audio', label: 'music.m4a', duration: 60 },
      { id: 'asset-narration', type: 'audio', label: 'narration.m4a', duration: 8 },
    ],
    videoClips: [
      { id: 'clip-beach', assetId: 'asset-beach', sourceStart: 0, sourceEnd: 10, originalAudioEnabled: true },
      { id: 'clip-restaurant', assetId: 'asset-restaurant', sourceStart: 0, sourceEnd: 8, originalAudioEnabled: true },
      { id: 'clip-hotel', assetId: 'asset-hotel', sourceStart: 0, sourceEnd: 12, originalAudioEnabled: true },
    ],
    audioTracks: [
      { id: 'track-music', label: 'Background Music', kind: 'music', volume: 1, muted: false, clips: [] },
      { id: 'track-voice', label: 'Narration', kind: 'voiceover', volume: 1, muted: false, clips: [] },
    ],
    audioSeq: 0,
  };
}

function deviceDuration(device) {
  return device.videoClips.reduce((sum, c) => sum + (c.sourceEnd - c.sourceStart), 0);
}

/** The summary shape the device sends (media.project) and returns in output.project. */
function summary(device) {
  let cursor = 0;
  const videoClips = device.videoClips.map((c) => {
    const entry = { id: c.id, assetId: c.assetId, timelineStart: cursor, sourceStart: c.sourceStart, sourceEnd: c.sourceEnd, originalAudioEnabled: c.originalAudioEnabled };
    cursor += c.sourceEnd - c.sourceStart;
    return entry;
  });
  return {
    schemaVersion: 1,
    projectId: 'project-vacation',
    duration: deviceDuration(device),
    canvas: { width: 1920, height: 1080, fps: 30 },
    assets: device.assets,
    videoClips,
    audioTracks: device.audioTracks,
    selectedClipId: device.videoClips[0]?.id,
  };
}

function deviceSuccess(device, extra = {}) {
  return {
    ok: true, executedOn: 'device',
    output: { project_duration: deviceDuration(device), project: summary(device), ...extra },
  };
}
function deviceFailure(error) {
  return { ok: false, executedOn: 'device', error, output: {} };
}
function findAudioClip(device, clipId) {
  for (const track of device.audioTracks) {
    const clip = track.clips.find(c => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

function executeOnDevice(device, name, args) {
  switch (name) {
    case 'get_timeline':
    case 'list_project_assets':
      return deviceSuccess(device);
    case 'get_project_duration':
      return deviceSuccess(device, { duration: deviceDuration(device) });
    case 'reorder_video_clips': {
      const current = device.videoClips.map(c => c.id).sort();
      const wanted = [...args.clip_ids].sort();
      if (JSON.stringify(current) !== JSON.stringify(wanted)) return deviceFailure('invalid_arguments');
      const byId = new Map(device.videoClips.map(c => [c.id, c]));
      device.videoClips = args.clip_ids.map(id => byId.get(id));
      return deviceSuccess(device, { affected_ids: args.clip_ids });
    }
    case 'trim_video_clip': {
      const clip = device.videoClips.find(c => c.id === args.clip_id);
      if (!clip) return deviceFailure('clip_not_found: call get_timeline for current clip IDs');
      if (!(args.end > args.start)) return deviceFailure('invalid_source_range');
      clip.sourceStart = args.start;
      clip.sourceEnd = args.end;
      return deviceSuccess(device, { affected_ids: [clip.id] });
    }
    case 'insert_audio_clip': {
      const track = device.audioTracks.find(t => t.id === args.track_id);
      if (!track) return deviceFailure('audio_track_not_found');
      if (!device.assets.some(a => a.id === args.asset_id)) return deviceFailure('asset_not_found');
      device.audioSeq += 1;
      const clip = {
        id: `audio-${device.audioSeq}`, assetId: args.asset_id, timelineStart: args.timeline_start,
        sourceStart: args.source_start ?? 0,
        sourceDuration: args.source_duration ?? (device.assets.find(a => a.id === args.asset_id).duration === 60 ? 27 : 8),
        gain: args.volume ?? 1, fadeIn: 0, fadeOut: 0,
      };
      track.clips.push(clip);
      return deviceSuccess(device, { created_id: clip.id, affected_ids: [clip.id] });
    }
    case 'set_audio_fade': {
      const found = findAudioClip(device, args.clip_id);
      if (!found) return deviceFailure('audio_clip_not_found');
      if (args.type === 'in') found.clip.fadeIn = args.duration; else found.clip.fadeOut = args.duration;
      return deviceSuccess(device, { affected_ids: [found.clip.id] });
    }
    case 'mute_audio_track': {
      if (args.clip_id) {
        const clip = device.videoClips.find(c => c.id === args.clip_id);
        if (!clip) return deviceFailure('clip_not_found: call get_timeline for current clip IDs');
        clip.originalAudioEnabled = !(args.muted ?? true);
        return deviceSuccess(device, { affected_ids: [clip.id] });
      }
      const track = device.audioTracks.find(t => t.id === args.track_id);
      if (!track) return deviceFailure('audio_track_not_found');
      track.muted = args.muted ?? true;
      return deviceSuccess(device, { affected_ids: [track.id] });
    }
    default:
      return deviceFailure('unsupported_on_device');
  }
}

function projectSnapshot(device) {
  return summary(device);
}

/** Drive one user turn through the real endpoint until the server answers `final`. */
async function runTurn({ device, messages, project }) {
  let current = messages;
  let turnToken;
  for (let round = 0; round < 10; round += 1) {
    const res = await realFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'sample-access-token': token, 'user-agent': TIMELINE_UA },
      body: JSON.stringify({
        execution: 'client',
        messages: current,
        media: { type: 'video', duration: deviceDuration(device), width: 1920, height: 1080, hasAudio: true },
        project: project ?? projectSnapshot(device),
        ...(turnToken ? { turnToken } : {}),
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    if (body.status === 'final') return body;
    expect(body.status).toBe('tool_calls');
    turnToken = body.turnToken;
    const toolMessages = body.toolCalls.map((call) => {
      const result = call.argumentsError
        ? { ok: false, executedOn: 'device', error: call.argumentsError, output: {} }
        : executeOnDevice(device, call.name, call.arguments);
      return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
    });
    current = [...body.messages, ...toolMessages];
  }
  throw new Error('turn did not finish within 10 rounds');
}

// ─── Conversation-reading helpers for the scripted planners ──────────────────

function callNameById(body) {
  const map = new Map();
  for (const m of body.messages) for (const c of m.tool_calls || []) map.set(c.id, c.function.name);
  return map;
}
function resultsByName(body) {
  const names = callNameById(body);
  const out = [];
  for (const m of body.messages) {
    if (m.role !== 'tool') continue;
    let parsed = null;
    try { parsed = JSON.parse(m.content); } catch { /* keep null */ }
    out.push({ name: names.get(m.tool_call_id), result: parsed });
  }
  return out;
}

// ─── Scenario 1: the §16 montage request ─────────────────────────────────────

describe('agentic timeline editing (mocked Grok + device)', () => {
  it('§16: beach/restaurant/hotel order kept, restaurant trimmed to 5s, music at 20%, narration at 12s, 2s fade-out → 27s', async () => {
    const device = makeDevice();
    let seq = 0;
    const nextId = () => `call_${(seq += 1)}`;
    xaiResponder = (body) => {
      const results = resultsByName(body);
      const names = results.map(r => r.name);
      if (!names.includes('get_timeline')) {
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'get_timeline', {})] }));
      }
      if (!names.includes('trim_video_clip')) {
        const timeline = results.filter(r => r.name === 'get_timeline').at(-1).result.output.project;
        const restaurant = timeline.videoClips.find(c => c.assetId === 'asset-restaurant');
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'trim_video_clip', { clip_id: restaurant.id, start: 0, end: 5 })] }));
      }
      const inserts = results.filter(r => r.name === 'insert_audio_clip');
      if (inserts.length === 0) {
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'insert_audio_clip', { track_id: 'track-music', asset_id: 'asset-music', timeline_start: 0, volume: 0.2 })] }));
      }
      if (inserts.length === 1) {
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'insert_audio_clip', { track_id: 'track-voice', asset_id: 'asset-narration', timeline_start: 12 })] }));
      }
      if (!names.includes('set_audio_fade')) {
        const musicClipId = inserts[0].result.output.created_id;
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'set_audio_fade', { clip_id: musicClipId, type: 'out', duration: 2 })] }));
      }
      if (results.filter(r => r.name === 'get_timeline').length < 2) {
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'get_timeline', {})] }));
      }
      const duration = results.filter(r => r.name === 'get_timeline').at(-1).result.output.project_duration;
      return jsonResponse(completion({
        content: `- Answer:\n  Done: beach first, restaurant second (trimmed to 5s), hotel last — ${duration} seconds total. Background music at 20% volume with a 2-second fade-out at the end, narration starting at 12s.\n- Lesson:\n  Every mutation returns the fresh project summary, so chaining stays accurate.`,
      }));
    };

    const final = await runTurn({
      device,
      messages: [{ role: 'user', content: 'Place the beach video first, restaurant second, hotel last. Trim the restaurant video to five seconds. Add background music at 20% volume throughout. Add narration beginning at 12 seconds and fade out the music over the last two seconds.' }],
    });

    expect(final.status).toBe('final');
    expect(final.message).toContain('27 seconds');
    expect(final.project).toMatchObject({ projectId: 'project-vacation' });
    // Device state is the ground truth the summary must match.
    expect(device.videoClips.map(c => c.id)).toEqual(['clip-beach', 'clip-restaurant', 'clip-hotel']);
    expect(device.videoClips[1]).toMatchObject({ sourceStart: 0, sourceEnd: 5 });
    expect(deviceDuration(device)).toBe(27);
    const music = device.audioTracks.find(t => t.id === 'track-music');
    expect(music.clips).toHaveLength(1);
    expect(music.clips[0]).toMatchObject({ assetId: 'asset-music', timelineStart: 0, gain: 0.2, fadeOut: 2 });
    const voice = device.audioTracks.find(t => t.id === 'track-voice');
    expect(voice.clips).toHaveLength(1);
    expect(voice.clips[0]).toMatchObject({ assetId: 'asset-narration', timelineStart: 12 });
    // The model was given the timeline instructions and the project context.
    const system = xaiCalls[0].messages[0].content;
    expect(system).toContain('multi-clip PROJECT');
    expect(system).toContain('project-vacation');
    expect(system).toContain('SOURCE-media seconds');
  });

  it('§16 follow-up: moves the hotel clip first and mutes ONLY its original audio', async () => {
    const device = makeDevice();
    // Seed the post-montage state directly.
    device.videoClips[1].sourceEnd = 5;
    device.audioTracks[0].clips.push({ id: 'audio-1', assetId: 'asset-music', timelineStart: 0, sourceStart: 0, sourceDuration: 27, gain: 0.2, fadeIn: 0, fadeOut: 2 });
    device.audioTracks[1].clips.push({ id: 'audio-2', assetId: 'asset-narration', timelineStart: 12, sourceStart: 0, sourceDuration: 8, gain: 1, fadeIn: 0, fadeOut: 0 });

    let seq = 0;
    const nextId = () => `call_${(seq += 1)}`;
    xaiResponder = (body) => {
      const results = resultsByName(body);
      const names = results.map(r => r.name);
      if (!names.includes('get_timeline')) {
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'get_timeline', {})] }));
      }
      if (!names.includes('reorder_video_clips')) {
        const timeline = results.filter(r => r.name === 'get_timeline').at(-1).result.output.project;
        const ids = timeline.videoClips.map(c => c.id);
        const hotel = timeline.videoClips.find(c => c.assetId === 'asset-hotel').id;
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'reorder_video_clips', { clip_ids: [hotel, ...ids.filter(id => id !== hotel)] })] }));
      }
      if (!names.includes('mute_audio_track')) {
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'mute_audio_track', { clip_id: 'clip-hotel', muted: true })] }));
      }
      return jsonResponse(completion({ content: '- Answer:\n  Moved the hotel clip to the beginning and muted its original audio. Music and narration are unchanged.\n- Lesson:\n  Original audio belongs to its clip.' }));
    };

    const final = await runTurn({
      device,
      messages: [{ role: 'user', content: 'Move the hotel clip to the beginning and mute its original audio.' }],
    });

    expect(final.status).toBe('final');
    expect(device.videoClips.map(c => c.id)).toEqual(['clip-hotel', 'clip-beach', 'clip-restaurant']);
    expect(device.videoClips[0].originalAudioEnabled).toBe(false);
    expect(device.videoClips[1].originalAudioEnabled).toBe(true);
    expect(device.videoClips[2].originalAudioEnabled).toBe(true);
    // Music and narration preserved exactly.
    expect(device.audioTracks[0].clips[0]).toMatchObject({ gain: 0.2, fadeOut: 2 });
    expect(device.audioTracks[1].clips[0]).toMatchObject({ timelineStart: 12 });
  });

  it('recovers from a device "clip_not_found: <hint>" error by re-inspecting once and retrying', async () => {
    const device = makeDevice();
    let seq = 0;
    const nextId = () => `call_${(seq += 1)}`;
    xaiResponder = (body) => {
      const results = resultsByName(body);
      const trims = results.filter(r => r.name === 'trim_video_clip');
      const timelines = results.filter(r => r.name === 'get_timeline');
      if (trims.length === 0) {
        // First attempt uses a stale ID from an older snapshot.
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'trim_video_clip', { clip_id: 'clip-STALE', start: 0, end: 5 })] }));
      }
      const failed = trims.at(-1).result?.ok === false;
      if (failed && timelines.length === 0) {
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'get_timeline', {})] }));
      }
      if (trims.every(r => r.result?.ok !== true)) {
        const restaurant = timelines.at(-1).result.output.project.videoClips.find(c => c.assetId === 'asset-restaurant');
        return jsonResponse(completion({ content: null, tool_calls: [toolCall(nextId(), 'trim_video_clip', { clip_id: restaurant.id, start: 0, end: 5 })] }));
      }
      return jsonResponse(completion({ content: '- Answer:\n  The clip ID I had was stale, so I re-checked the timeline and then trimmed the restaurant clip to 5 seconds.\n- Lesson:\n  Device error hints tell you how to recover.' }));
    };

    const final = await runTurn({
      device,
      messages: [{ role: 'user', content: 'Trim the restaurant video to five seconds.' }],
    });

    expect(final.status).toBe('final');
    expect(final.message).toContain('re-checked');
    expect(device.videoClips[1]).toMatchObject({ sourceEnd: 5 });
  });

  it('returns malformed timeline calls with argumentsError instead of executing them', async () => {
    const device = makeDevice();
    xaiResponder = () => jsonResponse(completion({
      content: null,
      tool_calls: [toolCall('call_bad', 'trim_video_clip', { clip_id: 'clip-restaurant', start: 0 })], // end missing
    }));
    const res = await realFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'sample-access-token': token, 'user-agent': TIMELINE_UA },
      body: JSON.stringify({
        execution: 'client',
        messages: [{ role: 'user', content: 'Trim the restaurant clip.' }],
        media: { type: 'video', duration: 30 },
        project: projectSnapshot(device),
      }),
    });
    const body = await res.json();
    expect(body.status).toBe('tool_calls');
    expect(body.toolCalls[0]).toMatchObject({ name: 'trim_video_clip', arguments: {}, argumentsError: 'invalid_arguments' });
  });

  it('a pre-1.2 build gets no timeline tools and no timeline instructions, even with a project snapshot', async () => {
    const device = makeDevice();
    xaiResponder = () => jsonResponse(completion({
      content: '- Answer:\n  I can only edit the video as a whole on this build.\n- Lesson:\n  Old builds keep old tools.',
      tool_calls: [toolCall('call_x', 'trim_video_clip', { clip_id: 'clip-restaurant', start: 0, end: 5 })],
    }));
    const res = await realFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'sample-access-token': token, 'user-agent': 'FinalCap-iOS/20' },
      body: JSON.stringify({
        execution: 'client',
        messages: [{ role: 'user', content: 'Trim the restaurant clip to five seconds.' }],
        media: { type: 'video', duration: 30 },
        project: projectSnapshot(device),
      }),
    });
    const body = await res.json();
    // The timeline call was never offered, so it is filtered and the text answer stands.
    expect(body.status).toBe('final');
    const sent = xaiCalls[0];
    const offered = (sent.tools || []).map(t => t.function.name);
    expect(offered).not.toContain('trim_video_clip');
    expect(offered).not.toContain('get_timeline');
    expect(sent.messages[0].content).not.toContain('multi-clip PROJECT');
    expect(sent.messages[0].content).toContain('no timeline editing tools');
    expect(device.videoClips[1].sourceEnd).toBe(8); // untouched
  });
});
