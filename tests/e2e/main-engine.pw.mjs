// E2E: the main app's in-browser FFmpeg engine (src/wasm/ffmpegEngine.js) runs every tool's
// argv builders against the real self-hosted core, in a cross-origin-isolated page (mt) and with
// ?wasm=st (single-thread fallback). Nothing may leave the browser: every request is guarded.
//
// This is the adhoc harness (tests/e2e/_engine-adhoc.mjs) turned into a real spec: each op runs,
// the output is probed (duration, dimensions, streams), and failures must be the expected
// unsupported_in_browser errors, never a hang or a crash.
import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'testclip-6s.mp4');
const RESULTS_DIR = path.join(HERE, '..', '..', 'test-results', 'e2e-main');
const FIXTURE_URL = '/@fs' + FIXTURE;

const MEDIA_CT = /^(video|audio|image)\/|multipart\/form-data|application\/octet-stream/i;

/** Fail on any request that could carry media off the device. */
async function installNetworkGuard(page, baseURL) {
  const problems = [];
  const origin = new URL(baseURL).origin;
  const fixture = readFileSync(FIXTURE);
  const probe = fixture.subarray(1024, 1024 + 4096);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    const u = new URL(url);
    if (u.origin !== origin) problems.push(`third-party request: ${req.method()} ${url}`);
    const body = req.postDataBuffer();
    if (body?.length) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) problems.push(`non-GET with body: ${req.method()} ${u.pathname} (${body.length} B)`);
      if (MEDIA_CT.test(req.headers()['content-type'] || '')) problems.push(`media content-type: ${u.pathname}`);
      if (body.includes(probe)) problems.push(`request body contains fixture bytes: ${u.pathname}`);
    }
  });
  return problems;
}

const SRT = '1\n00:00:00,000 --> 00:00:02,000\nHello world\n\n2\n00:00:02,000 --> 00:00:04,000\nSecond line';
const SRT_ZH = '1\n00:00:00,000 --> 00:00:02,000\n你好世界\n\n2\n00:00:02,000 --> 00:00:04,000\n第二行字幕';
const ASS_ZH = `[Script Info]
Title: test
ScriptType: v4.00+
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Inter,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,你好世界`;
const SRT_ES = SRT.replace('Hello world', 'Hola mundo');

// The op matrix, grouped so a failure is easy to bisect. Each entry: [name, run] where run is
// op(engineMethod, ...args) (media args by $ref, resolved in the page), or
// { expectError: /re/, run } when the op must fail with a known error.
const op = (call, ...args) => ({ call, args });
const ref = (name) => ({ $ref: name });
const $bytes = ref('bytes');
const $png = ref('png');
const $silent = ref('silent');
const $mp3 = ref('mp3');

