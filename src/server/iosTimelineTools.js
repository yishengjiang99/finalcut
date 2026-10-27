// iOS-only timeline tools for multi-clip projects and multi-track audio,
// executed by the FinalCap iOS on-device timeline executor
// (ios/FinalCut/Timeline/TimelineToolExecutor.swift → ProjectCommand).
//
// CONTRACT: the tool names and argument shapes below are EXACTLY the ones the
// shipped device executor parses (snake_case IDs: clip_id, track_id,
// asset_id). Do not rename them server-side only — the device switch is the
// binding constraint, and a name it does not know falls through to
// "unsupported_on_device". Definitions are NOT in src/tools.js: the web tool
// list never contains them and the server has no implementation; calls are
// returned to the device through the client-execution protocol.
//
// Device result contract (TimelineToolExecutor.timelineSuccess):
//   { ok: true, executedOn: "device", output: {
//       project_duration,                 // project seconds after the edit
//       project,                          // fresh ProjectSummary (same shape as media.project)
//       affected_ids?, created_id?, message? } }
// Failures are { ok: false, error: "<code>" or "<code>: <hint>", executedOn: "device" }
// with codes such as clip_not_found, invalid_arguments,
// unsupported_on_device, no_media.
//
// Time conventions: all times are SECONDS. start/end/source_* are in
// SOURCE-media time; timeline_start / at are in PROJECT-timeline time.
// Volumes are linear gains: 1 = unchanged, 0.2 = 20%.
//
// Deferred beyond v1.2 (device does not implement them yet): batched edits,
// project revision checks, insert-at-index, per-track detail queries. The
// 6-round cap therefore applies to sequential calls; every mutation result
// carries the fresh project summary, which is what makes chaining reliable.

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Stable tool-result error codes the model may see from timeline tools. */
export const TIMELINE_ERROR_CODES = deepFreeze([
  'invalid_arguments',
  'asset_not_found',
  'clip_not_found',
  'audio_track_not_found',
  'invalid_source_range',
  'invalid_timeline_position',
  'unsupported_on_device',
  'resource_limit_exceeded',
  'cancelled',
  'no_media',
]);

const id = (description) => ({ type: 'string', minLength: 1, maxLength: 128, description });
const seconds = (description, extra = {}) => ({ type: 'number', minimum: 0, description, ...extra });
const gain = (description) => ({ type: 'number', minimum: 0, maximum: 4, description });

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

const CLIP_ID = id('Stable UUID of a video clip on the project timeline (from the project summary or get_timeline). Never invent an ID.');
const AUDIO_CLIP_ID = id('Stable UUID of an audio clip (from the project summary or get_timeline). Never invent an ID.');
const TRACK_ID = id('Stable UUID of a logical audio track / lane (from the project summary or get_timeline). Never invent an ID.');
const ASSET_ID = id('Stable UUID of an imported source asset (from list_project_assets or the project summary). Never invent an ID.');

