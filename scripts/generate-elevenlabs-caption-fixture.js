#!/usr/bin/env node
import dotenv from 'dotenv';
import { spawn } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

dotenv.config();

const API_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const DEFAULT_TEXT = 'Hello from FinalCap. This is a caption test for video editing.';
const DEFAULT_OUT_DIR = 'src/test/fixtures';
const DEFAULT_BASENAME = 'elevenlabs-caption-test';

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

async function ensureFfmpeg() {
  try {
    await run('ffmpeg', ['-version']);
  } catch {
    throw new Error('ffmpeg is required to mux the generated TTS audio into an MP4 fixture.');
  }
}

async function generateSpeech({ apiKey, voiceId, modelId, text }) {
  const url = `${API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed: HTTP ${response.status}${body ? `\n${body}` : ''}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function muxAudioToVideo({ audioPath, videoPath, duration }) {
  await run('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=0x141414:s=320x240:d=${duration}:r=25`,
    '-i', audioPath,
    '-shortest',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    videoPath,
  ]);
}

async function main() {
  if (hasFlag('help')) {
    console.log(`Usage: npm run fixture:elevenlabs-caption -- [options]

Options:
  --text="..."        Text to synthesize.
  --voice-id=...      ElevenLabs voice ID. Default: ${DEFAULT_VOICE_ID}
  --model-id=...      ElevenLabs model ID. Default: ${DEFAULT_MODEL_ID}
  --out-dir=...       Output directory. Default: ${DEFAULT_OUT_DIR}
  --basename=...      Output file basename. Default: ${DEFAULT_BASENAME}
  --duration=...      Video duration in seconds. Default: 6
  --check-env         Verify ELEVENLABS_API_KEY and ffmpeg without generating files.

Requires ELEVENLABS_API_KEY in .env.`);
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('Missing ELEVENLABS_API_KEY. Add it to .env before running this script.');
  }

  if (hasFlag('check-env')) {
    await ensureFfmpeg();
    console.log('ELEVENLABS_API_KEY and ffmpeg are available.');
    return;
  }

  const text = getArg('text', DEFAULT_TEXT);
  const voiceId = getArg('voice-id', DEFAULT_VOICE_ID);
  const modelId = getArg('model-id', DEFAULT_MODEL_ID);
  const outDir = getArg('out-dir', DEFAULT_OUT_DIR);
  const basename = getArg('basename', DEFAULT_BASENAME);
  const duration = Number(getArg('duration', '6'));

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('--duration must be a positive number of seconds.');
  }

  await ensureFfmpeg();
  await mkdir(outDir, { recursive: true });

  const audioPath = path.join(outDir, `${basename}.mp3`);
  const videoPath = path.join(outDir, `${basename}.mp4`);
  const textPath = path.join(outDir, `${basename}.txt`);

  console.log(`Generating TTS with ElevenLabs voice ${voiceId}...`);
  const audio = await generateSpeech({ apiKey, voiceId, modelId, text });
  await writeFile(audioPath, audio);
  await writeFile(textPath, `${text}\n`);

  console.log(`Muxing ${audioPath} into ${videoPath}...`);
  await muxAudioToVideo({ audioPath, videoPath, duration });

  console.log('Wrote caption fixture artifacts:');
  console.log(`- ${audioPath}`);
  console.log(`- ${videoPath}`);
  console.log(`- ${textPath}`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