const GROUPS = {
  'frame ops': [
    ['trim', op('processMedia', 'trim_video', { start: 1, end: 3 }, $bytes, 'video/mp4')],
    ['resize', op('processMedia', 'resize_video', { width: 161, height: 120 }, $bytes, 'video/mp4')],
    ['crop', op('processMedia', 'crop_video', { width: 101, height: 100, x: 0, y: 0 }, $bytes, 'video/mp4')],
    ['rotate', op('processMedia', 'rotate_video', { angle: 90 }, $bytes, 'video/mp4')],
    ['hflip', op('processMedia', 'flip_video_horizontal', {}, $bytes, 'video/mp4')],
    ['vflip', op('processMedia', 'flip_video_vertical', {}, $bytes, 'video/mp4')],
    ['text', op('processMedia', 'add_text', { text: "Hello: it's 50%, [ok]; yes", fontsize: 20 }, $bytes, 'video/mp4')],
    ['color', op('processMedia', 'apply_color_filter', { filter: 'sepia' }, $bytes, 'video/mp4')],
    ['bright', op('processMedia', 'adjust_brightness', { brightness: 0.2 }, $bytes, 'video/mp4')],
    ['contrast', op('processMedia', 'adjust_contrast', { contrast: 1.5 }, $bytes, 'video/mp4')],
    ['hue', op('processMedia', 'adjust_hue', { degrees: 90 }, $bytes, 'video/mp4')],
    ['sat', op('processMedia', 'adjust_saturation', { saturation: 2 }, $bytes, 'video/mp4')],
    ['speed2', op('processMedia', 'speed_video', { speed: 2 }, $bytes, 'video/mp4')],
    ['speed025', op('processMedia', 'speed_video', { speed: 0.25 }, $bytes, 'video/mp4')],
    ['fade_tr', op('processMedia', 'fade_transition', { duration: 1 }, $bytes, 'video/mp4')],
  ],
  'audio ops': [
    ['volume', op('processMedia', 'adjust_volume', { volume: 0.5 }, $bytes, 'video/mp4')],
    ['fadeout', op('processMedia', 'audio_fade', { type: 'out', duration: 1 }, $bytes, 'video/mp4')],
    ['fadein', op('processMedia', 'audio_fade', { type: 'in', duration: 1 }, $bytes, 'video/mp4')],
    ['highpass', op('processMedia', 'highpass_filter', { frequency: 200 }, $bytes, 'video/mp4')],
    ['lowpass', op('processMedia', 'lowpass_filter', { frequency: 3000 }, $bytes, 'video/mp4')],
    ['echo', op('processMedia', 'echo_effect', { delay: 500, decay: 0.5 }, $bytes, 'video/mp4')],
    ['bass', op('processMedia', 'bass_adjustment', { gain: 5 }, $bytes, 'video/mp4')],
    ['treble', op('processMedia', 'treble_adjustment', { gain: -5 }, $bytes, 'video/mp4')],
    ['eq', op('processMedia', 'equalizer', { frequency: 1000, gain: 5 }, $bytes, 'video/mp4')],
    ['normalize', op('processMedia', 'normalize_audio', {}, $bytes, 'video/mp4')],
    ['delay', op('processMedia', 'delay_audio', { delay: 500 }, $bytes, 'video/mp4')],
    ['chorus', op('processMedia', 'audio_chorus', {}, $bytes, 'video/mp4')],
    ['flanger', op('processMedia', 'audio_flanger', {}, $bytes, 'video/mp4')],
    ['phaser', op('processMedia', 'audio_phaser', {}, $bytes, 'video/mp4')],
    ['tremolo', op('processMedia', 'audio_tremolo', {}, $bytes, 'video/mp4')],
    ['compressor', op('processMedia', 'audio_compressor', {}, $bytes, 'video/mp4')],
    ['dynaudnorm', op('processMedia', 'audio_dynamic_normalize', {}, $bytes, 'video/mp4')],
    ['compand', op('processMedia', 'audio_dynamic_normalize', { mode: 'compand' }, $bytes, 'video/mp4')],
    ['gate', op('processMedia', 'audio_gate', {}, $bytes, 'video/mp4')],
    ['widen', op('processMedia', 'audio_stereo_widen', {}, $bytes, 'video/mp4')],
    ['reverse', op('processMedia', 'audio_reverse', {}, $bytes, 'video/mp4')],
    ['limiter', op('processMedia', 'audio_limiter', {}, $bytes, 'video/mp4')],
    ['silence', op('processMedia', 'audio_silence_remove', {}, $bytes, 'video/mp4')],
    ['pan', op('processMedia', 'audio_pan', { pan: -0.5 }, $bytes, 'video/mp4')],
  ],
  'unsupported stays unsupported': [
    ['vibrato', { expectError: /vibrato/i, run: op('processMedia', 'audio_vibrato', {}, $bytes, 'video/mp4') }],
    ['webm_vp9', { expectError: /vp9/i, run: op('processMedia', 'convert_video_format', { format: 'webm', codec: 'libvpx-vp9' }, $bytes, 'video/mp4') }],
    ['cli_bad_filter', { expectError: /nosuchfilter|unknown filter/i, run: op('runCliCommand', 'ffmpeg -i input.mp4 -vf nosuchfilter output.mp4', $bytes, 'video/mp4') }],
    ['photo_trim', { expectError: /not supported for photos/i, run: op('processMedia', 'trim_video', { start: 0, end: 1 }, $png, 'image/png') }],
  ],
  'conversions': [
    ['extract_mp3', op('processMedia', 'extract_audio', {}, $bytes, 'video/mp4')],
    ['extract_ogg', op('processMedia', 'extract_audio', { format: 'ogg' }, $bytes, 'video/mp4')],
    ['extract_m4a', op('processMedia', 'extract_audio', { format: 'm4a' }, $bytes, 'video/mp4')],
    ['extract_wav', op('processMedia', 'extract_audio', { format: 'wav' }, $bytes, 'video/mp4')],
    ['extract_flac', op('processMedia', 'extract_audio', { format: 'flac' }, $bytes, 'video/mp4')],
    ['extract_aac', op('processMedia', 'extract_audio', { format: 'aac' }, $bytes, 'video/mp4')],
    ['to_wma', op('processMedia', 'convert_audio_format', { format: 'wma' }, $bytes, 'video/mp4')],
    ['to_mkv', op('processMedia', 'convert_video_format', { format: 'mkv' }, $bytes, 'video/mp4')],
    ['to_mov', op('processMedia', 'convert_video_format', { format: 'mov' }, $bytes, 'video/mp4')],
    ['to_avi', op('processMedia', 'convert_video_format', { format: 'avi' }, $bytes, 'video/mp4')],
    ['to_flv', op('processMedia', 'convert_video_format', { format: 'flv' }, $bytes, 'video/mp4')],
    ['to_webm', op('processMedia', 'convert_video_format', { format: 'webm' }, $bytes, 'video/mp4')],
    ['to_ogv', op('processMedia', 'convert_video_format', { format: 'ogv' }, $bytes, 'video/mp4')],
    ['to_mp4_x265', op('processMedia', 'convert_video_format', { format: 'mp4', codec: 'libx265' }, $bytes, 'video/mp4')],
  ],
  'photos': [
    ['frame_png', { ...op('runCliCommand', 'ffmpeg -i input -frames:v 1 output.png', $bytes, 'video/mp4'), then: 'savePng' }],
    ['photo_rotate', op('processMedia', 'rotate_video', { angle: 90 }, $png, 'image/png')],
    ['photo_text', op('processMedia', 'add_text', { text: 'Hi' }, $png, 'image/png')],
    ['photo_to_webp', op('processMedia', 'convert_image_format', { format: 'webp' }, $png, 'image/png')],
    ['photo_to_jpg', op('processMedia', 'convert_image_format', { format: 'jpg' }, $png, 'image/png')],
  ],
  'joins and audio track': [
    ['join_fade', op('joinClips', { transition: 'fade', duration: 1 }, [$bytes, $silent, $bytes])],
    ['join_crossfade', op('joinClips', { transition: 'crossfade', duration: 1 }, [$bytes, $silent, $bytes])],
    ['join_wipe', op('joinClips', { transition: 'wipe_left', duration: 1 }, [$bytes, $bytes])],
    ['audio_replace', op('addAudioTrack', { mode: 'replace', volume: 1 }, $silent, 'video/mp4', { bytes: $mp3, extension: 'mp3' })],
    ['audio_mix', op('addAudioTrack', { mode: 'mix', volume: 0.5 }, $bytes, 'video/mp4', { bytes: $mp3, extension: 'mp3' })],
  ],
  'captions, speech, thumbnails, cli': [
    ['burn', op('burnSubtitles', { srt: SRT, translatedSrt: SRT_ES, style: 'yellow', position: 'bottom' }, $bytes, 'video/mp4')],
    ['burn_cjk', op('burnSubtitles', { srt: SRT_ZH, style: 'default', position: 'bottom' }, $bytes, 'video/mp4')],
    ['burn_ass_cjk', op('burnAss', ASS_ZH, $bytes, 'video/mp4')],
    ['speech', { ...op('extractSpeechAudio', $bytes, 'video/mp4'), then: 'magic' }],
    ['thumb', { ...op('thumbnail', $bytes, 'video/mp4', { at: 1 }), then: 'size' }],
    ['cli_gif', op('runCliCommand', 'ffmpeg -i input.mp4 -vf "fps=5,scale=160:-2" output.gif', $bytes, 'video/mp4')],
    ['cli_webm', op('runCliCommand', 'ffmpeg -i input -t 2 output.webm', $bytes, 'video/mp4')],
    ['cli_x265', op('runCliCommand', 'ffmpeg -i input -t 2 -c:v libx265 -an output.mp4', $bytes, 'video/mp4')],
  ],
};

