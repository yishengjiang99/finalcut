// iOS-only timeline tools for multi-clip projects and multi-track audio,
// executed by the FinalCap iOS on-device timeline executor (ProjectCommand).
//
// These definitions are NOT in src/tools.js: the web tool list and
// docs/api/tools-schema.v1.json never contain them, and the server has no
// implementation — calls are returned to the device through the existing
// client-execution protocol and the device validates them against the real
// project. They are offered only to FinalCap-iOS builds allowed by
// TIMELINE_TOOLS_MIN_BUILD in iosToolAllowlist.js.
//
// Time conventions (stated in every relevant description):
// - All times are SECONDS (numbers).
// - sourceStart / sourceEnd / sourceDuration are in SOURCE-media time.
// - timelineStart / atProjectTime / fade positions are in PROJECT-timeline time.
// - Gains/volumes are linear multipliers: 1 = unchanged, 0.2 = 20%.
//
// Mutation contract: every mutation accepts optional `expectedRevision`
// (the project revision the plan was based on; the device rejects a stale
// plan with error "project_revision_conflict" and its current revision) and
// optional `idempotencyKey` (the device deduplicates a retried call carrying
// the same key within a turn, so a continuation retry never applies an edit
// twice). Successful mutation results report
// output: { projectRevision, affectedClipIds?, duration?, videoClipCount?, audioTrackCount? }.

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Stable tool-result error codes for timeline tools (device → model). */
export const TIMELINE_ERROR_CODES = deepFreeze([
  'invalid_arguments',
  'asset_not_found',
  'clip_not_found',
  'audio_track_not_found',
  'audio_clip_not_found',
  'invalid_source_range',
  'invalid_timeline_position',
  'project_revision_conflict',
  'unsupported_on_device',
  'resource_limit_exceeded',
  'cancelled',
]);

const id = (description) => ({ type: 'string', minLength: 1, maxLength: 128, description });
const seconds = (description, extra = {}) => ({ type: 'number', minimum: 0, description, ...extra });
const gain = (description) => ({ type: 'number', minimum: 0, maximum: 4, description });
const expectedRevision = {
  type: 'integer', minimum: 0,
  description: 'Optional. The project revision this edit was planned against (from the project snapshot or the last tool result). If the project has changed since, the device rejects the call with "project_revision_conflict" and reports the current revision — then inspect the timeline and replan. Never invent a revision number.',
};
const idempotencyKey = {
  type: 'string', minLength: 1, maxLength: 64,
  description: 'Optional. A stable key for this exact edit within this turn; if a continuation is retried, the device applies a given key only once.',
};
const mutationProps = { expectedRevision, idempotencyKey };

function tool(name, description, properties, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}

const CLIP_ID = id('Stable ID of a video clip on the project timeline (from the project context or get_project_timeline). Never invent an ID.');
const AUDIO_CLIP_ID = id('Stable ID of an audio clip (from the project context or get_audio_track_details). Never invent an ID.');
const TRACK_ID = id('Stable ID of a logical audio track (from the project context or get_project_timeline). Never invent an ID.');
const ASSET_ID = id('Stable ID of an imported source asset (from list_project_assets or the project context). Never invent an ID.');

