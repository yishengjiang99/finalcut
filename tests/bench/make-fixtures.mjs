#!/usr/bin/env node
// Generates the wasm bench fixtures with a native ffmpeg (lavfi sources only; nothing is
// downloaded except the DejaVu font on hosts that lack it). Output goes to tests/fixtures/bench/ (gitignored: these are tens of MB).
//   node tests/bench/make-fixtures.mjs [--force]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bench');
const FORCE = process.argv.includes('--force');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
mkdirSync(OUT, { recursive: true });

const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
function make(name, args) {
  const file = path.join(OUT, name);
  if (existsSync(file) && !FORCE) return console.log(`keep ${name}`);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file], { stdio: 'inherit' });
  console.log(`made ${name}`);
}
const src = (size, rate, secs, freq) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${secs}`];

// 1080p30, 60 s, H.264 + AAC: trim (stream copy), re-encode, loudnorm, thumbnail, ffprobe.
make('src-1080p-60s.mp4', [...src('1920x1080', 30, 60, 440), ...h264, '-b:v', '6M']);
// Three 720p 5 s clips for the xfade join.
for (const [i, f] of [[1, 330], [2, 440], [3, 550]]) make(`clip${i}-720p-5s.mp4`, [...src('1280x720', 30, 5, f), ...h264]);
// 720p 10 s clip for the subtitle burn.
make('src-720p-10s.mp4', [...src('1280x720', 30, 10, 440), ...h264]);
// Tiny clip for the 60-run soak.
make('soak-240p-2s.mp4', [...src('320x240', 30, 2, 440), ...h264]);

writeFileSync(path.join(OUT, 'subs.ass'), `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Default,DejaVu Sans,48,&H00FFFFFF,&H00000000,&H00000000,0,0,1,2,0,2,20,20,40

[Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,0:00:00.00,0:00:03.00,Default,First line of the bench subtitles
Dialogue: 0,0:00:03.00,0:00:06.50,Default,{\\b1}Second{\\b0} line, bold word
Dialogue: 0,0:00:06.50,0:00:10.00,Default,Third line: 50% [ok]; done
`);
// DejaVu Sans 2.37: the system copy on Debian/Ubuntu, otherwise (macOS) the upstream release
// tarball, checksum-pinned, so every host burns the same glyphs.
const fontOut = path.join(OUT, 'DejaVuSans.ttf');
const font = process.env.BENCH_FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
if (existsSync(font)) copyFileSync(font, fontOut);
else if (process.env.BENCH_FONT) throw new Error(`font not found: ${font}`);
else if (!existsSync(fontOut) || FORCE) {
  const url = 'https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2';
  const sha = 'fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7';
  const tmp = mkdtempSync(path.join(tmpdir(), 'dejavu-'));
  const tar = path.join(tmp, 'dejavu.tar.bz2');
  execFileSync('curl', ['-sSfL', '-o', tar, url], { stdio: 'inherit' });
  const got = createHash('sha256').update(readFileSync(tar)).digest('hex');
  if (got !== sha) throw new Error(`DejaVu tarball checksum mismatch: ${got}`);
  execFileSync('tar', ['xjf', tar, '-C', tmp, '--strip-components=2', 'dejavu-fonts-ttf-2.37/ttf/DejaVuSans.ttf']);
  copyFileSync(path.join(tmp, 'DejaVuSans.ttf'), fontOut);
  rmSync(tmp, { recursive: true, force: true });
  console.log('made DejaVuSans.ttf (downloaded)');
}
console.log(`fixtures in ${OUT}`);
