// Local scratch check of the engine against a vite dev server (not part of the suite).
import { chromium } from '@playwright/test';
const PORT = process.env.PORT || 5211;
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${PORT}/legal/terms.html`);
const fixture = '/@fs' + process.cwd() + '/tests/e2e/fixtures/testclip-6s.mp4';
const out = await page.evaluate(async (fixture) => {
  const eng = await import('/src/wasm/ffmpegEngine.js');
  const bytes = new Uint8Array(await (await fetch(fixture)).arrayBuffer());
  const results = { isolated: crossOriginIsolated };
  const info = async (data, mime) => { const s = eng.summarizeProbe(await eng.probeMedia(data, mime)); return `${data.length}b ${s.width}x${s.height} ${s.duration?.toFixed(2)}s a=${s.hasAudio} ${s.videoCodec}/${s.audioCodec}`; };
  results.input = await info(bytes, 'video/mp4');
  const t = async (name, fn) => { const t0 = performance.now(); try { results[name] = `${await fn()} (${Math.round(performance.now() - t0)}ms)`; } catch (e) { results[name] = 'FAILED: ' + String(e?.message || e).slice(0, 300) + ' ' + String(e?.stderr || '').slice(-300); } };
  const op = (operation, args, mime = 'video/mp4', src = bytes) => async () => { const r = await eng.processMedia(operation, args, src, mime); return `${r.contentType} ${await info(r.data, r.contentType)}`; };
  const ops = {
    trim: ['trim_video', { start: 1, end: 3 }], resize: ['resize_video', { width: 161, height: 120 }], crop: ['crop_video', { width: 101, height: 100, x: 0, y: 0 }],
    rotate: ['rotate_video', { angle: 90 }], hflip: ['flip_video_horizontal', {}], vflip: ['flip_video_vertical', {}], text: ['add_text', { text: "Hello: it's 50%, [ok]; yes", fontsize: 20 }],
    color: ['apply_color_filter', { filter: 'sepia' }], bright: ['adjust_brightness', { brightness: 0.2 }], contrast: ['adjust_contrast', { contrast: 1.5 }], hue: ['adjust_hue', { degrees: 90 }], sat: ['adjust_saturation', { saturation: 2 }],
    speed2: ['speed_video', { speed: 2 }], speed025: ['speed_video', { speed: 0.25 }], volume: ['adjust_volume', { volume: 0.5 }], fadeout: ['audio_fade', { type: 'out', duration: 1 }], fadein: ['audio_fade', { type: 'in', duration: 1 }],
    highpass: ['highpass_filter', { frequency: 200 }], lowpass: ['lowpass_filter', { frequency: 3000 }], echo: ['echo_effect', { delay: 500, decay: 0.5 }], bass: ['bass_adjustment', { gain: 5 }], treble: ['treble_adjustment', { gain: -5 }],
    eq: ['equalizer', { frequency: 1000, gain: 5 }], normalize: ['normalize_audio', {}], delay: ['delay_audio', { delay: 500 }], chorus: ['audio_chorus', {}], flanger: ['audio_flanger', {}], phaser: ['audio_phaser', {}],
    vibrato: ['audio_vibrato', {}], tremolo: ['audio_tremolo', {}], compressor: ['audio_compressor', {}], dynaudnorm: ['audio_dynamic_normalize', {}], compand: ['audio_dynamic_normalize', { mode: 'compand' }], gate: ['audio_gate', {}],
    widen: ['audio_stereo_widen', {}], reverse: ['audio_reverse', {}], limiter: ['audio_limiter', {}], silence: ['audio_silence_remove', {}], pan: ['audio_pan', { pan: -0.5 }],
    extract_mp3: ['extract_audio', {}], extract_ogg: ['extract_audio', { format: 'ogg' }], extract_m4a: ['extract_audio', { format: 'm4a' }], extract_wav: ['extract_audio', { format: 'wav' }], extract_flac: ['extract_audio', { format: 'flac' }], extract_aac: ['extract_audio', { format: 'aac' }],
    to_wma: ['convert_audio_format', { format: 'wma' }], to_mkv: ['convert_video_format', { format: 'mkv' }], to_mov: ['convert_video_format', { format: 'mov' }], to_avi: ['convert_video_format', { format: 'avi' }], to_flv: ['convert_video_format', { format: 'flv' }],
    to_webm: ['convert_video_format', { format: 'webm' }], to_ogv: ['convert_video_format', { format: 'ogv' }], to_mp4_x265: ['convert_video_format', { format: 'mp4', codec: 'libx265' }], fade_tr: ['fade_transition', { duration: 1 }],
  };
  const only = new URLSearchParams(location.search).get('only');
  for (const [name, [o, a]] of Object.entries(ops)) await t(name, op(o, a));
  let png;
  await t('frame_png', async () => { const r = await eng.runCliCommand('ffmpeg -i input -frames:v 1 output.png', bytes, 'video/mp4'); png = r.data; return `${r.format} ${r.data.length}b`; });
  await t('photo_rotate', op('rotate_video', { angle: 90 }, 'image/png', png));
  await t('photo_text', op('add_text', { text: 'Hi' }, 'image/png', png));
  await t('photo_to_webp', op('convert_image_format', { format: 'webp' }, 'image/png', png));
  await t('photo_to_jpg', op('convert_image_format', { format: 'jpg' }, 'image/png', png));
  await t('photo_trim', op('trim_video', { start: 0, end: 1 }, 'image/png', png));
  await t('cli_gif', async () => { const r = await eng.runCliCommand('ffmpeg -i input.mp4 -vf "fps=5,scale=160:-2" output.gif', bytes, 'video/mp4'); return `${r.format} ${r.data.length}b`; });
  await t('cli_bad', async () => { await eng.runCliCommand('ffmpeg -i input.mp4 -vf nosuchfilter output.mp4', bytes, 'video/mp4'); return 'unexpectedly ok'; });
  let mp3, silent;
  await t('join_fade', async () => {
    silent = (await eng.runCliCommand('ffmpeg -i input -an -t 3 -vf scale=200:100 -c:v libx264 -preset ultrafast output.mp4', bytes, 'video/mp4')).data;
    return info(await eng.joinClips({ transition: 'fade', duration: 1 }, [bytes, silent, bytes]), 'video/mp4');
  });
  await t('join_crossfade', async () => info(await eng.joinClips({ transition: 'crossfade', duration: 1 }, [bytes, silent, bytes]), 'video/mp4'));
  await t('join_wipe', async () => info(await eng.joinClips({ transition: 'wipe_left', duration: 1 }, [bytes, bytes]), 'video/mp4'));
  await t('audio_replace', async () => { mp3 = (await eng.processMedia('extract_audio', {}, bytes, 'video/mp4')).data; return info(await eng.addAudioTrack({ mode: 'replace', volume: 1 }, silent, 'video/mp4', { bytes: mp3, extension: 'mp3' }), 'video/mp4'); });
  await t('audio_mix', async () => info(await eng.addAudioTrack({ mode: 'mix', volume: 0.5 }, bytes, 'video/mp4', { bytes: mp3, extension: 'mp3' }), 'video/mp4'));
  const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello world\n\n2\n00:00:02,000 --> 00:00:04,000\nSecond line';
  await t('burn', async () => info(await eng.burnSubtitles({ srt, translatedSrt: srt.replace('Hello world', 'Hola mundo'), style: 'yellow', position: 'bottom' }, bytes, 'video/mp4'), 'video/mp4'));
  await t('speech', async () => { const d = await eng.extractSpeechAudio(bytes, 'video/mp4'); return `${d.length}b ${String.fromCharCode(...d.slice(0, 4))}`; });
  await t('thumb', async () => { const d = await eng.thumbnail(bytes, 'video/mp4', { at: 1 }); return `${d.length}b`; });
  results.mode = eng.getHost().mode; results.state = eng.getEngineState();
  return results;
}, fixture);
console.log(JSON.stringify(out, null, 1));
await browser.close();