/** Tool definitions (same shape as src/tools.js). */
export const IOS_TIMELINE_TOOLS = deepFreeze([
  // ── Inspection (read live device state; never rely on memory of it) ──────
  tool('get_project_timeline',
    'Read the CURRENT project timeline from the device: video clip order with stable IDs, source ranges (source-media seconds), project start times (project-timeline seconds), and the audio track overview. Use it before planning edits whenever the snapshot may be stale, truncated, or after a project_revision_conflict. Optional bounds page through large projects.',
    {
      startIndex: { type: 'integer', minimum: 0, description: 'Optional. Index of the first video clip to return (default 0).' },
      maxClips: { type: 'integer', minimum: 1, maximum: 100, description: 'Optional. Max video clips to return (default 40). The result reports totalVideoClips and truncated when more remain.' },
      includeAudioClips: { type: 'boolean', description: 'Optional. Also list audio clips per track (default true).' },
    }),
  tool('list_project_assets',
    'List the imported source media on the device: stable asset IDs, type (video/audio/image), display label, duration in seconds, and whether a video has audio. Assets are sources; clips on the timeline reference them. Use this to resolve names like "the beach video" or "the music file" to asset IDs.',
    {
      type: { type: 'string', enum: ['video', 'audio', 'image'], description: 'Optional. Only list assets of this type.' },
    }),
  tool('get_clip_details',
    'Read full details of ONE video clip from the device: its asset, source range (source-media seconds), project range (project-timeline seconds), speed, original-audio state and gain, effects, and transition out.',
    { clipId: CLIP_ID }, ['clipId']),
  tool('get_audio_track_details',
    'Read full details of ONE logical audio track from the device: kind (music/voiceover/effects/other), track volume (linear gain), mute state, and every audio clip on it with placement (project-timeline seconds), source range, gain, fades, and looping.',
    { trackId: TRACK_ID }, ['trackId']),
  tool('get_project_info',
    'Read project-level info from the device: project ID, current revision, canvas size, duration (project-timeline seconds), clip/track counts, and the selected clip.',
    {}),
  tool('get_project_duration',
    'Read the current total project duration in project-timeline seconds from the device.',
    {}),

  // ── Video timeline mutations ──────────────────────────────────────────────
  tool('append_video_clips',
    'Append one or more imported video assets to the END of the video timeline, in the given order. Each item may trim the source with sourceStart/sourceEnd (source-media seconds; omit for the whole asset). Does not move or change existing clips.',
    {
      clips: {
        type: 'array', minItems: 1, maxItems: 20,
        description: 'Clips to append, in order.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            assetId: ASSET_ID,
            sourceStart: seconds('Optional start in source-media seconds (default 0).'),
            sourceEnd: seconds('Optional end in source-media seconds (default the asset end).'),
          },
          required: ['assetId'],
        },
      },
      ...mutationProps,
    }, ['clips']),
  tool('insert_video_clip',
    'Insert one imported video asset into the video timeline at a position: atIndex is the 0-based timeline position (0 = first; equal to the clip count = append). Later clips shift later. Optionally trim the source with sourceStart/sourceEnd (source-media seconds).',
    {
      assetId: ASSET_ID,
      atIndex: { type: 'integer', minimum: 0, description: '0-based position in the CURRENT timeline order where the new clip goes.' },
      sourceStart: seconds('Optional start in source-media seconds (default 0).'),
      sourceEnd: seconds('Optional end in source-media seconds (default the asset end).'),
      ...mutationProps,
    }, ['assetId', 'atIndex']),
  tool('reorder_video_clips',
    'Reorder the video timeline. orderedClipIds must list EVERY current video clip ID exactly once, in the new order ("the second clip" means the current timeline order, not import order). Original audio moves with its clip. Audio tracks are not affected.',
    {
      orderedClipIds: {
        type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', minLength: 1, maxLength: 128 },
        description: 'Every current video clip ID, in the desired new timeline order.',
      },
      ...mutationProps,
    }, ['orderedClipIds']),
  tool('split_video_clip',
    'Split one video clip into two at a project-timeline position. atProjectTime is in PROJECT-timeline seconds and must fall inside the clip. Both halves keep the clip\'s effects and original-audio settings.',
    {
      clipId: CLIP_ID,
      atProjectTime: seconds('Split point in PROJECT-timeline seconds (not source time).'),
      ...mutationProps,
    }, ['clipId', 'atProjectTime']),
  tool('trim_video_clip',
    'Trim ONE video clip by setting its source range: sourceStart/sourceEnd are in SOURCE-media seconds (the media inside the asset), not project time. Other clips shift on the timeline when this clip\'s length changes; independently placed audio clips do NOT move.',
    {
      clipId: CLIP_ID,
      sourceStart: seconds('New start in source-media seconds.'),
      sourceEnd: seconds('New end in source-media seconds (must be greater than sourceStart).'),
      ...mutationProps,
    }, ['clipId', 'sourceStart', 'sourceEnd']),
  tool('remove_video_clip',
    'Remove ONE video clip (and its original audio) from the timeline. Later clips shift earlier. Audio tracks are not affected. The source asset stays imported.',
    { clipId: CLIP_ID, ...mutationProps }, ['clipId']),
  tool('duplicate_video_clip',
    'Duplicate ONE video clip immediately after itself, with the same source range, speed, effects, and original-audio settings.',
    { clipId: CLIP_ID, ...mutationProps }, ['clipId']),
  tool('set_clip_speed',
    'Set the playback speed of ONE video clip (1 = normal, 0.5 = half speed, 2 = double). Changing speed changes the clip\'s project duration; later clips shift, independently placed audio does not.',
    {
      clipId: CLIP_ID,
      speed: { type: 'number', minimum: 0.05, maximum: 16, description: 'Playback speed multiplier.' },
      ...mutationProps,
    }, ['clipId', 'speed']),
  tool('set_clip_effect',
    'Apply or clear a frame effect on ONE video clip, or on every clip when clipId is omitted. Use "clear" to remove effects of the given kind. This is per-clip: it does not touch other clips unless clipId is omitted.',
    {
      clipId: { ...CLIP_ID, description: 'Optional. Stable ID of the video clip; omit to apply to every video clip.' },
      effect: {
        type: 'object', additionalProperties: false,
        description: 'The effect to set.',
        properties: {
          kind: { type: 'string', enum: ['color_controls', 'hue', 'color_filter', 'crop', 'rotate', 'flip_horizontal', 'flip_vertical', 'clear'], description: 'Effect kind.' },
          brightness: { type: 'number', minimum: -1, maximum: 1, description: 'For color_controls: -1..1.' },
          contrast: { type: 'number', minimum: 0, maximum: 2, description: 'For color_controls: 0..2.' },
          saturation: { type: 'number', minimum: 0, maximum: 2, description: 'For color_controls: 0..2.' },
          degrees: { type: 'number', description: 'For hue (color shift) or rotate.' },
          filter: { type: 'string', maxLength: 64, description: 'For color_filter: a filter/look name the device supports.' },
          intensity: { type: 'number', minimum: 0, maximum: 1, description: 'For color_filter: 0..1.' },
        },
        required: ['kind'],
      },
      ...mutationProps,
    }, ['effect']),
  tool('set_clip_original_audio',
    'Control the ORIGINAL camera audio of ONE video clip: enabled=false mutes only that clip\'s own audio (music, narration and other clips are untouched); gain optionally sets its linear volume (1 = unchanged, 0 = silent).',
    {
      clipId: CLIP_ID,
      enabled: { type: 'boolean', description: 'Optional. false mutes this clip\'s original audio; true unmutes it.' },
      gain: gain('Optional linear gain for this clip\'s original audio.'),
      ...mutationProps,
    }, ['clipId']),
  tool('set_clip_transition',
    'Set the transition OUT of one video clip into the next: "cut" (default), "cross_dissolve", or "fade_through_black", with a duration in seconds. A non-cut transition overlaps the two clips, so the total project duration shrinks by the overlap.',
    {
      clipId: CLIP_ID,
      kind: { type: 'string', enum: ['cut', 'cross_dissolve', 'fade_through_black'], description: 'Transition kind.' },
      duration: seconds('Transition duration in seconds (0 for a cut).', { maximum: 10 }),
      ...mutationProps,
    }, ['clipId', 'kind']),

  // ── Audio timeline mutations ─────────────────────────────────────────────
  tool('create_audio_track',
    'Create a new empty logical audio track (kind: music, voiceover, effects, or other) and return its stable track ID. Adding a track never removes or replaces existing tracks or soundtracks.',
    {
      label: { type: 'string', maxLength: 200, description: 'Optional display label, e.g. "Background Music".' },
      kind: { type: 'string', enum: ['music', 'voiceover', 'effects', 'other'], description: 'Optional track kind (default "other"; use "music" for background music, "voiceover" for narration).' },
      ...mutationProps,
    }),
  tool('add_audio_clip',
    'Place an imported audio asset on a logical audio track at a project-timeline position. Audio clips may overlap freely. If trackId is omitted, the device uses (or creates) a track matching the asset\'s obvious role — prefer passing an explicit trackId from get_project_timeline. This ADDS a clip; it never deletes an existing soundtrack. Set gain for its starting volume (0.2 = 20%).',
    {
      trackId: { ...TRACK_ID, description: 'Optional. Target track; omit only when there is an obvious single track for this audio.' },
      assetId: ASSET_ID,
      timelineStart: seconds('Start position in PROJECT-timeline seconds.'),
      sourceStart: seconds('Optional start in source-media seconds (default 0).'),
      sourceDuration: seconds('Optional length of source audio to use, in source-media seconds (default: to the asset end).'),
      gain: gain('Optional linear gain for the new clip (default 1).'),
      loop: { type: 'boolean', description: 'Optional. Repeat the source range until repeatUntil or the project end.' },
      repeatUntil: seconds('Optional project-timeline second at which looping stops.'),
      ...mutationProps,
    }, ['assetId', 'timelineStart']),
  tool('move_audio_clip',
    'Move ONE audio clip to a new project-timeline start, optionally onto a different track. Its source range and gain are unchanged.',
    {
      clipId: AUDIO_CLIP_ID,
      timelineStart: seconds('New start in PROJECT-timeline seconds.'),
      toTrackId: { ...TRACK_ID, description: 'Optional. Move the clip onto this track.' },
      ...mutationProps,
    }, ['clipId', 'timelineStart']),
  tool('trim_audio_clip',
    'Trim ONE audio clip\'s source range: sourceStart and sourceDuration are in SOURCE-media seconds. Its project-timeline start does not change.',
    {
      clipId: AUDIO_CLIP_ID,
      sourceStart: seconds('New start in source-media seconds.'),
      sourceDuration: seconds('New length of source audio used, in seconds (must be > 0).', { exclusiveMinimum: 0 }),
      ...mutationProps,
    }, ['clipId', 'sourceStart', 'sourceDuration']),
  tool('remove_audio_clip',
    'Remove ONE audio clip from its track. The track and its other clips remain.',
    { clipId: AUDIO_CLIP_ID, ...mutationProps }, ['clipId']),
  tool('set_audio_clip_volume',
    'Set the linear gain of ONE audio clip (1 = unchanged, 0.2 = 20%, 0 = silent). Only that clip changes — not its whole track and not the project.',
    { clipId: AUDIO_CLIP_ID, volume: gain('Linear gain for this audio clip.'), ...mutationProps }, ['clipId', 'volume']),
  tool('set_audio_track_volume',
    'Set the linear gain of ONE whole logical audio track (1 = unchanged, 0.2 = 20%). This multiplies every clip on that track and nothing else — use it for "lower the music to 20%" when the music is a track.',
    { trackId: TRACK_ID, volume: gain('Linear gain for the whole track.'), ...mutationProps }, ['trackId', 'volume']),
  tool('mute_audio_track',
    'Mute or unmute ONE whole logical audio track. Other tracks and video-clip audio are untouched.',
    {
      trackId: TRACK_ID,
      muted: { type: 'boolean', description: 'true mutes the track, false unmutes it.' },
      ...mutationProps,
    }, ['trackId', 'muted']),
  tool('set_audio_clip_fade',
    'Set fade-in and/or fade-out durations (seconds) on ONE audio clip. A fade-out ends at the clip\'s end on the project timeline — e.g. "fade the music out over the last two seconds" is fadeOut=2 on the music clip that ends with the project.',
    {
      clipId: AUDIO_CLIP_ID,
      fadeIn: seconds('Optional fade-in duration in seconds.', { maximum: 3600 }),
      fadeOut: seconds('Optional fade-out duration in seconds.', { maximum: 3600 }),
      ...mutationProps,
    }, ['clipId']),
  tool('loop_audio_clip',
    'Make ONE audio clip repeat its source range until repeatUntil (project-timeline seconds) or, when omitted, the project end. Use for short music beds under a longer video.',
    {
      clipId: AUDIO_CLIP_ID,
      repeatUntil: seconds('Optional project-timeline second at which looping stops.'),
      ...mutationProps,
    }, ['clipId']),
  tool('apply_audio_ducking',
    'Automatically lower ONE target track (usually background music) while dialogue is present, restoring it afterwards. Detection runs on-device from the dialogue sources — never invent speech timestamps. againstTrackIds lists the tracks treated as dialogue; omit it to use the video clips\' original audio plus voiceover tracks. Voiceover/dialogue tracks themselves are never lowered by this call.',
    {
      trackId: { ...TRACK_ID, description: 'The track to lower (usually the music track).' },
      againstTrackIds: {
        type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 128 },
        description: 'Optional. Tracks whose speech triggers the ducking; omit for original clip audio + voiceover tracks.',
      },
      amount: { type: 'number', minimum: 0, maximum: 1, description: 'Optional. How far to lower the target while speech is present, as a fraction (0.7 lowers it to 30% of its gain). Default device setting when omitted.' },
      ...mutationProps,
    }, ['trackId']),

  // ── Project-level ─────────────────────────────────────────────────────────
  tool('set_project_canvas',
    'Set the project canvas (output frame size) in pixels. Clips are fitted without distortion (letter/pillar-box) unless the project is set to fill. This changes the output size, not any clip\'s content.',
    {
      width: { type: 'integer', minimum: 2, maximum: 16384, description: 'Canvas width in pixels.' },
      height: { type: 'integer', minimum: 2, maximum: 16384, description: 'Canvas height in pixels.' },
      ...mutationProps,
    }, ['width', 'height']),

  // ── Timeline view (what the user sees: selection + playhead) ──────────────
  tool('select_timeline_clip',
    'Select ONE clip on the timeline, exactly as if the user tapped it: a video clip ID sets the selected video clip, an audio clip ID sets the selected audio clip (each has its own selection). Omit clipId to clear both selections. Use it to show the user which clip you mean or are about to edit; it changes nothing about the media itself.',
    {
      clipId: id('Optional. Stable ID of a video clip or an audio clip (from the project context or get_project_timeline). Omit to clear the selection. Never invent an ID.'),
      ...mutationProps,
    }),
  tool('seek_playhead',
    'Move the playhead (and the preview) to a PROJECT-timeline position in seconds, as if the user dragged the ruler. Values past the end clamp to the project duration. This is view state only: it does not edit the project or change its revision. The result reports the actual playheadSeconds.',
    {
      seconds: seconds('Target position in PROJECT-timeline seconds.'),
    }, ['seconds']),

  // ── Batch ─────────────────────────────────────────────────────────────────
  tool('batch_timeline_edits',
    'Apply several INDEPENDENT timeline edits as ONE device transaction: the device validates the whole batch first and applies all-or-nothing — if any operation is invalid, none are applied and the result names the failing operation index. Prefer this over many sequential calls when the edits do not depend on each other\'s results (it saves tool rounds). Do NOT batch when a later edit needs an ID created by an earlier one (e.g. adding a clip to a track you are also creating) — do those sequentially. Max 20 operations.',
    {
      operations: {
        type: 'array', minItems: 1, maxItems: 20,
        description: 'Edits to apply atomically, in order.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            type: {
              type: 'string',
              description: 'The mutation tool name to run (video/audio/project mutations only — no inspection tools, no nested batch).',
              enum: [
                'append_video_clips', 'insert_video_clip', 'reorder_video_clips', 'split_video_clip',
                'trim_video_clip', 'remove_video_clip', 'duplicate_video_clip', 'set_clip_speed',
                'set_clip_effect', 'set_clip_original_audio', 'set_clip_transition',
                'create_audio_track', 'add_audio_clip', 'move_audio_clip', 'trim_audio_clip',
                'remove_audio_clip', 'set_audio_clip_volume', 'set_audio_track_volume',
                'mute_audio_track', 'set_audio_clip_fade', 'loop_audio_clip', 'apply_audio_ducking',
                'set_project_canvas',
              ],
            },
            arguments: {
              type: 'object',
              description: 'Arguments for that tool, exactly as its own schema defines (without expectedRevision/idempotencyKey — the batch carries those).',
            },
          },
          required: ['type', 'arguments'],
        },
      },
      ...mutationProps,
    }, ['operations']),
]);

