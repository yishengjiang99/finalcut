import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import { OPENAI_API_KEY, XAI_API_TOKEN, TMP_DIR } from './config.js';
import {
  apiLimiter,
  videoProcessLimiter,
  requireAuthenticatedUser,
  requireInferenceAccess,
} from './middleware.js';
import {
  getExtFromMimeType,
  srtToVtt,
  secondsToTimestamp,
  buildSrtAndVtt,
} from './utils.js';
import { sniffMediaFormat } from './mediaType.js';
import {
  normalizeLanguageCode,
  mergeTranslatedSrt,
  srtHasSpeech,
  stripLlmFences,
} from './captionHelpers.js';

// ── Batch Audio Transcription Helpers ─────────────────────────────────────────
// NOTE: Speaker diarization requires the batch POST /v1/audio/transcriptions endpoint.
// The OpenAI Realtime API (wss://api.openai.com/v1/realtime) does NOT support
// diarization or segment-level speaker labels as of early 2026. Only the batch
// HTTP endpoint with response_format:"diarized_json" provides per-segment speaker IDs.

/**
 * Extract audio from a video/audio file as mono WAV at 16 kHz.
 * 16 kHz is the preferred sample rate for OpenAI Whisper-family transcription models.
 */
export async function extractAudioToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .noVideo()
      .toFormat('wav')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

// Max audio file size accepted by OpenAI Audio API (25 MB)
export const OPENAI_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
// Target chunk duration for splitting (12 minutes → ~23 MB at 16 kHz mono 16-bit)
export const CHUNK_DURATION_SEC = 12 * 60;

/**
 * Split a WAV file into ≤25 MB segments if it exceeds the API size limit.
 * Returns an array of { path: string, startSec: number } objects.
 * The caller is responsible for deleting the returned chunk files.
 */
export async function splitAudioIfNeeded(wavPath) {
  const stat = await fs.stat(wavPath);
  if (stat.size <= OPENAI_MAX_AUDIO_BYTES) {
    return [{ path: wavPath, startSec: 0 }];
  }

  console.log(`[diarize] WAV is ${(stat.size / 1024 / 1024).toFixed(1)} MB — splitting into ${CHUNK_DURATION_SEC}s chunks`);

  const duration = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(wavPath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta.format.duration || 0);
    });
  });

  const chunks = [];
  let startSec = 0;
  while (startSec < duration) {
    const chunkPath = path.join(TMP_DIR, `chunk-${randomUUID()}.wav`);
    await new Promise((resolve, reject) => {
      ffmpeg(wavPath)
        .setStartTime(startSec)
        .setDuration(CHUNK_DURATION_SEC)
        .audioCodec('copy')
        .on('end', resolve)
        .on('error', reject)
        .save(chunkPath);
    });
    chunks.push({ path: chunkPath, startSec });
    startSec += CHUNK_DURATION_SEC;
  }

  console.log(`[diarize] Split into ${chunks.length} chunks`);
  return chunks;
}

/**
 * POST a single audio file to POST https://api.openai.com/v1/audio/transcriptions.
 * Falls back through models on 403/model-not-found errors only.
 *
 * Model fallback order:
 *   gpt-4o-transcribe-diarize  (response_format: diarized_json — full speaker diarization)
 *   gpt-4o-transcribe          (response_format: verbose_json  — timestamps, no speaker)
 *   gpt-4o-mini-transcribe     (response_format: verbose_json)
 *   whisper-1                  (response_format: verbose_json)
 *
 * Returns normalized segments: Array<{ start, end, speaker, text }>
 * (start/end in seconds; speaker may be null for non-diarizing models)
 */