async function runGroup(page, groupName, mode) {
  return page.evaluate(async ({ group, fixture, mode }) => {
    const eng = await import('/src/wasm/ffmpegEngine.js');
    const bytes = new Uint8Array(await (await fetch(fixture)).arrayBuffer());
    const info = async (data, mime) => {
      const s = eng.summarizeProbe(await eng.probeMedia(data, mime));
      return `${data.length}b ${s.width}x${s.height} ${s.duration?.toFixed(2)}s a=${s.hasAudio} ${s.videoCodec}/${s.audioCodec}`;
    };
    const FORMAT_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'video/webm', mp4: 'video/mp4' };
    const media = { bytes, png: null };
    // Shared fixtures for the joins group, built once.
    media.silent = (await eng.runCliCommand('ffmpeg -i input -an -t 3 -vf scale=200:100 -c:v libx264 -preset ultrafast output.mp4', bytes, 'video/mp4')).data;
    media.mp3 = (await eng.processMedia('extract_audio', {}, bytes, 'video/mp4')).data;
    const resolve = (v) => {
      if (Array.isArray(v)) return v.map(resolve);
      if (v && typeof v === 'object') {
        if ('$ref' in v) return media[v.$ref];
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
      }
      return v;
    };
    const after = {
      savePng: (r) => { media.png = r.data; return r.format + ' ' + r.data.length + 'b'; },
      magic: (d) => d.length + 'b ' + String.fromCharCode(d[0], d[1], d[2], d[3]),
      size: (d) => d.length + 'b',
    };
    const results = {};
    for (const [name, rawSpec] of group) {
      // H.265 fails fast on the single-threaded core (impractical there); expect the error on st.
      const spec = (mode !== 'mt' && (name === 'to_mp4_x265' || name === 'cli_x265'))
        ? { expectError: /multi-threaded/i, run: rawSpec.run || rawSpec }
        : rawSpec;
      const run = spec.run || spec;
      const t0 = performance.now();
      try {
        const out = await eng[run.call](...resolve(run.args));
        const r = run.then ? after[run.then](out) : out;
        let status;
        if (r && r.data) {
          const ct = r.contentType || FORMAT_MIME[r.format] || 'video/mp4';
          status = `${ct} ${await info(r.data, ct)}`;
        } else if (r instanceof Uint8Array) {
          status = await info(r, 'video/mp4');
        } else {
          status = String(r);
        }
        results[name] = `OK ${status} (${Math.round(performance.now() - t0)}ms)`;
      } catch (e) {
        const msg = String(e?.message || e);
        if (spec.expectError && spec.expectError.test(`${msg} ${e?.code || ''}`)) {
          results[name] = `EXPECTED-ERROR ${e?.code || ''} ${msg.slice(0, 120)} (${Math.round(performance.now() - t0)}ms)`;
        } else {
          results[name] = `FAILED ${e?.code || ''} ${msg.slice(0, 300)}`;
        }
      }
    }
    results.__mode = eng.getHost().mode;
    return results;
  }, { group: GROUPS[groupName], fixture: FIXTURE_URL, mode });
}