export const IOS_TIMELINE_TOOL_NAMES = deepFreeze(IOS_TIMELINE_TOOLS.map(t => t.function.name));

const TOOL_BY_NAME = new Map(IOS_TIMELINE_TOOLS.map(t => [t.function.name, t]));

/**
 * Lightweight server-side argument validation for timeline tool calls, against
 * the declared JSON schemas (types, required, enums, numeric/string/array
 * bounds, additionalProperties). The device re-validates against the real
 * project; this layer only rejects calls that cannot possibly be legal, so a
 * malformed model call becomes a clean "invalid_arguments" result instead of
 * a device-side exception. Returns an error string, or null when valid.
 */
export function validateTimelineToolArguments(name, args, depth = 0) {
  const toolDef = TOOL_BY_NAME.get(name);
  if (!toolDef) return `unknown timeline tool "${name}"`;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  return validateAgainstSchema(args, toolDef.function.parameters, name, depth);
}

function validateAgainstSchema(value, schema, where, depth) {
  if (depth > 6 || !schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(value) ? null : `${where} must be one of ${schema.enum.join(', ')}`;
  }
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${where} must be an object`;
      const props = schema.properties || {};
      for (const required of schema.required || []) {
        if (!(required in value) || value[required] === undefined) return `${where}.${required} is required`;
      }
      for (const [key, child] of Object.entries(value)) {
        if (!(key in props)) {
          if (schema.additionalProperties === false) return `${where}.${key} is not a supported argument`;
          continue;
        }
        const error = validateAgainstSchema(child, props[key], `${where}.${key}`, depth + 1);
        if (error) return error;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${where} must be an array`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${where} needs at least ${schema.minItems} item(s)`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${where} allows at most ${schema.maxItems} item(s)`;
      if (schema.items) {
        for (let i = 0; i < value.length; i += 1) {
          const error = validateAgainstSchema(value[i], schema.items, `${where}[${i}]`, depth + 1);
          if (error) return error;
        }
      }
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return `${where} must be a string`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${where} is too short`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${where} exceeds ${schema.maxLength} characters`;
      return null;
    }
    case 'integer': {
      if (!Number.isSafeInteger(value)) return `${where} must be an integer`;
      return validateNumberBounds(value, schema, where);
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${where} must be a finite number`;
      return validateNumberBounds(value, schema, where);
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${where} must be a boolean`;
    default:
      return null;
  }
}