/** Tool definitions (same shape as src/tools.js). */
export const IOS_TIMELINE_TOOLS = deepFreeze([
  // ── Inspection (read live device state; results carry the fresh summary) ──
  tool('get_timeline',
    'Read the CURRENT project timeline from the device. The result output contains "project" (the full project summary: assets, video clips in timeline order with source ranges and project start times, audio tracks and clips) and "project_duration". Use it before planning edits whenever the snapshot may be stale, and after an error like clip_not_found.',
    {}),
  tool('list_project_assets',
    'List the imported source media on the device (the result output\'s "project" summary contains them): stable asset UUIDs, type, display name, duration in seconds, whether a video has audio. Assets are sources; timeline clips reference them. Use this to resolve names like "the beach video" or "the music file" to asset UUIDs.',
    {}),
  tool('get_clip_info',
    'Read details of ONE video clip from the device: its asset, source range (source-media seconds), project start (project-timeline seconds), speed, original-audio state and gain, and transition out (in the result output\'s "clip" object).',
    { clip_id: CLIP_ID }, ['clip_id']),
  tool('get_project_duration',
    'Read the current total project duration in project-timeline seconds from the device (result output "duration" / "project_duration").',
    {}),

  // ── Video timeline mutations ──────────────────────────────────────────────
  tool('append_video_clips',
    'Append one or more imported video assets to the END of the video timeline, in the given order, each using its full source range. Does not move or change existing clips. The result\'s created_id / affected_ids report the new clip(s).',
    {
      asset_ids: {
        type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 128 },
        description: 'Asset UUIDs to append, in order.',
      },
    }, ['asset_ids']),
  tool('reorder_video_clips',
    'Reorder the video timeline. clip_ids must list EVERY current video clip UUID exactly once, in the new order ("the second clip" means the current timeline order, not import order). Original audio moves with its clip. Audio tracks are not affected.',
    {
      clip_ids: {
        type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', minLength: 1, maxLength: 128 },
        description: 'Every current video clip UUID, in the desired new timeline order.',
      },
    }, ['clip_ids']),
  tool('split_video_clip',
    'Split one video clip into two at a project-timeline position. "at" is in PROJECT-timeline seconds and must fall inside the clip. Both halves keep the clip\'s effects and original-audio settings. The result reports the created clip\'s UUID in created_id.',
    {
      clip_id: CLIP_ID,
      at: seconds('Split point in PROJECT-timeline seconds (not source time).'),
    }, ['clip_id', 'at']),
  tool('trim_video_clip',
    'Trim ONE video clip by setting its source range: start/end are in SOURCE-media seconds (inside the asset), not project time. Other clips shift on the timeline when this clip\'s length changes; independently placed audio clips do NOT move.',
    {
      clip_id: CLIP_ID,
      start: seconds('New start in source-media seconds.'),
      end: seconds('New end in source-media seconds (must be greater than start).'),
    }, ['clip_id', 'start', 'end']),
  tool('remove_video_clip',
    'Remove ONE video clip (and its original audio) from the timeline. Later clips shift earlier. Audio tracks are not affected. The source asset stays imported.',
    { clip_id: CLIP_ID }, ['clip_id']),
  tool('duplicate_video_clip',
    'Duplicate ONE video clip immediately after itself, with the same source range, speed, effects, and original-audio settings.',
    { clip_id: CLIP_ID }, ['clip_id']),
  tool('set_video_clip_speed',
    'Set the playback speed of ONE video clip (1 = normal, 0.5 = half speed, 2 = double). Changing speed changes the clip\'s project duration; later clips shift, independently placed audio does not.',
    {
      clip_id: CLIP_ID,
      speed: { type: 'number', minimum: 0.05, maximum: 16, description: 'Playback speed multiplier.' },
    }, ['clip_id', 'speed']),
  tool('apply_clip_effect',
    'Apply a frame effect to ONE video clip (clip_id) or to every clip (omit clip_id). kind selects the effect: brightness / contrast / saturation take "value" (brightness -1..1, contrast / saturation 0..2); hue takes "value" in degrees; color_filter takes "filter" (a look name the device supports) and optional "intensity" 0..1; flip_horizontal / flip_vertical take no value.',
    {
      clip_id: { ...CLIP_ID, description: 'Optional. Video clip UUID; omit to apply to every video clip.' },
      kind: { type: 'string', enum: ['brightness', 'contrast', 'saturation', 'hue', 'color_filter', 'flip_horizontal', 'flip_vertical'], description: 'Effect kind.' },
      value: { type: 'number', description: 'For brightness/contrast/saturation/hue: the amount (see description for ranges).' },
      filter: { type: 'string', maxLength: 64, description: 'For color_filter: the filter/look name.' },
      intensity: { type: 'number', minimum: 0, maximum: 1, description: 'For color_filter: 0..1.' },
    }, ['kind']),
  tool('set_video_clip_transition',
    'Set the transition OUT of one video clip into the next: type "cut", "cross_dissolve", or "fade_through_black", with a duration in seconds (device default 0.5). A non-cut transition overlaps the two clips, so total project duration shrinks by the overlap.',
    {
      clip_id: CLIP_ID,
      type: { type: 'string', enum: ['cut', 'cross_dissolve', 'fade_through_black'], description: 'Transition type.' },
      duration: seconds('Transition duration in seconds.', { maximum: 10 }),
    }, ['clip_id', 'type']),

  // ── Audio timeline mutations ─────────────────────────────────────────────
  tool('create_audio_lane',
    'Create a new empty logical audio track ("lane") and return its UUID in the result\'s created_id. kind: music (default), voiceover, effects, or other. Creating a lane never removes or replaces existing tracks or soundtracks.',
    {
      name: { type: 'string', maxLength: 200, description: 'Optional display name, e.g. "Background Music".' },
      kind: { type: 'string', enum: ['music', 'voiceover', 'effects', 'other'], description: 'Optional lane kind (default music).' },
    }),
  tool('insert_audio_clip',
    'Place an imported audio asset on a logical audio track at a project-timeline position. Audio clips may overlap freely. This ADDS a clip; it never deletes an existing soundtrack. Set volume for its starting gain (0.2 = 20%). The result\'s created_id is the new audio clip\'s UUID.',
    {
      track_id: TRACK_ID,
      asset_id: ASSET_ID,
      timeline_start: seconds('Start position in PROJECT-timeline seconds.'),
      source_start: seconds('Optional start in source-media seconds (default 0).'),
      source_duration: seconds('Optional length of source audio to use, in source-media seconds (default: to the asset end).'),
      volume: gain('Optional linear gain for the new clip (default 1).'),
      loop: { type: 'boolean', description: 'Optional. Repeat the source range until repeat_until or the project end.' },
      repeat_until: seconds('Optional project-timeline second at which looping stops.'),
    }, ['track_id', 'asset_id', 'timeline_start']),
  tool('move_audio_clip',
    'Move ONE audio clip to a new project-timeline start, optionally onto a different track (track_id). Its source range and gain are unchanged.',
    {
      clip_id: AUDIO_CLIP_ID,
      timeline_start: seconds('New start in PROJECT-timeline seconds.'),
      track_id: { ...TRACK_ID, description: 'Optional. Move the clip onto this track.' },
    }, ['clip_id', 'timeline_start']),
  tool('trim_audio_clip',
    'Trim ONE audio clip\'s source range: source_start and source_duration are in SOURCE-media seconds. Its project-timeline start does not change.',
    {
      clip_id: AUDIO_CLIP_ID,
      source_start: seconds('New start in source-media seconds.'),
      source_duration: seconds('New length of source audio used, in seconds (must be > 0).', { exclusiveMinimum: 0 }),
    }, ['clip_id', 'source_start', 'source_duration']),
  tool('remove_audio_clip',
    'Remove ONE audio clip from its track. The track and its other clips remain.',
    { clip_id: AUDIO_CLIP_ID }, ['clip_id']),
  tool('set_audio_clip_volume',
    'Set the linear gain of ONE audio clip (1 = unchanged, 0.2 = 20%, 0 = silent). Only that clip changes — not its whole track and not the project.',
    { clip_id: AUDIO_CLIP_ID, volume: gain('Linear gain for this audio clip.') }, ['clip_id', 'volume']),
  tool('set_audio_track_volume',
    'Set the linear gain of ONE whole logical audio track (1 = unchanged, 0.2 = 20%). This multiplies every clip on that track and nothing else — use it for "lower the music to 20%" when the music is a track.',
    { track_id: TRACK_ID, volume: gain('Linear gain for the whole track.') }, ['track_id', 'volume']),
  tool('mute_audio_track',
    'Mute or unmute audio. With track_id: mutes that whole logical track. With clip_id (a VIDEO clip): mutes only that video clip\'s ORIGINAL camera audio — music, narration and other clips are untouched (this is the tool for "mute the audio in clip three"). Pass exactly one of track_id / clip_id. muted defaults to true.',
    {
      track_id: { ...TRACK_ID, description: 'Optional. Mute this whole track (do not combine with clip_id).' },
      clip_id: { ...CLIP_ID, description: 'Optional. Mute this video clip\'s original audio only (do not combine with track_id).' },
      muted: { type: 'boolean', description: 'Optional. true mutes (default), false unmutes.' },
    }),
  tool('set_audio_fade',
    'Set a fade on ONE audio clip: type "in" (fade in from its start) or "out" (fade out ending at the clip\'s end on the project timeline), with duration in seconds. E.g. "fade the music out over the last two seconds" = type "out", duration 2, on the music clip that ends with the project. One call sets one fade; call twice for both.',
    {
      clip_id: AUDIO_CLIP_ID,
      type: { type: 'string', enum: ['in', 'out'], description: 'Which fade to set.' },
      duration: seconds('Fade duration in seconds.', { maximum: 3600 }),
    }, ['clip_id', 'type', 'duration']),
  tool('loop_audio_clip',
    'Make ONE audio clip repeat its source range until repeat_until (project-timeline seconds) or, when omitted, the project end. Use for short music beds under a longer video.',
    {
      clip_id: AUDIO_CLIP_ID,
      repeat_until: seconds('Optional project-timeline second at which looping stops.'),
    }, ['clip_id']),
  tool('set_audio_ducking',
    'Automatically lower ONE music AUDIO CLIP while dialogue is present, restoring it afterwards. clip_id is the music clip to lower; the device analyses the video clips\' original audio on-device to find speech — never invent speech timestamps. attenuation (0..1) is the ducking depth applied on device (default 0.25 when omitted). Voiceover and dialogue themselves are never lowered.',
    {
      clip_id: { ...AUDIO_CLIP_ID, description: 'The music audio clip to duck.' },
      attenuation: { type: 'number', minimum: 0, maximum: 1, description: 'Optional. Ducking depth 0..1 (device default 0.25).' },
    }, ['clip_id']),

  // ── Project-level ─────────────────────────────────────────────────────────
  tool('set_project_canvas',
    'Set the project canvas (output frame size) in pixels. Clips are fitted without distortion; fit optionally selects "aspect_fit" (letterbox) or "aspect_fill" (crop). This changes the output size, not any clip\'s content.',
    {
      width: { type: 'integer', minimum: 2, maximum: 16384, description: 'Canvas width in pixels.' },
      height: { type: 'integer', minimum: 2, maximum: 16384, description: 'Canvas height in pixels.' },
      fit: { type: 'string', enum: ['aspect_fit', 'aspect_fill'], description: 'Optional fit mode.' },
    }, ['width', 'height']),
]);

