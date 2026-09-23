import ffmpeg from 'fluent-ffmpeg';
import { getMimeTypeToFormat } from './utils.js';

const AUDIO_CONTENT_TYPES = {
  mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', wma: 'audio/x-ms-wma',
};
const VIDEO_CONTENT_TYPES = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska', flv: 'video/x-flv', ogv: 'video/ogg',
};

export class OpValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'OpValidationError';
    this.statusCode = statusCode;
  }
}

/**
 * Resolve output extension + Content-Type for a process-video operation.
 */
export function resolveOutputMeta(operation, parsedArgs = {}) {
  const conversionOps = ['convert_video_format', 'convert_audio_format', 'extract_audio'];
  let outputExt = 'mp4';
  if (conversionOps.includes(operation)) {
    outputExt = parsedArgs.format || (operation === 'extract_audio' ? 'mp3' : 'mp4');
  }
  const audioOnlyOps = ['convert_audio_format', 'extract_audio'];
  let contentType = 'video/mp4';
  if (audioOnlyOps.includes(operation)) {
    contentType = AUDIO_CONTENT_TYPES[outputExt] || 'application/octet-stream';
  } else if (operation === 'convert_video_format') {
    contentType = VIDEO_CONTENT_TYPES[outputExt] || 'video/mp4';
  }
  return { outputExt, contentType };
}

/**
 * Apply a process-video operation onto a fluent-ffmpeg command.
 * Throws OpValidationError for unknown/invalid ops.
 */