export async function transcribeWithOpenAI(filePath, timestampOffsetSec = 0, languageCode = null, { preferDiarization = false } = {}) {
  // Caption generate: prefer reliable timestamp models first (diarize model is slower / often unavailable).
  // Diarized endpoint: try diarize model first, then fall back.
  const MODELS = preferDiarization
    ? [
        { model: 'gpt-4o-transcribe-diarize', format: 'diarized_json' },
        { model: 'gpt-4o-transcribe',         format: 'verbose_json'  },
        { model: 'gpt-4o-mini-transcribe',    format: 'verbose_json'  },
        { model: 'whisper-1',                 format: 'verbose_json'  },
      ]
    : [
        { model: 'gpt-4o-transcribe',         format: 'verbose_json'  },
        { model: 'whisper-1',                 format: 'verbose_json'  },
        { model: 'gpt-4o-mini-transcribe',    format: 'verbose_json'  },
      ];

  let lastError;
  for (const { model, format } of MODELS) {
    const form = new FormData();
    form.append('file', await fs.readFile(filePath), {
      filename: path.basename(filePath),
      contentType: 'audio/wav',
    });
    form.append('model', model);
    form.append('response_format', format);
    if (languageCode) {
      form.append('language', languageCode);
    }
    // timestamp_granularities[] is only valid for verbose_json
    if (format === 'verbose_json') {
      form.append('timestamp_granularities[]', 'segment');
    }

    try {
      console.log(`[diarize] POST /v1/audio/transcriptions model=${model} format=${format} offset=${timestampOffsetSec}s`);
      const resp = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        form,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            ...form.getHeaders(),
          },
          timeout: 300_000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
      );

      const data = resp.data;
      console.log(`[diarize] Response model=${model}: ${JSON.stringify(data).slice(0, 200)}`);
      const rawSegments = Array.isArray(data.segments) ? data.segments : [];

      if (rawSegments.length) {
        return rawSegments.map(seg => ({
          start:   (seg.start ?? 0) + timestampOffsetSec,
          end:     (seg.end   ?? 0) + timestampOffsetSec,
          // diarized_json provides seg.speaker ("1", "2"…); verbose_json does not
          speaker: seg.speaker ? `Speaker ${seg.speaker}` : null,
          text:    (seg.text || '').trim(),
        }));
      }

      // Last-resort: no segments array — treat full response as one block
      const totalDurationSec = data.duration ?? 0;
      return [{
        start:   timestampOffsetSec,
        end:     timestampOffsetSec + totalDurationSec,
        speaker: null,
        text:    (data.text || '').trim(),
      }];
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const errMsg = err.response?.data?.error?.message || err.message || '';
      console.error(`[diarize] model=${model} failed: HTTP ${status} — ${errMsg}`);
      // Fall back on auth / model / format issues; propagate hard failures (timeouts, 5xx after last try)
      if (
        status === 403 || status === 404 || status === 400
        || /not found|unsupported|invalid model|model_not_found|invalid.*format|response_format/i.test(errMsg)
      ) {
        console.warn(`[diarize] Falling back from ${model}: ${errMsg}`);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Merge segment arrays from multiple transcribed chunks into a single sorted list.
 */
export function mergeDiarizedSegmentsWithOffsets(chunksResults) {
  return chunksResults
    .flat()
    .filter(seg => seg.text)
    .sort((a, b) => a.start - b.start);
}

/**
 * Embed an SRT subtitle file into a video as a soft subtitle track using ffmpeg.
 * Copies video and audio streams without re-encoding; encodes subtitle stream as mov_text for MP4.
 */
export async function burnSubtitlesIntoVideo(inputPath, srtPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .input(srtPath)
      .outputOptions([
        '-c copy',
        '-c:s mov_text'
      ])
      .on('start', (commandLine) => {
        console.log('Spawned FFmpeg with command: ' + commandLine);
      })
      .on('error', (err) => {
        console.error('An error occurred: ' + err.message);
        reject(err);
      })
      .on('end', () => {
        console.log('Merging finished !');
        resolve();
      })
      .save(outputPath);
  });
}

const router = express.Router();