export const IOS_TIMELINE_TOOL_NAMES = deepFreeze(IOS_TIMELINE_TOOLS.map(t => t.function.name));

/** Timeline tools that change the project (the rest are read-only inspection). */
export const TIMELINE_MUTATION_TOOL_NAMES = deepFreeze(
  IOS_TIMELINE_TOOL_NAMES.filter(n => ![
    'get_timeline', 'list_project_assets', 'get_clip_info', 'get_project_duration',
  ].includes(n)),
);

/** Every timeline tool is video-project only (never offered for photo editing or the web editor). */
export const IOS_TIMELINE_TOOL_MEDIA_TYPES = deepFreeze(
  Object.fromEntries(IOS_TIMELINE_TOOL_NAMES.map(n => [n, ['video']])),
);

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
 * Server-owned agent instructions for timeline projects, appended to the
 * client-execution system prompt whenever a project snapshot is present AND
 * the build is offered timeline tools.
 */
export const TIMELINE_AGENT_INSTRUCTIONS = [
  'The media being edited is a multi-clip PROJECT on the device, not a single file. The device is the source of truth: the project context is a snapshot, and get_timeline / list_project_assets / get_clip_info read live device state. Every timeline mutation result also returns the fresh project summary in output.project — use it (and output.affected_ids / output.created_id) to chain dependent steps instead of guessing IDs.',
  'INSPECT BEFORE UNCERTAIN CHANGES: when the user refers to a clip by subject, label, or order ("the beach clip", "the second clip"), resolve it from the project context or get_timeline. Never invent an asset, clip, or track UUID. "The second clip" means the current TIMELINE order, not the import order; after reordering, use the updated arrangement.',
  'RESPECT EDITING SCOPE: distinguish a source asset, one video clip, the selected clip, one audio clip, a whole logical audio track, and the entire project. A clip-specific request must affect only that clip. "Mute the audio in clip three" = mute_audio_track with that clip\'s clip_id (its original camera audio), never the music or narration tracks.',
  'PRESERVE UNSPECIFIED PROPERTIES: apply minimal, targeted mutations. "Lower the music to 20%" changes only the music track/clip volume — do not mute dialogue, reorder clips, or remove other tracks. "Add another soundtrack" ADDS a lane/clip (create_audio_lane + insert_audio_clip); never delete or replace an existing soundtrack unless asked.',
  'TIMING: start/end/source_start/source_duration are SOURCE-media seconds; timeline_start/at are PROJECT-timeline seconds. Trimming or speeding a video clip shifts later video clips, but independently placed audio clips do not move — re-check audio placement after changing video lengths when sync matters. Do not place an audio clip beyond the project duration unless the user asked for that.',
  'AUDIO SCOPES: original camera audio belongs to its video clip; background music, narration/voiceover, and effects live on separate logical lanes and can overlap. For "lower the music when someone speaks", use set_audio_ducking on the music CLIP — the device analyses speech itself; never fabricate speech timestamps, and do not lower the whole project instead.',
  'VERIFY EXECUTION: a tool call is a proposal, not a result. Wait for the device result; use its project summary, affected/created IDs, and error text to decide the next step. In the final answer report ONLY edits the device confirmed (ok:true). If a requested feature is unavailable, say so plainly — never claim an export happened unless an export tool actually ran.',
  'RECOVER WITHOUT LOOPS: device errors look like "<code>: <hint>" — follow the hint. On clip_not_found / asset_not_found, call get_timeline ONCE to refresh state, then retry with the corrected ID; never repeat an identical failing call. Respect skipped_by_user and unsupported_on_device as final for that tool this turn.',
  'SEQUENCING: you have at most 6 tool rounds per turn, and there is no batch tool — plan the shortest sequence of calls that completes the request, preferring one call per edit and using created_id from each result for the next step. Independent calls whose arguments you already know can be emitted together in one round.',
  'LEGACY TOOLS WITH A PROJECT: the older single-media tools (trim_video, adjust_speed, adjust_audio_volume, audio_fade, add_text, generate_captions, lyric_captions, youtube_soundtrack) act on the device\'s legacy/whole-project path — on a timeline project the app translates some of them onto the selected clip and rejects ambiguous ones (trim/speed on a multi-clip project). When the user names a specific clip or track, use the timeline tools instead; when they mean the whole video, the legacy tool is correct.',
  'MONTAGE REQUESTS: for "make a highlight video / montage", inspect the assets and timeline, choose an order and trims from the evidence you actually have (labels, durations, provided thumbnails, the user\'s words), preserve original audio unless told otherwise, add music only if available and requested, then verify with get_timeline and summarize. Never invent scene descriptions for clips you were not shown.',
].join('\n');
