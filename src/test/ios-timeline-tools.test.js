// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  IOS_TIMELINE_TOOLS,
  IOS_TIMELINE_TOOL_NAMES,
  TIMELINE_ERROR_CODES,
  TIMELINE_MUTATION_TOOL_NAMES,
  validateBatchOperations,
  validateTimelineToolArguments,
} from '../server/iosTimelineTools.js';
import {
  TIMELINE_TOOLS_MIN_BUILD,
  isToolAllowedForIosBuild,
} from '../server/iosToolAllowlist.js';
import { buildToolsSchema, mediaTypesForTool, offeredToolsFor } from '../server/toolsSchema.js';
import { tools } from '../tools.js';

const EXPECTED_TOOLS = [
  'get_project_timeline', 'list_project_assets', 'get_clip_details', 'get_audio_track_details',
  'get_project_info', 'get_project_duration',
  'append_video_clips', 'insert_video_clip', 'reorder_video_clips', 'split_video_clip',
  'trim_video_clip', 'remove_video_clip', 'duplicate_video_clip', 'set_clip_speed',
  'set_clip_effect', 'set_clip_original_audio', 'set_clip_transition',
  'create_audio_track', 'add_audio_clip', 'move_audio_clip', 'trim_audio_clip',
  'remove_audio_clip', 'set_audio_clip_volume', 'set_audio_track_volume', 'mute_audio_track',
  'set_audio_clip_fade', 'loop_audio_clip', 'apply_audio_ducking', 'set_project_canvas',
  'batch_timeline_edits',
];

describe('timeline tool definitions', () => {
  it('defines exactly the specified tool set', () => {
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
      // Mutation tools carry the revision + idempotency contract.
      if (TIMELINE_MUTATION_TOOL_NAMES.includes(fn.name) || fn.name === 'batch_timeline_edits') {
        expect(fn.parameters.properties).toHaveProperty('expectedRevision');
        expect(fn.parameters.properties).toHaveProperty('idempotencyKey');
      }
    }
  });

  it('documents the stable error codes', () => {
    for (const code of ['invalid_arguments', 'asset_not_found', 'clip_not_found', 'audio_track_not_found',
      'invalid_source_range', 'invalid_timeline_position', 'project_revision_conflict',
      'unsupported_on_device', 'resource_limit_exceeded', 'cancelled']) {
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

describe('build gating', () => {
  it('no real installed build receives timeline tools yet (placeholder min build)', () => {
    expect(TIMELINE_TOOLS_MIN_BUILD).toBe(2_000_000_000);
    for (const build of [10, 13, 14, 84, 999]) {
      const offered = offeredToolsFor({ userAgent: `FinalCap-iOS/${build}`, mediaType: 'video' }).map(t => t.function.name);
      for (const name of IOS_TIMELINE_TOOL_NAMES) expect(offered).not.toContain(name);
      expect(isToolAllowedForIosBuild('trim_video_clip', build)).toBe(false);
    }
  });

  it('a build at the min build receives the full timeline set (and only for video)', () => {
    const ua = `FinalCap-iOS/${TIMELINE_TOOLS_MIN_BUILD}`;
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
  it('accepts well-formed calls', () => {
    expect(validateTimelineToolArguments('trim_video_clip', { clipId: 'clip-2', sourceStart: 2, sourceEnd: 7, expectedRevision: 18 })).toBeNull();
    expect(validateTimelineToolArguments('set_audio_track_volume', { trackId: 'track-music', volume: 0.2 })).toBeNull();
    expect(validateTimelineToolArguments('get_project_timeline', {})).toBeNull();
    expect(validateTimelineToolArguments('reorder_video_clips', { orderedClipIds: ['a', 'b'] })).toBeNull();
  });

  it('rejects missing required args, wrong types, out-of-range values, and unknown keys', () => {
    expect(validateTimelineToolArguments('trim_video_clip', { clipId: 'clip-2', sourceStart: 2 })).toMatch(/sourceEnd is required/);
    expect(validateTimelineToolArguments('set_clip_speed', { clipId: 'c', speed: 99 })).toMatch(/<= 16/);
    expect(validateTimelineToolArguments('set_audio_track_volume', { trackId: 't', volume: 'loud' })).toMatch(/finite number/);
    expect(validateTimelineToolArguments('get_clip_details', { clipId: 'c', path: '/etc/passwd' })).toMatch(/not a supported argument/);
    expect(validateTimelineToolArguments('set_clip_transition', { clipId: 'c', kind: 'wipe' })).toMatch(/must be one of/);
    expect(validateTimelineToolArguments('nope_tool', {})).toMatch(/unknown timeline tool/);
    expect(validateTimelineToolArguments('trim_video_clip', { clipId: 'c', sourceStart: Number.NaN, sourceEnd: 3 })).toMatch(/finite number/);
  });

  it('validates batch operations against each operation tool schema', () => {
    expect(validateBatchOperations({
      expectedRevision: 18,
      operations: [
        { type: 'reorder_video_clips', arguments: { orderedClipIds: ['clip-3', 'clip-1', 'clip-2'] } },
        { type: 'set_audio_track_volume', arguments: { trackId: 'track-music', volume: 0.25 } },
      ],
    })).toBeNull();
    // Inspection tools and nested batches are not batchable.
    expect(validateBatchOperations({ operations: [{ type: 'get_project_timeline', arguments: {} }] })).toMatch(/not a batchable/);
    expect(validateBatchOperations({ operations: [{ type: 'batch_timeline_edits', arguments: { operations: [] } }] })).toMatch(/not a batchable/);
    // An invalid inner call names the failing operation.
    expect(validateBatchOperations({ operations: [{ type: 'trim_video_clip', arguments: { clipId: 'c' } }] })).toMatch(/operations\[0\] \(trim_video_clip\)/);
    // Batch size is bounded.
    expect(validateBatchOperations({
      operations: Array.from({ length: 21 }, () => ({ type: 'mute_audio_track', arguments: { trackId: 't', muted: true } })),
    })).toMatch(/at most 20/);
  });
});
