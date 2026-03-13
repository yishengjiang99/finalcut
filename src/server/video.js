import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { TMP_DIR, IS_PRODUCTION } from './config.js';
import {
  videoProcessLimiter,
  requireAuthenticatedUser,
  requireActiveSubscription,
  upload,
} from './middleware.js';
import { getMimeTypeToFormat, getExtFromMimeType, parseAudioInput } from './utils.js';

// Helper function to check if a video has audio stream
export async function checkHasAudioStream(inputPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        // If ffprobe fails, assume no audio
        resolve(false);
        return;
      }

      // Check if there's any audio stream
      const hasAudio = metadata.streams && metadata.streams.some(stream => stream.codec_type === 'audio');
      resolve(hasAudio);
    });
  });
}

// Helper function to build crossfade filter
export function buildCrossfadeFilter(numVideos, duration, hasAudio, transition = 'fade') {
  if (numVideos < 2) {
    throw new Error('At least 2 videos required for crossfade');
  }

  let filters = [];
  let audioFilters = [];

  // Simple concatenation approach
  // For proper crossfade with xfade filter, we would need video durations
  // This implementation uses basic concat which is simpler and more reliable

  // Check if any video has audio
  const anyHasAudio = hasAudio.some(h => h);

  if (anyHasAudio) {
    // If some videos have audio and some don't, add silent audio to those without
    const allHasAudio = hasAudio.every(h => h);

    if (!allHasAudio) {
      // Generate silent audio for videos without audio
      for (let i = 0; i < numVideos; i++) {
        if (!hasAudio[i]) {
          // Add silent audio track
          filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100[silent${i}]`);
        }
      }
    }

    // Build video concat
    let videoInputs = Array.from({length: numVideos}, (_, i) => `[${i}:v]`).join('');
    filters.push(`${videoInputs}concat=n=${numVideos}:v=1:a=0[v]`);

    // Build audio concat with proper audio sources
    let audioInputs = Array.from({length: numVideos}, (_, i) => {
      return hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
    }).join('');
    audioFilters.push(`${audioInputs}concat=n=${numVideos}:v=0:a=1[a]`);
  } else {
    // No videos have audio - only concat video streams
    let videoInputs = Array.from({length: numVideos}, (_, i) => `[${i}:v]`).join('');
    filters.push(`${videoInputs}concat=n=${numVideos}:v=1:a=0[v]`);
  }

  return [...filters, ...audioFilters].join(';');
}

// Helper function to build wipe/slide filter
export function buildWipeFilter(numVideos, duration, transition, hasAudio) {
  if (numVideos < 2) {
    throw new Error('At least 2 videos required for wipe transition');
  }

  // Simple concatenation - for actual wipe effects, we would need xfade filter with offsets
  let filters = [];
  let audioFilters = [];

  // Check if any video has audio
  const anyHasAudio = hasAudio.some(h => h);

  if (anyHasAudio) {
    // If some videos have audio and some don't, add silent audio to those without
    const allHasAudio = hasAudio.every(h => h);

    if (!allHasAudio) {
      // Generate silent audio for videos without audio
      for (let i = 0; i < numVideos; i++) {
        if (!hasAudio[i]) {
          // Add silent audio track
          filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100[silent${i}]`);
        }
      }
    }

    // Build video concat
    let videoInputs = Array.from({length: numVideos}, (_, i) => `[${i}:v]`).join('');
    filters.push(`${videoInputs}concat=n=${numVideos}:v=1:a=0[v]`);

    // Build audio concat with proper audio sources
    let audioInputs = Array.from({length: numVideos}, (_, i) => {
      return hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
    }).join('');
    audioFilters.push(`${audioInputs}concat=n=${numVideos}:v=0:a=1[a]`);
  } else {
    // No videos have audio - only concat video streams
    let videoInputs = Array.from({length: numVideos}, (_, i) => `[${i}:v]`).join('');
    filters.push(`${videoInputs}concat=n=${numVideos}:v=1:a=0[v]`);
  }

  return [...filters, ...audioFilters].join(';');
}