export function applyOperation(command, operation, parsedArgs = {}) {
  switch (operation) {
    case 'resize_video':
      return command.videoFilters(`scale=${parsedArgs.width}:${parsedArgs.height}`).audioCodec('copy');
    case 'crop_video':
      return command.videoFilters(`crop=${parsedArgs.width}:${parsedArgs.height}:${parsedArgs.x}:${parsedArgs.y}`).audioCodec('copy');
    case 'rotate_video':
      return command.videoFilters(`rotate=${parsedArgs.angle}*PI/180`).audioCodec('copy');
    case 'flip_video_horizontal':
      return command.videoFilters('hflip').audioCodec('copy');
    case 'add_text': {
      const escapedText = String(parsedArgs.text || '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/:/g, '\\:')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(/\t/g, '\\t');
      return command.videoFilters(
        `drawtext=text='${escapedText}':x=${parsedArgs.x || 10}:y=${parsedArgs.y || 10}:fontsize=${parsedArgs.fontsize || 24}:fontcolor=${parsedArgs.color || 'white'}`
      ).audioCodec('copy');
    }
    case 'trim_video':
      return command.setStartTime(parsedArgs.start).setDuration(parsedArgs.end - parsedArgs.start).outputOptions('-c copy');
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
      return command.videoFilters(`setpts=PTS/${parsedArgs.speed}`).audioFilters(audioFilter);
    }
    case 'adjust_volume':
      return command.audioFilters(`volume=${parsedArgs.volume}`).videoCodec('copy');
    case 'audio_fade': {
      const fadeFilter = parsedArgs.type === 'in'
        ? `afade=t=in:st=${parsedArgs.start}:d=${parsedArgs.duration}`
        : `afade=t=out:st=${parsedArgs.start}:d=${parsedArgs.duration}`;
      return command.audioFilters(fadeFilter).videoCodec('copy');
    }
    case 'highpass_filter':
      return command.audioFilters(`highpass=f=${parsedArgs.frequency}`).videoCodec('copy');
    case 'lowpass_filter':
      return command.audioFilters(`lowpass=f=${parsedArgs.frequency}`).videoCodec('copy');
    case 'echo_effect':
      return command.audioFilters(`aecho=1.0:0.7:${parsedArgs.delay}:${parsedArgs.decay}`).videoCodec('copy');
    case 'bass_adjustment':
      return command.audioFilters(`bass=g=${parsedArgs.gain}`).videoCodec('copy');
    case 'treble_adjustment':
      return command.audioFilters(`treble=g=${parsedArgs.gain}`).videoCodec('copy');
    case 'equalizer': {
      const eqWidth = parsedArgs.width || 200;
      return command.audioFilters(`equalizer=f=${parsedArgs.frequency}:width_type=h:width=${eqWidth}:g=${parsedArgs.gain}`).videoCodec('copy');
    }
    case 'normalize_audio': {
      const normTarget = parsedArgs.target || -16;
      return command.audioFilters(`loudnorm=I=${normTarget}:TP=-1.5:LRA=11`).videoCodec('copy');
    }
    case 'delay_audio':
      return command.audioFilters(`adelay=${parsedArgs.delay}|${parsedArgs.delay}`).videoCodec('copy');
    case 'audio_chorus': {
      const chorusInGain = parsedArgs.in_gain ?? 0.5;
      const chorusOutGain = parsedArgs.out_gain ?? 0.9;
      const chorusDelays = parsedArgs.delays ?? '40|60|80';
      const chorusDecays = parsedArgs.decays ?? '0.4|0.5|0.6';
      const chorusSpeeds = parsedArgs.speeds ?? '0.5|0.6|0.7';
      const chorusDepths = parsedArgs.depths ?? '0.25|0.4|0.35';
      return command.audioFilters(`chorus=${chorusInGain}:${chorusOutGain}:${chorusDelays}:${chorusDecays}:${chorusSpeeds}:${chorusDepths}:t`).videoCodec('copy');
    }
    case 'audio_flanger': {
      const flangerDelay = parsedArgs.delay ?? 0;
      const flangerDepth = parsedArgs.depth ?? 2;
      const flangerRegen = parsedArgs.regen ?? 0;
      const flangerWidth = parsedArgs.width ?? 71;
      const flangerSpeed = parsedArgs.speed ?? 0.5;
      return command.audioFilters(`flanger=delay=${flangerDelay}:depth=${flangerDepth}:regen=${flangerRegen}:width=${flangerWidth}:speed=${flangerSpeed}`).videoCodec('copy');
    }
    case 'audio_phaser': {
      const phaserInGain = parsedArgs.in_gain ?? 0.4;
      const phaserOutGain = parsedArgs.out_gain ?? 0.74;
      const phaserDelay = parsedArgs.delay ?? 3;
      const phaserDecay = parsedArgs.decay ?? 0.4;
      const phaserSpeed = parsedArgs.speed ?? 0.5;
      return command.audioFilters(`aphaser=in_gain=${phaserInGain}:out_gain=${phaserOutGain}:delay=${phaserDelay}:decay=${phaserDecay}:speed=${phaserSpeed}`).videoCodec('copy');
    }
    case 'audio_vibrato': {
      const vibratoFreq = parsedArgs.frequency ?? 5;
      const vibratoDepth = parsedArgs.depth ?? 0.5;
      return command.audioFilters(`vibrato=f=${vibratoFreq}:d=${vibratoDepth}`).videoCodec('copy');
    }
    case 'audio_tremolo': {
      const tremoloFreq = parsedArgs.frequency ?? 5;
      const tremoloDepth = parsedArgs.depth ?? 0.5;
      return command.audioFilters(`tremolo=f=${tremoloFreq}:d=${tremoloDepth}`).videoCodec('copy');
    }
    case 'audio_compressor': {
      const compThreshold = parsedArgs.threshold ?? 0;
      const compRatio = parsedArgs.ratio ?? 4;
      const compAttack = parsedArgs.attack ?? 20;
      const compRelease = parsedArgs.release ?? 250;
      return command.audioFilters(`acompressor=threshold=${compThreshold}dB:ratio=${compRatio}:attack=${compAttack}:release=${compRelease}`).videoCodec('copy');
    }
    case 'audio_dynamic_normalize': {
      const mode = parsedArgs.mode ?? 'dynaudnorm';
      if (mode === 'compand') {
        const attacks = parsedArgs.attacks ?? 0.3;
        const decays = parsedArgs.decays ?? 0.8;
        const points = parsedArgs.points ?? '-70/-70|-40/-30|-20/-15|0/-12';
        const gain = parsedArgs.gain ?? 3;
        return command.audioFilters(`compand=attacks=${attacks}:decays=${decays}:points=${points}:gain=${gain}`).videoCodec('copy');
      }
      const frameLength = parsedArgs.frame_length ?? 150;
      const gaussianSize = parsedArgs.gaussian_size ?? 31;
      return command.audioFilters(`dynaudnorm=f=${frameLength}:g=${gaussianSize}`).videoCodec('copy');
    }
    case 'audio_gate': {
      const gateThreshold = parsedArgs.threshold ?? -50;
      const gateRatio = parsedArgs.ratio ?? 2;
      const gateAttack = parsedArgs.attack ?? 20;
      const gateRelease = parsedArgs.release ?? 250;
      return command.audioFilters(`agate=threshold=${gateThreshold}dB:ratio=${gateRatio}:attack=${gateAttack}:release=${gateRelease}`).videoCodec('copy');
    }
    case 'audio_stereo_widen': {
      const stereoDelay = parsedArgs.delay ?? 20;
      const stereoFeedback = parsedArgs.feedback ?? 0.3;
      const stereoCrossfeed = parsedArgs.crossfeed ?? 0.3;
      return command.audioFilters(`stereowiden=delay=${stereoDelay}:feedback=${stereoFeedback}:crossfeed=${stereoCrossfeed}`).videoCodec('copy');
    }
    case 'audio_reverse':
      return command.audioFilters('areverse').videoCodec('copy');
    case 'audio_limiter': {
      const limiterLevel = parsedArgs.level ?? 1.0;
      const limiterAttack = parsedArgs.attack ?? 5;
      const limiterRelease = parsedArgs.release ?? 50;
      return command.audioFilters(`alimiter=level_in=1:level_out=1:limit=${limiterLevel}:attack=${limiterAttack}:release=${limiterRelease}`).videoCodec('copy');
    }
    case 'audio_silence_remove': {
      const startThreshold = parsedArgs.start_threshold ?? -50;
      const startDuration = parsedArgs.start_duration ?? 0.5;
      const stopThreshold = parsedArgs.stop_threshold ?? -50;
      const stopDuration = parsedArgs.stop_duration ?? 0.5;
      return command.audioFilters(`silenceremove=start_periods=1:start_threshold=${startThreshold}dB:start_duration=${startDuration}:stop_periods=-1:stop_threshold=${stopThreshold}dB:stop_duration=${stopDuration}`).videoCodec('copy');
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
      return command.audioFilters(`pan=stereo|c0=${leftGain}*c0|c1=${rightGain}*c1`).videoCodec('copy');
    }
    case 'adjust_brightness':
      return command.videoFilters(`eq=brightness=${parsedArgs.brightness}`).audioCodec('copy');
    case 'adjust_hue':
      return command.videoFilters(`hue=h=${parsedArgs.degrees}`).audioCodec('copy');
    case 'adjust_saturation':
      return command.videoFilters(`eq=saturation=${parsedArgs.saturation}`).audioCodec('copy');
    case 'convert_video_format': {
      const supportedVideoFormats = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv'];
      const targetFormat = parsedArgs.format;
      if (!targetFormat || !supportedVideoFormats.includes(targetFormat)) {
        throw new OpValidationError(`format must be one of: ${supportedVideoFormats.join(', ')}`);
      }
      const supportedVideoCodecs = ['libx264', 'libx265', 'libvpx-vp9', 'auto'];
      if (parsedArgs.codec && !supportedVideoCodecs.includes(parsedArgs.codec)) {
        throw new OpValidationError(`codec must be one of: ${supportedVideoCodecs.join(', ')}`);
      }
      const codec = parsedArgs.codec && parsedArgs.codec !== 'auto' ? parsedArgs.codec : null;
      let next = command;
      if (codec) {
        next = next.videoCodec(codec).audioCodec('copy');
      } else {
        next = next.outputOptions('-c copy');
      }
      return next.toFormat(targetFormat);
    }
    case 'convert_audio_format': {
      const supportedAudioFormats = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'];
      if (!parsedArgs.format || !supportedAudioFormats.includes(parsedArgs.format)) {
        throw new OpValidationError(`format must be one of: ${supportedAudioFormats.join(', ')}`);
      }
      const audioBitrate = parsedArgs.bitrate || '192k';
      return command.noVideo().toFormat(parsedArgs.format).audioBitrate(audioBitrate);
    }
    case 'extract_audio': {
      const supportedExtractFormats = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'];
      const format = parsedArgs.format || 'mp3';
      if (!supportedExtractFormats.includes(format)) {
        throw new OpValidationError(`format must be one of: ${supportedExtractFormats.join(', ')}`);
      }
      const extractBitrate = parsedArgs.bitrate || '192k';
      return command.noVideo().toFormat(format).audioBitrate(extractBitrate);
    }
    case 'fade_transition': {
      const fadeDuration = parsedArgs.duration || 1;
      return command.videoFilters(`fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${parsedArgs.totalDuration - fadeDuration}:d=${fadeDuration}`).audioCodec('copy');
    }
    case 'crossfade_transition':
      throw new OpValidationError('crossfade_transition requires special multi-video handling — use /api/transition-videos');
    case 'get_video_info':
      throw new OpValidationError('get_video_info is sync-only — use POST /api/process-video');
    case 'add_audio_track':
    case 'burn_subtitles':
      throw new OpValidationError(`${operation} requires multipart secondary inputs — use sync POST /api/process-video for now`);
    default:
      throw new OpValidationError(`Unknown operation: ${operation}`);
  }
}

/**
 * Run a process-video operation to an output file (for async jobs).
 */
export function processVideoToFile({ inputPath, inputMime, operation, args, outputPath }) {
  const parsedArgs = args && typeof args === 'object' ? args : {};
  const { outputExt, contentType } = resolveOutputMeta(operation, parsedArgs);
  const inputFormat = getMimeTypeToFormat(inputMime || 'video/mp4');

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath).inputFormat(inputFormat);
    try {
      command = applyOperation(command, operation, parsedArgs);
    } catch (err) {
      reject(err);
      return;
    }

    command
      .output(outputPath)
      .toFormat(outputExt)
      .on('error', (err) => reject(err))
      .on('end', () => resolve({ outputExt, contentType }))
      .run();
  });
}