// Caption generation endpoint: extract audio from video and transcribe via OpenAI batch API
router.post('/api/generate-captions', videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess, async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OPENAI_API_KEY is not configured. Caption generation is unavailable.' });
  }

  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const fileContentType = contentType.split(';')[0].trim() || 'video/mp4';
  const argsStr = req.headers['x-args'];

  let parsedArgs = {};
  try {
    parsedArgs = argsStr ? JSON.parse(argsStr) : {};
  } catch (e) {
    return res.status(400).json({ error: 'Invalid x-args header: must be valid JSON' });
  }

  const language = normalizeLanguageCode(parsedArgs.language || 'auto', { allowAuto: true });
  if (!language) {
    return res.status(400).json({
      error: 'language must be "auto" or a language code/name (e.g., "en", "es", "English", "zh")',
    });
  }
  const tmpFiles = [];
  const track = (p) => { tmpFiles.push(p); return p; };

  try {
    // Read video from request body
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const inputBuffer = Buffer.concat(chunks);

    if (!inputBuffer.length) {
      return res.status(400).json({ error: 'No video data received' });
    }
    const sniffedFormat = sniffMediaFormat(inputBuffer);
    if ((sniffedFormat && sniffedFormat !== 'video') || fileContentType.startsWith('image/')) {
      return res.status(400).json({ error: 'Captions are not supported for photos' });
    }

    const ext = getExtFromMimeType(fileContentType);
    const tmpInputPath = track(path.join(TMP_DIR, `input-${randomUUID()}.${ext}`));
    await fs.writeFile(tmpInputPath, inputBuffer);

    // Extract mono 16 kHz WAV (preferred by OpenAI transcription models)
    const tmpWavPath = track(path.join(TMP_DIR, `audio-${randomUUID()}.wav`));
    await extractAudioToWav(tmpInputPath, tmpWavPath);

    // Split into API-safe chunks if needed
    const audioChunks = await splitAudioIfNeeded(tmpWavPath);
    for (const c of audioChunks) {
      if (c.path !== tmpWavPath) track(c.path);
    }

    // Transcribe via OpenAI batch audio transcriptions endpoint
    const chunkSegments = await Promise.all(
      audioChunks.map(c => transcribeWithOpenAI(
        c.path,
        c.startSec,
        language === 'auto' ? null : language,
        { preferDiarization: false }
      ))
    );
    const segments = mergeDiarizedSegmentsWithOffsets(chunkSegments);
    const { srt: srtContent, vtt: vttContent } = buildSrtAndVtt(segments);

    if (!srtHasSpeech(srtContent)) {
      return res.status(422).json({
        error: 'No speech detected in the audio. Try a clip with clearer dialogue, or set language explicitly (e.g. "en").',
      });
    }

    res.json({ srt: srtContent, vtt: vttContent, language });
  } catch (error) {
    console.error('Error generating captions:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message || 'Failed to generate captions' });
  } finally {
    for (const p of tmpFiles) {
      await fs.unlink(p).catch(() => {});
    }
  }
});

// Diarized caption generation endpoint.
// Uses the OpenAI batch POST /v1/audio/transcriptions for true speaker diarization.
// The Realtime WSS API does NOT support diarization; only the batch endpoint with
// response_format:"diarized_json" provides per-segment speaker IDs.
router.post('/api/generate-captions-diarized', videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess, async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OPENAI_API_KEY is not configured. Speaker diarization is unavailable.' });
  }

  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const fileContentType = contentType.split(';')[0].trim() || 'video/mp4';
  const argsStr = req.headers['x-args'];

  let parsedArgs = {};
  try {
    parsedArgs = argsStr ? JSON.parse(argsStr) : {};
  } catch (e) {
    return res.status(400).json({ error: 'Invalid x-args header: must be valid JSON' });
  }

  const burnSubtitles = parsedArgs.burnSubtitles === true;
  const language = normalizeLanguageCode(parsedArgs.language || 'auto', { allowAuto: true });
  if (!language) {
    return res.status(400).json({
      error: 'language must be "auto" or a language code/name (e.g., "en", "es", "English")',
    });
  }
  const tmpFiles = [];
  const track = (p) => { tmpFiles.push(p); return p; };

  try {
    // Read video/audio from request body
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const inputBuffer = Buffer.concat(chunks);

    if (!inputBuffer.length) {
      return res.status(400).json({ error: 'No video/audio data received' });
    }
    const sniffedFormat = sniffMediaFormat(inputBuffer);
    if ((sniffedFormat && sniffedFormat !== 'video') || fileContentType.startsWith('image/')) {
      return res.status(400).json({ error: 'Captions are not supported for photos' });
    }

    const ext = getExtFromMimeType(fileContentType);
    const tmpInputPath = track(path.join(TMP_DIR, `input-${randomUUID()}.${ext}`));
    await fs.writeFile(tmpInputPath, inputBuffer);

    // Step 1: Extract mono 16 kHz WAV (preferred by OpenAI Whisper-family models)
    const tmpWavPath = track(path.join(TMP_DIR, `audio-${randomUUID()}.wav`));
    await extractAudioToWav(tmpInputPath, tmpWavPath);
    const wavStat = await fs.stat(tmpWavPath);
    console.log(`[diarize] WAV extracted: ${(wavStat.size / 1024).toFixed(0)} KB`);

    // Step 2: Split into <25 MB chunks if the file is too large for the API
    const audioChunks = await splitAudioIfNeeded(tmpWavPath);
    for (const c of audioChunks) {
      if (c.path !== tmpWavPath) track(c.path);
    }

    // Step 3: Transcribe each chunk via the batch API (with per-chunk timestamp offset)
    const chunkSegments = await Promise.all(
      audioChunks.map(c => transcribeWithOpenAI(
        c.path,
        c.startSec,
        language === 'auto' ? null : language,
        { preferDiarization: true }
      ))
    );
    console.log(`[diarize] Transcribed ${audioChunks.length} chunk(s)`);

    // Step 4: Merge and sort all segments
    const segments = mergeDiarizedSegmentsWithOffsets(chunkSegments);
    const hasDiarization = segments.some(s => s.speaker);
    console.log(`[diarize] ${segments.length} segments total, diarization=${hasDiarization}`);

    // Step 5: Build SRT + VTT
    const { srt: srtContent, vtt: vttContent } = buildSrtAndVtt(segments);

    if (burnSubtitles) {
      const tmpSrtPath    = track(path.join(TMP_DIR, `subtitles-${randomUUID()}.srt`));
      const tmpOutputPath = track(path.join(TMP_DIR, `output-${randomUUID()}.mp4`));
      await fs.writeFile(tmpSrtPath, srtContent, 'utf8');
      await burnSubtitlesIntoVideo(tmpInputPath, tmpSrtPath, tmpOutputPath);
      const outputBuffer = await fs.readFile(tmpOutputPath);
      res.set('Content-Type', 'video/mp4');
      res.set('X-Srt-Content', Buffer.from(srtContent).toString('base64'));
      res.set('X-Vtt-Content', Buffer.from(vttContent).toString('base64'));
      res.send(outputBuffer);
    } else {
      res.json({ srt: srtContent, vtt: vttContent });
    }
  } catch (error) {
    console.error('Error generating diarized captions:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message || 'Failed to generate diarized captions' });
  } finally {
    for (const p of tmpFiles) {
      await fs.unlink(p).catch(() => {});
    }
  }
});