// Helper function to build fade to black filter
export function buildFadeFilter(numVideos, duration, hasAudio) {
  if (numVideos < 2) {
    throw new Error('At least 2 videos required for fade transition');
  }

  let filters = [];
  let audioFilters = [];

  // Apply fade in to first video and fade out to last video
  // For middle videos, we'll just concatenate normally
  // Note: For proper timing, we would need to get video durations via ffprobe first
  let videoLabels = [];
  let audioLabels = [];

  // Check if any video has audio
  const anyHasAudio = hasAudio.some(h => h);

  // If some videos have audio and some don't, add silent audio to those without
  if (anyHasAudio && !hasAudio.every(h => h)) {
    for (let i = 0; i < numVideos; i++) {
      if (!hasAudio[i]) {
        filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100[silent${i}]`);
      }
    }
  }

  for (let i = 0; i < numVideos; i++) {
    const vLabel = `v${i}fade`;
    const aLabel = `a${i}fade`;

    if (i === 0 && numVideos === 2) {
      // First video in a 2-video sequence: only fade out
      // We'll skip the fade for simplicity since we don't know duration
      filters.push(`[${i}:v]copy[${vLabel}]`);
      if (anyHasAudio) {
        const audioSource = hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
        audioFilters.push(`${audioSource}acopy[${aLabel}]`);
      }
    } else if (i === 0) {
      // First video: no fade needed at start, just copy
      filters.push(`[${i}:v]copy[${vLabel}]`);
      if (anyHasAudio) {
        const audioSource = hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
        audioFilters.push(`${audioSource}acopy[${aLabel}]`);
      }
    } else if (i === numVideos - 1) {
      // Last video: fade in at start
      filters.push(`[${i}:v]fade=t=in:st=0:d=${duration}[${vLabel}]`);
      if (anyHasAudio) {
        const audioSource = hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
        audioFilters.push(`${audioSource}afade=t=in:st=0:d=${duration}[${aLabel}]`);
      }
    } else {
      // Middle videos: fade in at start
      filters.push(`[${i}:v]fade=t=in:st=0:d=${duration}[${vLabel}]`);
      if (anyHasAudio) {
        const audioSource = hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
        audioFilters.push(`${audioSource}afade=t=in:st=0:d=${duration}[${aLabel}]`);
      }
    }

    videoLabels.push(`[${vLabel}]`);
    if (anyHasAudio) {
      audioLabels.push(`[${aLabel}]`);
    }
  }

  filters.push(`${videoLabels.join('')}concat=n=${numVideos}:v=1:a=0[v]`);
  if (anyHasAudio) {
    audioFilters.push(`${audioLabels.join('')}concat=n=${numVideos}:v=0:a=1[a]`);
  }

  return [...filters, ...audioFilters].join(';');
}

const router = express.Router();

// Video processing endpoint
// Client posts video as a raw body stream; operation, args, and file type are in request headers.
// For add_audio_track and burn_subtitles (which require secondary inputs), FormData/multipart is used.
router.post('/api/process-video', videoProcessLimiter, requireAuthenticatedUser, requireActiveSubscription, async (req, res) => {
  const contentType = (req.headers['content-type'] || '').toLowerCase();

  // FormData path: for add_audio_track and burn_subtitles
  if (contentType.includes('multipart/form-data')) {
    let multerError = null;
    await new Promise((resolve) => {
      upload.single('video')(req, res, (err) => { multerError = err || null; resolve(); });
    });
    if (multerError) return res.status(400).json({ error: multerError.message });
    if (!req.file) return res.status(400).json({ error: 'No video file provided' });

    const { operation, args } = req.body;
    if (!operation) return res.status(400).json({ error: 'No operation specified' });
    if (operation !== 'add_audio_track' && operation !== 'burn_subtitles') {
      return res.status(400).json({ error: 'Use streaming request (video body + x-operation header) for this operation' });
    }

    const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;

    if (operation === 'burn_subtitles') {
      const { srtContent, translatedSrtContent, style = 'default', position = 'bottom' } = parsedArgs;
      if (!srtContent || typeof srtContent !== 'string' || !srtContent.trim()) {
        return res.status(400).json({ error: 'srtContent is required for burn_subtitles' });
      }
      const validStyles = ['default', 'white_on_black', 'yellow'];
      const validPositions = ['bottom', 'top'];
      if (!validStyles.includes(style)) {
        return res.status(400).json({ error: `style must be one of: ${validStyles.join(', ')}` });
      }
      if (!validPositions.includes(position)) {
        return res.status(400).json({ error: `position must be one of: ${validPositions.join(', ')}` });
      }

      const hasTranslation = typeof translatedSrtContent === 'string' && translatedSrtContent.trim().length > 0;

      let inputPath = null;
      let srtPath = null;
      let translatedSrtPath = null;
      try {
        const tmpDir = TMP_DIR;
        inputPath = path.join(tmpDir, `input-${randomUUID()}.mp4`);
        await fs.writeFile(inputPath, req.file.buffer);

        srtPath = path.join(tmpDir, `subtitles-${randomUUID()}.srt`);
        await fs.writeFile(srtPath, srtContent, 'utf8');

        // Build ASS/SSA style override string.
        // ASS colour format: &HAABBGGRR (AA=alpha 00=opaque 80=semi-transparent, BB=blue, GG=green, RR=red)
        // ASS Alignment values: 2=bottom-center, 8=top-center (numpad layout)
        const ASS_ALIGN_BOTTOM = 2;
        const ASS_ALIGN_TOP = 8;
        const alignment = position === 'top' ? ASS_ALIGN_TOP : ASS_ALIGN_BOTTOM;
        let forceStyle = `FontSize=20,Alignment=${alignment}`;
        if (style === 'white_on_black') {
          // White text (&H00FFFFFF) on semi-transparent black background (&H80000000, alpha=0x80)
          forceStyle += ',PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=4,Outline=0,Shadow=0';
        } else if (style === 'yellow') {
          // Yellow text (&H0000FFFF = BGR yellow) with black outline
          forceStyle += ',PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,Bold=1';
        } else {
          // Default: white text with black outline
          forceStyle += ',PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Bold=0';
        }

        // Forward-slash path for FFmpeg's subtitles filter (runs on Linux; UUID has no special chars).
        // Escape backslashes first, then single quotes for safe embedding in the filter string.
        const escapedSrtPath = srtPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

        // Build the video filter chain: if a translated track is provided, chain two subtitle filters
        let videoFilter;
        if (hasTranslation) {
          translatedSrtPath = path.join(tmpDir, `translated-${randomUUID()}.srt`);
          await fs.writeFile(translatedSrtPath, translatedSrtContent, 'utf8');

          // Translated track is placed at the opposite end of the video
          const translatedAlignment = position === 'top' ? ASS_ALIGN_BOTTOM : ASS_ALIGN_TOP;
          let translatedForceStyle = `FontSize=18,Alignment=${translatedAlignment}`;
          if (style === 'white_on_black') {
            translatedForceStyle += ',PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=4,Outline=0,Shadow=0';
          } else if (style === 'yellow') {
            translatedForceStyle += ',PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,Bold=1';
          } else {
            translatedForceStyle += ',PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Bold=0';
          }

          const escapedTranslatedSrtPath = translatedSrtPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          // Chain both subtitle filters: first burn primary, then burn translation on top
          videoFilter = `subtitles=filename='${escapedSrtPath}':force_style='${forceStyle}',subtitles=filename='${escapedTranslatedSrtPath}':force_style='${translatedForceStyle}'`;
        } else {
          videoFilter = `subtitles=filename='${escapedSrtPath}':force_style='${forceStyle}'`;
        }

        const outputChunks = await new Promise((resolve, reject) => {
          const ffmpegLoglevel = IS_PRODUCTION ? 'error' : 'debug';
          const ffmpegStderr = [];
          const chunks = [];
          const command = ffmpeg(inputPath)
            .videoFilters(videoFilter)
            // Subtitle burn-in requires video re-encode; use explicit MP4-compatible codecs.
            .outputOptions([
              `-loglevel ${ffmpegLoglevel}`,
              '-map 0:v:0',
              '-map 0:a?',
              '-c:v libx264',
              '-pix_fmt yuv420p',
              '-c:a aac',
              '-movflags frag_keyframe+empty_moov+default_base_moof'
            ])
            .toFormat('mp4')
            .on('start', (commandLine) => {
              if (!IS_PRODUCTION) {
                console.error('FFmpeg command (burn_subtitles):', commandLine);
              }
            })
            .on('stderr', (line) => {
              ffmpegStderr.push(line);
              if (!IS_PRODUCTION) {
                console.error('FFmpeg stderr (burn_subtitles):', line);
              }
            })
            .on('error', (err, stdout, stderr) => {
              if (stdout) console.error('FFmpeg stdout (burn_subtitles):', stdout);
              if (stderr) console.error('FFmpeg stderr blob (burn_subtitles):', stderr);
              if (!err.ffmpegStderr && ffmpegStderr.length) {
                err.ffmpegStderr = ffmpegStderr.join('\n');
              }
              reject(err);
            })
            .on('end', () => resolve(chunks));

          const ffmpegStream = command.pipe();
          ffmpegStream.on('data', (chunk) => { chunks.push(chunk); });
          ffmpegStream.on('error', reject);
        });

        const outputBuffer = Buffer.concat(outputChunks);
        res.set('Content-Type', 'video/mp4');
        res.send(outputBuffer);
      } catch (error) {
        console.error('FFmpeg error (burn_subtitles):', error);
        const ffmpegStderr = typeof error?.ffmpegStderr === 'string' ? error.ffmpegStderr : '';
        if (ffmpegStderr.includes("No such filter: 'subtitles'")) {
          if (!res.headersSent) {
            res.status(500).json({
              error: 'FFmpeg subtitles filter is unavailable (missing libass support). Install an FFmpeg build with libass enabled to burn subtitles.'
            });
          }
        } else if (!res.headersSent) {
          res.status(500).json({ error: error.message || 'Failed to burn subtitles' });
        }
      } finally {
        [inputPath, srtPath, translatedSrtPath].forEach(p => p && fs.unlink(p).catch(() => {}));
      }
      return;
    }

    // add_audio_track path
    let inputPath = null;
    let audioInputPath = null;
    try {
      const tmpDir = TMP_DIR;
      inputPath = path.join(tmpDir, `input-${randomUUID()}.mp4`);
      await fs.writeFile(inputPath, req.file.buffer);

      const parsedAudio = parseAudioInput(parsedArgs.audioFile);
      audioInputPath = path.join(tmpDir, `audio-${randomUUID()}.${parsedAudio.extension}`);
      await fs.writeFile(audioInputPath, parsedAudio.buffer);

      const sourceHasAudio = await checkHasAudioStream(inputPath);
      const mode = parsedArgs.mode || 'replace';
      const volume = parsedArgs.volume ?? 1.0;
      if (mode !== 'replace' && mode !== 'mix') {
        return res.status(400).json({ error: 'Mode must be either "replace" or "mix"' });
      }
      if (typeof volume !== 'number' || Number.isNaN(volume) || volume < 0 || volume > 2) {
        return res.status(400).json({ error: 'Volume must be between 0.0 and 2.0' });
      }

      let command = ffmpeg(inputPath).input(audioInputPath);
      if (mode === 'mix' && sourceHasAudio) {
        command = command
          .complexFilter([
            `[1:a]volume=${volume}[newaudio]`,
            '[0:a][newaudio]amix=inputs=2:duration=first:dropout_transition=2[mixedaudio]'
          ], ['mixedaudio'])
          .outputOptions(['-map 0:v:0', '-map [mixedaudio]', '-c:v copy', '-c:a aac', '-shortest']);
      } else {
        command = command
          .complexFilter([`[1:a]volume=${volume}[newaudio]`], ['newaudio'])
          .outputOptions(['-map 0:v:0', '-map [newaudio]', '-c:v copy', '-c:a aac', '-shortest']);
      }
      res.set('Content-Type', 'video/mp4');
      command
        .outputOptions(['-movflags', 'frag_keyframe+empty_moov+default_base_moof'])
        .toFormat('mp4')
        .on('error', (err) => {
          [inputPath, audioInputPath].forEach(p => p && fs.unlink(p).catch(() => {}));
          console.error('FFmpeg error:', err);
          if (!res.headersSent) res.status(500).end();
        })
        .on('end', () => { [inputPath, audioInputPath].forEach(p => p && fs.unlink(p).catch(() => {})); })
        .pipe(res);
    } catch (error) {
      [inputPath, audioInputPath].forEach(p => p && fs.unlink(p).catch(() => {}));
      if (!res.headersSent) res.status(500).json({ error: error.message || 'Failed to process video' });
    }
    return;
  }

  // Streaming path: video is the raw request body; operation/args/file-type are in headers.
  const operation = req.headers['x-operation'];
  const argsStr = req.headers['x-args'];
  const fileContentType = contentType.split(';')[0].trim() || 'video/mp4';

  if (!operation) {
    return res.status(400).json({ error: 'No operation specified in x-operation header' });
  }

  let parsedArgs;
  try {
    parsedArgs = argsStr ? JSON.parse(argsStr) : {};
  } catch (e) {
    return res.status(400).json({ error: 'Invalid x-args header: must be valid JSON' });
  }

  const conversionOps = ['convert_video_format', 'convert_audio_format', 'extract_audio'];
  let outputExt = 'mp4';
  if (conversionOps.includes(operation)) {
    outputExt = parsedArgs.format || 'mp4';
  }

  const inputFormat = getMimeTypeToFormat(fileContentType);

  // Special case: get_video_info uses ffprobe which requires a seekable (on-disk) input
  if (operation === 'get_video_info') {
    let tmpInputPath = null;
    try {
      const chunks = [];
      for await (const chunk of req) { chunks.push(chunk); }
      const inputBuffer = Buffer.concat(chunks);
      tmpInputPath = path.join(TMP_DIR, `input-${randomUUID()}.${getExtFromMimeType(fileContentType)}`);
      await fs.writeFile(tmpInputPath, inputBuffer);
      await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(tmpInputPath, (err, metadata) => {
          if (err) reject(err);
          else { res.json(metadata); resolve(); }
        });
      });
    } catch (error) {
      console.error('Error getting video info:', error);
      if (!res.headersSent) res.status(500).json({ error: error.message || 'Failed to get video info' });
    } finally {
      if (tmpInputPath) await fs.unlink(tmpInputPath).catch(() => {});
    }
    return;
  }

  // Determine response Content-Type based on operation and output format
  const AUDIO_CONTENT_TYPES = {
    mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
    ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', wma: 'audio/x-ms-wma'
  };
  const VIDEO_CONTENT_TYPES = {
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska', flv: 'video/x-flv', ogv: 'video/ogg'
  };
  const audioOnlyOps = ['convert_audio_format', 'extract_audio'];
  let responseContentType = 'video/mp4';
  if (audioOnlyOps.includes(operation)) {
    responseContentType = AUDIO_CONTENT_TYPES[outputExt] || 'application/octet-stream';
  } else if (operation === 'convert_video_format') {
    responseContentType = VIDEO_CONTENT_TYPES[outputExt] || 'video/mp4';
  }

  // Read request body to a temporary file first. Many container formats (especially MP4)
  // are not reliably seekable from stdin, which can yield truncated/invalid output blobs.
  let tmpStreamInputPath = null;
  try {
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const inputBuffer = Buffer.concat(chunks);
    if (!inputBuffer.length) {
      return res.status(400).json({ error: 'No video data received' });
    }
    tmpStreamInputPath = path.join(TMP_DIR, `input-${randomUUID()}.${getExtFromMimeType(fileContentType)}`);
    await fs.writeFile(tmpStreamInputPath, inputBuffer);
  } catch (error) {
    console.error('Error buffering streamed input:', error);
    return res.status(500).json({ error: 'Failed to read uploaded video stream' });
  }

  // Build ffmpeg command from a seekable temp file, while still streaming output to the client.
  let command = ffmpeg(tmpStreamInputPath).inputFormat(inputFormat);

  switch (operation) {
    case 'resize_video':
      command = command.videoFilters(`scale=${parsedArgs.width}:${parsedArgs.height}`).audioCodec('copy');
      break;

    case 'crop_video':
      command = command.videoFilters(`crop=${parsedArgs.width}:${parsedArgs.height}:${parsedArgs.x}:${parsedArgs.y}`).audioCodec('copy');
      break;

    case 'rotate_video':
      command = command.videoFilters(`rotate=${parsedArgs.angle}*PI/180`).audioCodec('copy');
      break;

    case 'flip_video_horizontal':
      command = command.videoFilters('hflip').audioCodec('copy');
      break;

    case 'add_text': {
      const escapedText = parsedArgs.text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/:/g, '\\:')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(/\t/g, '\\t');
      command = command.videoFilters(
        `drawtext=text='${escapedText}':x=${parsedArgs.x || 10}:y=${parsedArgs.y || 10}:fontsize=${parsedArgs.fontsize || 24}:fontcolor=${parsedArgs.color || 'white'}`
      ).audioCodec('copy');
      break;
    }

    case 'trim_video':
      command = command.setStartTime(parsedArgs.start).setDuration(parsedArgs.end - parsedArgs.start).outputOptions('-c copy');
      break;

    case 'speed_video': {
      let audioFilter = '';
      const speed = parsedArgs.speed;
      if (speed >= 0.5 && speed <= 2.0) {
        audioFilter = `atempo=${speed}`;
      } else if (speed < 0.5) {
        let remainingSpeed = speed;
        const filters = [];
        while (remainingSpeed < 0.5) { filters.push('atempo=0.5'); remainingSpeed *= 2; }
        if (remainingSpeed !== 1.0) filters.push(`atempo=${remainingSpeed}`);
        audioFilter = filters.join(',');
      } else {
        let remainingSpeed = speed;
        const filters = [];
        while (remainingSpeed > 2.0) { filters.push('atempo=2.0'); remainingSpeed /= 2; }
        if (remainingSpeed !== 1.0) filters.push(`atempo=${remainingSpeed}`);
        audioFilter = filters.join(',');
      }
      command = command.videoFilters(`setpts=PTS/${parsedArgs.speed}`).audioFilters(audioFilter);
      break;
    }

    case 'adjust_volume':
      command = command.audioFilters(`volume=${parsedArgs.volume}`).videoCodec('copy');
      break;

    case 'audio_fade': {
      const fadeFilter = parsedArgs.type === 'in'
        ? `afade=t=in:st=${parsedArgs.start}:d=${parsedArgs.duration}`
        : `afade=t=out:st=${parsedArgs.start}:d=${parsedArgs.duration}`;
      command = command.audioFilters(fadeFilter).videoCodec('copy');
      break;
    }

    case 'highpass_filter':
      command = command.audioFilters(`highpass=f=${parsedArgs.frequency}`).videoCodec('copy');
      break;

    case 'lowpass_filter':
      command = command.audioFilters(`lowpass=f=${parsedArgs.frequency}`).videoCodec('copy');
      break;

    case 'echo_effect':
      command = command.audioFilters(`aecho=1.0:0.7:${parsedArgs.delay}:${parsedArgs.decay}`).videoCodec('copy');
      break;

    case 'bass_adjustment':
      command = command.audioFilters(`bass=g=${parsedArgs.gain}`).videoCodec('copy');
      break;

    case 'treble_adjustment':
      command = command.audioFilters(`treble=g=${parsedArgs.gain}`).videoCodec('copy');
      break;

    case 'equalizer': {
      const eqWidth = parsedArgs.width || 200;
      command = command.audioFilters(`equalizer=f=${parsedArgs.frequency}:width_type=h:width=${eqWidth}:g=${parsedArgs.gain}`).videoCodec('copy');
      break;
    }

    case 'normalize_audio': {
      const normTarget = parsedArgs.target || -16;
      command = command.audioFilters(`loudnorm=I=${normTarget}:TP=-1.5:LRA=11`).videoCodec('copy');
      break;
    }

    case 'delay_audio':
      command = command.audioFilters(`adelay=${parsedArgs.delay}|${parsedArgs.delay}`).videoCodec('copy');
      break;

    case 'audio_chorus': {
      const chorusInGain = parsedArgs.in_gain ?? 0.5;
      const chorusOutGain = parsedArgs.out_gain ?? 0.9;
      const chorusDelays = parsedArgs.delays ?? '40|60|80';
      const chorusDecays = parsedArgs.decays ?? '0.4|0.5|0.6';
      const chorusSpeeds = parsedArgs.speeds ?? '0.5|0.6|0.7';
      const chorusDepths = parsedArgs.depths ?? '0.25|0.4|0.35';
      command = command.audioFilters(`chorus=${chorusInGain}:${chorusOutGain}:${chorusDelays}:${chorusDecays}:${chorusSpeeds}:${chorusDepths}:t`).videoCodec('copy');
      break;
    }

    case 'audio_flanger': {
      const flangerDelay = parsedArgs.delay ?? 0;
      const flangerDepth = parsedArgs.depth ?? 2;
      const flangerRegen = parsedArgs.regen ?? 0;
      const flangerWidth = parsedArgs.width ?? 71;
      const flangerSpeed = parsedArgs.speed ?? 0.5;
      command = command.audioFilters(`flanger=delay=${flangerDelay}:depth=${flangerDepth}:regen=${flangerRegen}:width=${flangerWidth}:speed=${flangerSpeed}`).videoCodec('copy');
      break;
    }

    case 'audio_phaser': {
      const phaserInGain = parsedArgs.in_gain ?? 0.4;
      const phaserOutGain = parsedArgs.out_gain ?? 0.74;
      const phaserDelay = parsedArgs.delay ?? 3;
      const phaserDecay = parsedArgs.decay ?? 0.4;
      const phaserSpeed = parsedArgs.speed ?? 0.5;
      command = command.audioFilters(`aphaser=in_gain=${phaserInGain}:out_gain=${phaserOutGain}:delay=${phaserDelay}:decay=${phaserDecay}:speed=${phaserSpeed}`).videoCodec('copy');
      break;
    }

    case 'audio_vibrato': {
      const vibratoFreq = parsedArgs.frequency ?? 5;
      const vibratoDepth = parsedArgs.depth ?? 0.5;
      command = command.audioFilters(`vibrato=f=${vibratoFreq}:d=${vibratoDepth}`).videoCodec('copy');
      break;
    }

    case 'audio_tremolo': {
      const tremoloFreq = parsedArgs.frequency ?? 5;
      const tremoloDepth = parsedArgs.depth ?? 0.5;
      command = command.audioFilters(`tremolo=f=${tremoloFreq}:d=${tremoloDepth}`).videoCodec('copy');
      break;
    }

    case 'audio_compressor': {
      const compThreshold = parsedArgs.threshold ?? 0;
      const compRatio = parsedArgs.ratio ?? 4;
      const compAttack = parsedArgs.attack ?? 20;
      const compRelease = parsedArgs.release ?? 250;
      command = command.audioFilters(`acompressor=threshold=${compThreshold}dB:ratio=${compRatio}:attack=${compAttack}:release=${compRelease}`).videoCodec('copy');
      break;
    }

    case 'audio_gate': {
      const gateThreshold = parsedArgs.threshold ?? -50;
      const gateRatio = parsedArgs.ratio ?? 2;
      const gateAttack = parsedArgs.attack ?? 20;
      const gateRelease = parsedArgs.release ?? 250;
      command = command.audioFilters(`agate=threshold=${gateThreshold}dB:ratio=${gateRatio}:attack=${gateAttack}:release=${gateRelease}`).videoCodec('copy');
      break;
    }

    case 'audio_stereo_widen': {
      const stereoDelay = parsedArgs.delay ?? 20;
      const stereoFeedback = parsedArgs.feedback ?? 0.3;
      const stereoCrossfeed = parsedArgs.crossfeed ?? 0.3;
      command = command.audioFilters(`stereowiden=delay=${stereoDelay}:feedback=${stereoFeedback}:crossfeed=${stereoCrossfeed}`).videoCodec('copy');
      break;
    }

    case 'audio_reverse':
      command = command.audioFilters('areverse').videoCodec('copy');
      break;

    case 'audio_limiter': {
      const limiterLevel = parsedArgs.level ?? 1.0;
      const limiterAttack = parsedArgs.attack ?? 5;
      const limiterRelease = parsedArgs.release ?? 50;
      command = command.audioFilters(`alimiter=level_in=1:level_out=1:limit=${limiterLevel}:attack=${limiterAttack}:release=${limiterRelease}`).videoCodec('copy');
      break;
    }

    case 'audio_silence_remove': {
      const startThreshold = parsedArgs.start_threshold ?? -50;
      const startDuration = parsedArgs.start_duration ?? 0.5;
      const stopThreshold = parsedArgs.stop_threshold ?? -50;
      const stopDuration = parsedArgs.stop_duration ?? 0.5;
      command = command.audioFilters(`silenceremove=start_periods=1:start_threshold=${startThreshold}dB:start_duration=${startDuration}:stop_periods=-1:stop_threshold=${stopThreshold}dB:stop_duration=${stopDuration}`).videoCodec('copy');
      break;
    }

    case 'audio_pan': {
      const panValue = parsedArgs.pan;
      let leftGain, rightGain;
      if (panValue < 0) {
        leftGain = 1.0;
        rightGain = 1.0 + panValue;
      } else if (panValue > 0) {
        leftGain = 1.0 - panValue;
        rightGain = 1.0;
      } else {
        leftGain = 1.0;
        rightGain = 1.0;
      }
      command = command.audioFilters(`pan=stereo|c0=${leftGain}*c0|c1=${rightGain}*c1`).videoCodec('copy');
      break;
    }

    case 'adjust_brightness':
      command = command.videoFilters(`eq=brightness=${parsedArgs.brightness}`).audioCodec('copy');
      break;

    case 'adjust_hue':
      command = command.videoFilters(`hue=h=${parsedArgs.degrees}`).audioCodec('copy');
      break;

    case 'adjust_saturation':
      command = command.videoFilters(`eq=saturation=${parsedArgs.saturation}`).audioCodec('copy');
      break;

    case 'convert_video_format': {
      const supportedVideoFormats = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv'];
      const targetFormat = parsedArgs.format;
      if (!targetFormat || !supportedVideoFormats.includes(targetFormat)) {
        if (!res.headersSent) return res.status(400).end();
        return;
      }
      const supportedVideoCodecs = ['libx264', 'libx265', 'libvpx-vp9', 'auto'];
      if (parsedArgs.codec && !supportedVideoCodecs.includes(parsedArgs.codec)) {
        if (!res.headersSent) return res.status(400).end();
        return;
      }
      const codec = parsedArgs.codec && parsedArgs.codec !== 'auto' ? parsedArgs.codec : null;
      if (codec) {
        command = command.videoCodec(codec).audioCodec('copy');
      } else {
        command = command.outputOptions('-c copy');
      }
      command = command.toFormat(targetFormat);
      break;
    }

    case 'convert_audio_format': {
      const supportedAudioFormats = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'];
      if (!parsedArgs.format || !supportedAudioFormats.includes(parsedArgs.format)) {
        if (!res.headersSent) return res.status(400).end();
        return;
      }
      const audioBitrate = parsedArgs.bitrate || '192k';
      command = command.noVideo().toFormat(parsedArgs.format).audioBitrate(audioBitrate);
      break;
    }

    case 'extract_audio': {
      const supportedExtractFormats = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'];
      const format = parsedArgs.format || 'mp3';
      if (!supportedExtractFormats.includes(format)) {
        if (!res.headersSent) return res.status(400).end();
        return;
      }
      const extractBitrate = parsedArgs.bitrate || '192k';
      command = command.noVideo().toFormat(format).audioBitrate(extractBitrate);
      break;
    }

    case 'fade_transition': {
      const fadeDuration = parsedArgs.duration || 1;
      command = command.videoFilters(`fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${parsedArgs.totalDuration - fadeDuration}:d=${fadeDuration}`).audioCodec('copy');
      break;
    }

    case 'crossfade_transition':
      return res.status(400).json({ error: 'crossfade_transition requires special multi-video handling' });

    default:
      return res.status(400).json({ error: `Unknown operation: ${operation}` });
  }

  // Set response headers and pipe ffmpeg stdout directly to the response
  res.set('Content-Type', responseContentType);
  if (outputExt === 'mp4') {
    command.outputOptions(['-movflags', 'frag_keyframe+empty_moov+default_base_moof']);
  }
  command
    .toFormat(outputExt)
    .on('error', (err) => {
      console.error('Error processing video:', err);
      if (tmpStreamInputPath) fs.unlink(tmpStreamInputPath).catch(() => {});
      if (!res.headersSent) res.status(500).end();
    })
    .on('end', () => {
      if (tmpStreamInputPath) fs.unlink(tmpStreamInputPath).catch(() => {});
    })
    .pipe(res);
});

// Multi-video transition endpoint
router.post('/api/transition-videos', videoProcessLimiter, requireAuthenticatedUser, requireActiveSubscription, upload.array('videos', 10), async (req, res) => {
  const tempFiles = [];
  let outputPath = null;

  try {
    const { transition, duration } = req.body;

    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: 'At least two video files are required for transitions' });
    }

    if (!transition) {
      return res.status(400).json({ error: 'No transition type specified' });
    }

    // Parse duration if it's a string
    const transitionDuration = duration ? parseFloat(duration) : 1;

    // Create temporary files
    const tmpDir = TMP_DIR;

    // Write uploaded files to disk
    const inputPaths = [];
    for (let i = 0; i < req.files.length; i++) {
      const inputPath = path.join(tmpDir, `input-${randomUUID()}-${i}.mp4`);
      await fs.writeFile(inputPath, req.files[i].buffer);
      inputPaths.push(inputPath);
      tempFiles.push(inputPath);
    }

    outputPath = path.join(tmpDir, `output-${randomUUID()}.mp4`);

    // Check which videos have audio streams
    const hasAudio = await Promise.all(
      inputPaths.map(inputPath => checkHasAudioStream(inputPath))
    );

    // Process videos with transition
    await new Promise((resolve, reject) => {
      let command = ffmpeg();

      // Add all inputs
      inputPaths.forEach(inputPath => {
        command = command.input(inputPath);
      });

      let filterComplex = '';
      let outputLabels = [];

      switch (transition) {
        case 'crossfade':
          // Build crossfade filter chain for all videos
          // For 2 videos: [0:v][1:v]xfade=transition=fade:duration=1:offset=<video0_duration-1>[v]
          // For 3+ videos: chain multiple xfades
          filterComplex = buildCrossfadeFilter(inputPaths.length, transitionDuration, hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'wipe_left':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'wipeleft', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'wipe_right':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'wiperight', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'wipe_up':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'wipeup', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'wipe_down':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'wipedown', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'slide_left':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'slideleft', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'slide_right':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'slideright', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'slide_up':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'slideup', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'slide_down':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'slidedown', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'dissolve':
          // Dissolve is similar to crossfade with fade transition
          filterComplex = buildCrossfadeFilter(inputPaths.length, transitionDuration, hasAudio, 'dissolve');
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'fade':
          // Fade to black between clips
          filterComplex = buildFadeFilter(inputPaths.length, transitionDuration, hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        default:
          reject(new Error(`Unknown transition type: ${transition}`));
          return;
      }

      command
        .output(outputPath)
        .outputOptions('-map', '[v]');

      // Only map audio if at least one video has audio
      if (hasAudio.some(h => h)) {
        command.outputOptions('-map', '[a]').audioCodec('aac');
      }

      command
        .videoCodec('libx264')
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });

    // Read the processed video
    const processedVideo = await fs.readFile(outputPath);

    // Clean up temporary files
    for (const tempFile of tempFiles) {
      await fs.unlink(tempFile);
    }
    await fs.unlink(outputPath);

    // Send the processed video
    res.set('Content-Type', 'video/mp4');
    res.send(processedVideo);

  } catch (error) {
    console.error('Error processing video transition:', error);

    // Clean up on error
    for (const tempFile of tempFiles) {
      try { await fs.unlink(tempFile); } catch (e) { /* ignore */ }
    }
    if (outputPath) {
      try { await fs.unlink(outputPath); } catch (e) { /* ignore */ }
    }

    res.status(500).json({ error: error.message || 'Failed to process video transition' });
  }
});

export { router as videoRouter };
