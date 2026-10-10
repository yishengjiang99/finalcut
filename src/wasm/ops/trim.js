// Pure argv builder for trim_video. Port of the server's applyTrim (src/server/ffmpegOps.js):
// `-ss START -i IN -t (END-START) -c copy` (keyframe-aligned, same output as /api/process-video).
// Isomorphic: no DOM, no Node APIs, so the server/iOS fallback can share it later.

export class TrimArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrimArgsError';
    this.code = 'invalid_arguments';
  }
}

function toSeconds(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string' && /^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/.test(v.trim())) {
    return v.trim().split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new TrimArgsError(`${name} must be seconds >= 0 or HH:MM:SS`);
  return n;
}

const fmt = (n) => String(+n.toFixed(3));

/**
 * @param {{start?:number|string,end?:number|string,precise?:boolean}} args
 * @param {{input:string, output:string, duration?:number, threads?:number}} io
 * @returns {string[]} ffmpeg argv (no leading "ffmpeg")
 */
export function buildTrimArgs({ start, end, precise = false } = {}, { input, output, duration, threads } = {}) {
  const s = toSeconds(start, 'start');
  const e = toSeconds(end, 'end');
  if (s === null && e === null) throw new TrimArgsError('trim_video requires a start and/or end time (seconds or HH:MM:SS)');
  if (s !== null && e !== null && e <= s) throw new TrimArgsError('trim_video end must be greater than start');
  if (s !== null && Number.isFinite(duration) && s >= duration) throw new TrimArgsError('start is past the end of the clip');
  if (!input || !output) throw new TrimArgsError('input and output paths are required');

  const argv = ['-hide_banner', '-nostdin', '-y'];
  if (s !== null) argv.push('-ss', fmt(s));
  argv.push('-i', input);
  if (e !== null) argv.push('-t', fmt(e - (s ?? 0)));
  // Output-side -threads caps the x264 encoder. Without it x264 auto-picks ~1.5x cores and the
  // mt core deadlocks (measured: 8 threads hangs, 6 aborts, 4 works). Host caps this at 4.
  if (Number.isInteger(threads) && threads > 0) argv.push('-threads', String(threads));
  if (precise) {
    argv.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k');
  } else {
    argv.push('-c', 'copy');
  }
  argv.push('-movflags', '+faststart', output);
  return argv;
}