function validateNumberBounds(value, schema, where) {
  if (schema.minimum !== undefined && value < schema.minimum) return `${where} must be >= ${schema.minimum}`;
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return `${where} must be > ${schema.exclusiveMinimum}`;
  if (schema.maximum !== undefined && value > schema.maximum) return `${where} must be <= ${schema.maximum}`;
  return null;
}

/**
 * Validate the operations inside a batch_timeline_edits call: every operation
 * type must be a batchable mutation, and its arguments must satisfy that
 * tool's own schema (ignoring the batch-level expectedRevision/idempotencyKey).
 * Returns an error string, or null when valid.
 */
export function validateBatchOperations(args) {
  // Batchable-type check first: it produces the clearer error for inspection
  // tools / nested batches (the schema enum check would also reject them).
  if (args && Array.isArray(args.operations)) {
    for (let i = 0; i < args.operations.length; i += 1) {
      const type = args.operations[i]?.type;
      if (typeof type === 'string' && TOOL_BY_NAME.has(type) && !TIMELINE_MUTATION_TOOL_NAMES.includes(type)) {
        return `operations[${i}].type "${type}" is not a batchable timeline mutation`;
      }
    }
  }
  const basic = validateTimelineToolArguments('batch_timeline_edits', args);
  if (basic) return basic;
  for (let i = 0; i < args.operations.length; i += 1) {
    const op = args.operations[i];
    if (!TIMELINE_MUTATION_TOOL_NAMES.includes(op.type)) {
      return `operations[${i}].type "${op.type}" is not a batchable timeline mutation`;
    }
    const opArgs = { ...(op.arguments || {}) };
    delete opArgs.expectedRevision;
    delete opArgs.idempotencyKey;
    const error = validateTimelineToolArguments(op.type, opArgs);
    if (error) return `operations[${i}] (${op.type}): ${error}`;
  }
  return null;
}

