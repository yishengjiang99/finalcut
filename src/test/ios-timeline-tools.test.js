// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  IOS_TIMELINE_TOOLS,
  IOS_TIMELINE_TOOL_NAMES,
  TIMELINE_ERROR_CODES,
  validateTimelineToolArguments,
} from '../server/iosTimelineTools.js';
import {
  TIMELINE_TOOLS_MIN_BUILD,
  isToolAllowedForIosBuild,
} from '../server/iosToolAllowlist.js';
import { buildToolsSchema, mediaTypesForTool, offeredToolsFor } from '../server/toolsSchema.js';
import { tools } from '../tools.js';

// The device executor's exact tool set (TimelineToolExecutor TimelineTools.names).
const EXPECTED_TOOLS = [
  'get_timeline', 'list_project_assets', 'get_clip_info', 'get_project_duration',
  'append_video_clips', 'reorder_video_clips', 'split_video_clip', 'trim_video_clip',
  'remove_video_clip', 'duplicate_video_clip', 'set_video_clip_speed', 'apply_clip_effect',
  'set_video_clip_transition', 'create_audio_lane', 'insert_audio_clip', 'move_audio_clip',
  'trim_audio_clip', 'remove_audio_clip', 'set_audio_clip_volume', 'set_audio_track_volume',
  'mute_audio_track', 'set_audio_fade', 'loop_audio_clip', 'set_audio_ducking',
  'set_project_canvas',
];

describe('timeline tool definitions', () => {
  it('defines exactly the device executor tool set', () => {
    expect([...IOS_TIMELINE_TOOL_NAMES].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('every tool has a valid function schema', () => {
    for (const toolDef of IOS_TIMELINE_TOOLS) {
      expect(toolDef.type).toBe('function');
      const fn = toolDef.function;
      expect(typeof fn.name).toBe('string');
      expect(fn.description.length).toBeGreaterThan(40);
      expect(fn.parameters.type).toBe('object');
      expect(fn.parameters.additionalProperties).toBe(false);
      for (const required of fn.parameters.required) {
        expect(fn.parameters.properties).toHaveProperty(required);
      }
    }
  });

  it('documents the stable error codes', () => {
    for (const code of ['invalid_arguments', 'asset_not_found', 'clip_not_found',
      'unsupported_on_device', 'resource_limit_exceeded', 'cancelled', 'no_media']) {
      expect(TIMELINE_ERROR_CODES).toContain(code);
    }
  });

  it('timeline tools are video-only and never leak into the web tool list', () => {
    const webNames = tools.map(t => t.function.name);
    for (const name of IOS_TIMELINE_TOOL_NAMES) {
      expect(webNames).not.toContain(name);
      expect(mediaTypesForTool(name)).toEqual(['video']);
    }
    const webSchema = buildToolsSchema();
    expect(webSchema.tools.map(t => t.function.name)).toEqual(webNames);
  });
});

describe('build gating (app version 1.2)', () => {
  it('the gate is the first build of app version 1.2 (ios-testflight run_number 21)', () => {
    expect(TIMELINE_TOOLS_MIN_BUILD).toBe(21);
  });

  it('no pre-1.2 build receives timeline tools', () => {
    for (const build of [10, 13, 14, 20]) {
      const offered = offeredToolsFor({ userAgent: `FinalCap-iOS/${build}`, mediaType: 'video' }).map(t => t.function.name);
      for (const name of IOS_TIMELINE_TOOL_NAMES) expect(offered).not.toContain(name);
      expect(isToolAllowedForIosBuild('trim_video_clip', build)).toBe(false);
    }
  });

  it('build 21 (version 1.2) receives the full timeline set (and only for video)', () => {
    const ua = 'FinalCap-iOS/21';
    const offered = offeredToolsFor({ userAgent: ua, mediaType: 'video' }).map(t => t.function.name);
    for (const name of IOS_TIMELINE_TOOL_NAMES) expect(offered).toContain(name);
    const photoOffered = offeredToolsFor({ userAgent: ua, mediaType: 'image' }).map(t => t.function.name);
    for (const name of IOS_TIMELINE_TOOL_NAMES) expect(photoOffered).not.toContain(name);
    const schema = buildToolsSchema({ userAgent: ua });
    for (const name of IOS_TIMELINE_TOOL_NAMES) expect(schema.mediaTypes[name]).toEqual(['video']);
  });

  it('non-iOS user agents never receive timeline tools', () => {
    const offered = offeredToolsFor({ userAgent: 'Mozilla/5.0', mediaType: 'video' }).map(t => t.function.name);
    for (const name of IOS_TIMELINE_TOOL_NAMES) expect(offered).not.toContain(name);
  });
});

describe('validateTimelineToolArguments', () => {
  it('accepts well-formed calls in the device argument shapes', () => {
    expect(validateTimelineToolArguments('trim_video_clip', { clip_id: 'clip-2', start: 2, end: 7 })).toBeNull();
    expect(validateTimelineToolArguments('set_audio_track_volume', { track_id: 'track-music', volume: 0.2 })).toBeNull();
    expect(validateTimelineToolArguments('get_timeline', {})).toBeNull();
    expect(validateTimelineToolArguments('reorder_video_clips', { clip_ids: ['a', 'b'] })).toBeNull();
    expect(validateTimelineToolArguments('insert_audio_clip', { track_id: 't', asset_id: 'a', timeline_start: 12, volume: 0.2 })).toBeNull();
    expect(validateTimelineToolArguments('mute_audio_track', { clip_id: 'clip-3' })).toBeNull();
    expect(validateTimelineToolArguments('apply_clip_effect', { kind: 'color_filter', filter: 'warm', intensity: 0.8 })).toBeNull();
  });

  it('rejects missing required args, wrong types, out-of-range values, and unknown keys', () => {
    expect(validateTimelineToolArguments('trim_video_clip', { clip_id: 'clip-2', start: 2 })).toMatch(/end is required/);
    expect(validateTimelineToolArguments('set_video_clip_speed', { clip_id: 'c', speed: 99 })).toMatch(/<= 16/);
    expect(validateTimelineToolArguments('set_audio_track_volume', { track_id: 't', volume: 'loud' })).toMatch(/finite number/);
    expect(validateTimelineToolArguments('get_clip_info', { clip_id: 'c', path: '/etc/passwd' })).toMatch(/not a supported argument/);
    expect(validateTimelineToolArguments('set_video_clip_transition', { clip_id: 'c', type: 'wipe' })).toMatch(/must be one of/);
    expect(validateTimelineToolArguments('append_video_clips', { asset_ids: [] })).toMatch(/at least 1/);
    expect(validateTimelineToolArguments('nope_tool', {})).toMatch(/unknown timeline tool/);
    expect(validateTimelineToolArguments('trim_video_clip', { clip_id: 'c', start: Number.NaN, end: 3 })).toMatch(/finite number/);
  });
});