// Caption translation endpoint: translate SRT content to another language via Grok chat
router.post('/api/translate-captions', apiLimiter, requireAuthenticatedUser, requireInferenceAccess, async (req, res) => {
  // express.json() is mounted globally — prefer req.body; only fall back to raw stream if empty.
  let parsed = req.body;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) {
    let body = '';
    for await (const chunk of req) { body += chunk; }
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: 'Request body must be valid JSON' });
    }
  }

  const { srtContent, targetLanguage } = parsed;

  if (!srtContent || typeof srtContent !== 'string' || !srtContent.trim()) {
    return res.status(400).json({ error: 'srtContent is required' });
  }
  if (!targetLanguage || typeof targetLanguage !== 'string' || !targetLanguage.trim()) {
    return res.status(400).json({ error: 'targetLanguage is required' });
  }

  const normalizedTarget = normalizeLanguageCode(targetLanguage, { allowAuto: false });
  if (!normalizedTarget) {
    return res.status(400).json({
      error: 'targetLanguage must be a language code/name (e.g., "es", "fr", "Spanish", "zh")',
    });
  }

  if (!XAI_API_TOKEN) {
    return res.status(503).json({ error: 'XAI_API_TOKEN is not configured. Caption translation is unavailable.' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const xaiResponse = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_TOKEN}`
      },
      body: JSON.stringify({
        model: 'grok-3',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You are a professional subtitle translator. Translate ONLY the dialogue text lines of the given SRT. '
              + 'Preserve every sequence number and timestamp line EXACTLY (including "-->" and commas). '
              + 'Output ONLY valid SRT. No markdown fences, no commentary.',
          },
          {
            role: 'user',
            content:
              `Translate the dialogue lines to language code "${normalizedTarget}". `
              + `Keep timestamps identical.\n\n${srtContent}`,
          }
        ]
      })
    }).finally(() => clearTimeout(timeout));

    if (!xaiResponse.ok) {
      const errBody = await xaiResponse.json().catch(() => ({}));
      throw new Error(`xAI API error: ${errBody.error?.message || xaiResponse.statusText}`);
    }

    const xaiData = await xaiResponse.json();
    const rawTranslated = xaiData.choices?.[0]?.message?.content?.trim() || '';

    if (!rawTranslated) {
      throw new Error('No translation received from xAI API');
    }

    // Lock original timestamps — models often mangle SRT timing lines
    const translatedSrt = mergeTranslatedSrt(srtContent, stripLlmFences(rawTranslated));
    const translatedVtt = srtToVtt(translatedSrt);
    res.json({ srt: translatedSrt, vtt: translatedVtt, targetLanguage: normalizedTarget });
  } catch (error) {
    console.error('Error translating captions:', error);
    if (!res.headersSent) {
      const timedOut = error?.name === 'AbortError';
      res.status(timedOut ? 504 : 500).json({
        error: timedOut ? 'Caption translation timed out' : (error.message || 'Failed to translate captions'),
      });
    }
  }
});

export { router as captionsRouter };