for (const [groupName] of Object.entries(GROUPS)) {
  test(`${groupName}`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(900_000);
    const { expectedMode, query } = testInfo.project.metadata;
    const problems = await installNetworkGuard(page, baseURL);
    const consoleErrors = [];
    const badResponses = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    page.on('response', (r) => { if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) badResponses.push(`${r.status()} ${r.url()}`); });
    page.on('pageerror', (e) => consoleErrors.push('[pageerror] ' + e.message));
    await page.goto(`/legal/terms.html${query}`);
    const results = await runGroup(page, groupName, expectedMode);
    expect(results.__mode, 'engine mode').toBe(expectedMode);
    const failed = Object.entries(results).filter(([k, v]) => k !== '__mode' && v.startsWith('FAILED'));
    const report = { group: groupName, mode: expectedMode, isolated: await page.evaluate(() => self.crossOriginIsolated), results };
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(path.join(RESULTS_DIR, `engine-${groupName.replace(/\W+/g, '-')}-${expectedMode}.json`), JSON.stringify(report, null, 1));
    console.log(`[engine ${expectedMode} ${groupName}]`, JSON.stringify(results, null, 1).slice(0, 3000));
    expect(failed, failed.map(([k, v]) => `${k}: ${v}`).join('\n')).toEqual([]);
    expect(problems, problems.join('\n')).toEqual([]);
    expect(badResponses, badResponses.join('\n')).toEqual([]);
    // Console errors that are not just a failed subresource (already covered by badResponses).
    expect(consoleErrors.filter((e) => !/Failed to load resource/i.test(e))).toEqual([]);
  });
}