/** Timeline tools that change the project (batchable; inspection and view-only tools are not). */
export const TIMELINE_MUTATION_TOOL_NAMES = deepFreeze(
  IOS_TIMELINE_TOOL_NAMES.filter(n => ![
    'get_project_timeline', 'list_project_assets', 'get_clip_details',
    'get_audio_track_details', 'get_project_info', 'get_project_duration',
    'seek_playhead', 'batch_timeline_edits',
  ].includes(n)),
);

/** Every timeline tool is video-project only (never offered for photo editing or the web editor). */
export const IOS_TIMELINE_TOOL_MEDIA_TYPES = deepFreeze(
  Object.fromEntries(IOS_TIMELINE_TOOL_NAMES.map(n => [n, ['video']])),
);

/**
 * Server-owned agent instructions for timeline projects, appended to the
 * client-execution system prompt whenever a project snapshot is present.
 * (Rules 1–8 from the agentic-orchestration spec, plus audio-track scoping,
 * legacy-tool scoping, ducking honesty, and montage honesty.)
 */
export const TIMELINE_AGENT_INSTRUCTIONS = [
  'The media being edited is a multi-clip PROJECT on the device, not a single file. The device is the source of truth: the project context is a snapshot, and inspection tools (get_project_timeline, list_project_assets, get_clip_details, get_audio_track_details) read live device state.',
  'INSPECT BEFORE UNCERTAIN CHANGES: when the user refers to a clip by subject, label, or order ("the beach clip", "the second clip"), resolve it from the project context or an inspection tool. Never invent an asset, clip, or track ID. "The second clip" means the current TIMELINE order, not the import order; after reordering, use the updated arrangement.',
  'WHAT THE USER IS LOOKING AT: "this clip" / "the selected clip" is selectedClipId; "this audio" / "the selected music clip" is selectedAudioClipId; "here" / "at the playhead" / "now" is playheadSeconds (PROJECT-timeline seconds). When the one a request needs is null, ask or inspect — never guess. select_timeline_clip and seek_playhead change what the user sees; use them when the user asks to select, show, or jump to something.',
  'RESPECT EDITING SCOPE: distinguish a source asset, one video clip, the selected clip, one audio clip, a whole logical audio track, and the entire project. A clip-specific request must affect only that clip. "Mute the audio in clip three" targets that clip\'s ORIGINAL audio (set_clip_original_audio), never the music or narration tracks.',
  'PRESERVE UNSPECIFIED PROPERTIES: apply minimal, targeted mutations. "Lower the music to 20%" changes only the music track/clip gain — do not mute dialogue, reorder clips, or remove other tracks. "Add another soundtrack" ADDS a track/clip; never delete or replace an existing soundtrack unless asked.',
  'TIMING: sourceStart/sourceEnd/sourceDuration are SOURCE-media seconds; timelineStart/atProjectTime are PROJECT-timeline seconds. Trimming or speeding a video clip shifts later video clips, but independently placed audio clips do not move — re-check audio placement after changing video lengths when sync matters. Do not place an audio clip beyond the project duration unless the user asked for that.',
  'AUDIO SCOPES: original camera audio belongs to its video clip; background music, narration/voiceover, and effects live on separate logical tracks and can overlap. For "lower the music when someone speaks", use apply_audio_ducking on the music track if available — do not lower the whole project, and never fabricate speech timestamps.',
  'VERIFY EXECUTION: a tool call is a proposal, not a result. Wait for the device result; use its projectRevision, affected IDs, and error codes to decide the next step. In the final answer report ONLY edits the device confirmed (ok:true). If a requested feature (a transition style, ducking, an effect) is unavailable, say so plainly — never claim an export happened unless an export tool actually ran.',
  'RECOVER WITHOUT LOOPS: on "project_revision_conflict", the project changed under your plan — call get_project_timeline ONCE, replan against the fresh state, and continue; never repeat the identical failing call. On clip_not_found/asset_not_found/audio_track_not_found, refresh state once before retrying with a corrected ID. Respect skipped_by_user and unsupported_on_device as final for that tool this turn.',
  'BATCHING: when several edits are independent and all IDs are already known, prefer ONE batch_timeline_edits call (all-or-nothing) over many rounds. Keep dependent steps sequential — e.g. create a track first, read its new ID from the result, then add clips to it.',
  'LEGACY TOOLS WITH A PROJECT: the older single-media tools (trim_video, adjust_speed, adjust_audio_volume, audio_fade, add_text, generate_captions, lyric_captions, youtube_soundtrack) keep their existing whole-project/output meaning on timeline builds. When the user names a specific clip or track, use the timeline tools instead; when they mean the whole video, the legacy tool is correct.',
  'MONTAGE REQUESTS: for "make a highlight video / montage", inspect the assets and timeline, choose an order and trims from the evidence you actually have (labels, durations, provided thumbnails, the user\'s words), preserve original audio unless told otherwise, add music only if available and requested, then verify with get_project_timeline and summarize. Never invent scene descriptions for clips you were not shown.',
].join('\n');
