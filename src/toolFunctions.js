// Server-side video processing tool functions
// These functions call the server API instead of using client-side FFmpeg

// Aspect ratio presets for social media platforms
const ASPECT_RATIO_PRESETS = {
  '9:16': { width: 1080, height: 1920, description: 'Stories, Reels, & TikToks' },
  '16:9': { width: 1920, height: 1080, description: 'YT thumbnails & Cinematic widescreen' },
  '1:1': { width: 1080, height: 1080, description: 'X feed posts & Profile pics' },
  '2:3': { width: 1080, height: 1620, description: 'Posters, Pinterest & Tall Portraits' },
  '3:2': { width: 1620, height: 1080, description: 'Classic photography, Landscape' }
};

// Supported conversion formats (kept in sync with tools.js enums and server.js)
const SUPPORTED_VIDEO_FORMATS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv'];
const SUPPORTED_AUDIO_FORMATS = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'];
const SUPPORTED_EXTRACT_FORMATS = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'];

const VIDEO_MIME_TYPES = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska', flv: 'video/x-flv', ogv: 'video/ogg'
};
const AUDIO_MIME_TYPES = {
  mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', wma: 'audio/x-ms-wma'
};

let sampleModeEnabled = false;
let sampleModeAccessToken = null;
let currentFileMimeType = 'video/mp4';

export function setSampleModeEnabled(enabled) {
  sampleModeEnabled = Boolean(enabled);
}

export function setSampleModeAccessToken(token) {
  sampleModeAccessToken = typeof token === 'string' && token ? token : null;
}

export function setCurrentFileMimeType(mimeType) {
  currentFileMimeType = (typeof mimeType === 'string' && mimeType) ? mimeType : 'video/mp4';
}

function normalizeAudioFileInput(audioFile) {
  if (typeof audioFile === 'string') {
    const trimmed = audioFile.trim();
    if (!trimmed) {
      throw new Error('audioFile cannot be empty');
    }
    return trimmed;
  }

  if (audioFile instanceof Uint8Array) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < audioFile.length; i += chunkSize) {
      binary += String.fromCharCode(...audioFile.subarray(i, i + chunkSize));
    }
    return `data:audio/mpeg;base64,${btoa(binary)}`;
  }

  if (audioFile instanceof ArrayBuffer) {
    return normalizeAudioFileInput(new Uint8Array(audioFile));
  }

  throw new Error('audioFile must be a base64 string, Uint8Array, or ArrayBuffer');
}

// Collect all chunks from a ReadableStreamDefaultReader into a single Uint8Array
async function collectStreamChunks(reader) {
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.length;
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// Helper function to call server API using streaming:
// video data is sent as the raw request body; operation, args, and file type go in headers.
// Response is streamed via ReadableStream and accumulated into a Uint8Array.
async function processVideoOnServer(operation, args, videoFileData) {
  const fileMimeType = currentFileMimeType || 'video/mp4';

  const response = await fetch('/api/process-video', {
    method: 'POST',
    headers: {
      'Content-Type': fileMimeType,
      'x-operation': operation,
      'x-args': JSON.stringify(args),
      ...(sampleModeEnabled && sampleModeAccessToken ? { 'sample-access-token': sampleModeAccessToken } : {})
    },
    body: videoFileData
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || 'Server processing failed');
  }

  return collectStreamChunks(response.body.getReader());
}

export const toolFunctions = {
  resize_video: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.width === null || args.width === undefined || args.height === null || args.height === undefined) {
        throw new Error('Width and height are required');
      }
      if (args.width <= 0 || args.height <= 0) {
        throw new Error('Width and height must be positive numbers');
      }

      const data = await processVideoOnServer('resize_video', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (resized):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video resized successfully.';
    } catch (error) {
      addMessage('Error resizing video: ' + error.message, false);
      return 'Failed to resize video: ' + error.message;
    }
  },
  
  crop_video: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs - use strict equality to allow 0 values
      if (args.x === null || args.x === undefined || args.y === null || args.y === undefined || args.width === null || args.width === undefined || args.height === null || args.height === undefined) {
        throw new Error('x, y, width, and height are required for cropping');
      }
      if (args.x < 0 || args.y < 0 || args.width <= 0 || args.height <= 0) {
        throw new Error('Crop dimensions must be valid positive numbers');
      }

      const data = await processVideoOnServer('crop_video', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (cropped):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video cropped successfully.';
    } catch (error) {
      addMessage('Error cropping video: ' + error.message, false);
      return 'Failed to crop video: ' + error.message;
    }
  },
  
  rotate_video: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.angle === null || args.angle === undefined) {
        throw new Error('Angle is required for rotation');
      }

      const data = await processVideoOnServer('rotate_video', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (rotated):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video rotated successfully.';
    } catch (error) {
      addMessage('Error rotating video: ' + error.message, false);
      return 'Failed to rotate video: ' + error.message;
    }
  },
  
  flip_video_horizontal: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const data = await processVideoOnServer('flip_video_horizontal', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (flipped horizontally):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video flipped horizontally successfully.';
    } catch (error) {
      addMessage('Error flipping video horizontally: ' + error.message, false);
      return 'Failed to flip video horizontally: ' + error.message;
    }
  },
  
  add_text: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs - explicitly reject empty strings along with null/undefined
      if (typeof args.text !== 'string' || args.text === '') {
        throw new Error('Text is required and cannot be empty');
      }

      const data = await processVideoOnServer('add_text', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (text added):', false, videoUrl, 'processed', 'video/mp4');
      return 'Text added to video successfully.';
    } catch (error) {
      addMessage('Error adding text to video: ' + error.message, false);
      return 'Failed to add text to video: ' + error.message;
    }
  },
  
  trim_video: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs - use strict equality to allow 0 as a valid start time
      if (args.start === null || args.start === undefined || args.end === null || args.end === undefined) {
        throw new Error('Start and end times are required for trimming');
      }

      const data = await processVideoOnServer('trim_video', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (trimmed):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video trimmed successfully.';
    } catch (error) {
      addMessage('Error trimming video: ' + error.message, false);
      return 'Failed to trim video: ' + error.message;
    }
  },
  
  adjust_speed: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.speed === null || args.speed === undefined || args.speed <= 0) {
        throw new Error('Speed must be a positive number');
      }

      const data = await processVideoOnServer('speed_video', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (speed adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video speed adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting video speed: ' + error.message, false);
      return 'Failed to adjust video speed: ' + error.message;
    }
  },
  
  adjust_volume: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.volume === null || args.volume === undefined || args.volume < 0) {
        throw new Error('Volume must be a non-negative number');
      }

      const data = await processVideoOnServer('adjust_volume', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (volume adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Audio volume adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting volume: ' + error.message, false);
      return 'Failed to adjust audio volume: ' + error.message;
    }
  },
  
  audio_fade: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (!args.type || (args.type !== 'in' && args.type !== 'out')) {
        throw new Error('Type must be "in" or "out"');
      }
      if (args.duration === null || args.duration === undefined || args.duration <= 0) {
        throw new Error('Duration must be a positive number');
      }

      const data = await processVideoOnServer('audio_fade', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (audio fade applied):', false, videoUrl, 'processed', 'video/mp4');
      return `Audio fade ${args.type} applied successfully.`;
    } catch (error) {
      addMessage('Error applying audio fade: ' + error.message, false);
      return 'Failed to apply audio fade: ' + error.message;
    }
  },
  
  highpass_filter: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.frequency === null || args.frequency === undefined || args.frequency <= 0) {
        throw new Error('Frequency must be a positive number');
      }

      const data = await processVideoOnServer('highpass_filter', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (highpass filter applied):', false, videoUrl, 'processed', 'video/mp4');
      return 'Highpass filter applied successfully.';
    } catch (error) {
      addMessage('Error applying highpass filter: ' + error.message, false);
      return 'Failed to apply highpass filter: ' + error.message;
    }
  },
  
  lowpass_filter: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.frequency === null || args.frequency === undefined || args.frequency <= 0) {
        throw new Error('Frequency must be a positive number');
      }

      const data = await processVideoOnServer('lowpass_filter', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (lowpass filter applied):', false, videoUrl, 'processed', 'video/mp4');
      return 'Lowpass filter applied successfully.';
    } catch (error) {
      addMessage('Error applying lowpass filter: ' + error.message, false);
      return 'Failed to apply lowpass filter: ' + error.message;
    }
  },
  
  echo_effect: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.delay === null || args.delay === undefined || args.decay === null || args.decay === undefined) {
        throw new Error('Delay and decay are required');
      }
      if (args.decay <= 0 || args.decay >= 1) {
        throw new Error('Decay must be between 0 and 1 (exclusive)');
      }

      const data = await processVideoOnServer('echo_effect', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (echo effect applied):', false, videoUrl, 'processed', 'video/mp4');
      return 'Echo effect applied successfully.';
    } catch (error) {
      addMessage('Error applying echo effect: ' + error.message, false);
      return 'Failed to apply echo effect: ' + error.message;
    }
  },
  
  bass_adjustment: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.gain === null || args.gain === undefined) {
        throw new Error('Gain is required');
      }
      if (args.gain < -20 || args.gain > 20) {
        throw new Error('Gain must be between -20 and 20 dB');
      }

      const data = await processVideoOnServer('bass_adjustment', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (bass adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Bass adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting bass: ' + error.message, false);
      return 'Failed to adjust bass: ' + error.message;
    }
  },
  
  treble_adjustment: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.gain === null || args.gain === undefined) {
        throw new Error('Gain is required');
      }

      const data = await processVideoOnServer('treble_adjustment', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (treble adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Treble adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting treble: ' + error.message, false);
      return 'Failed to adjust treble: ' + error.message;
    }
  },
  
  equalizer: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.frequency === null || args.frequency === undefined || args.gain === null || args.gain === undefined) {
        throw new Error('Frequency and gain are required');
      }

      const data = await processVideoOnServer('equalizer', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (equalizer applied):', false, videoUrl, 'processed', 'video/mp4');
      return 'Equalizer applied successfully.';
    } catch (error) {
      addMessage('Error applying equalizer: ' + error.message, false);
      return 'Failed to apply equalizer: ' + error.message;
    }
  },
  
  normalize_audio: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.target === null || args.target === undefined) {
        throw new Error('Target loudness is required');
      }
      if (args.target > 0) {
        throw new Error('Target must be a negative value (LUFS), e.g. -16');
      }
      const data = await processVideoOnServer('normalize_audio', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (audio normalized):', false, videoUrl, 'processed', 'video/mp4');
      return 'Audio normalized successfully.';
    } catch (error) {
      addMessage('Error normalizing audio: ' + error.message, false);
      return 'Failed to normalize audio: ' + error.message;
    }
  },
  
  delay_audio: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.delay === null || args.delay === undefined) {
        throw new Error('Delay is required');
      }
      if (args.delay < 0) {
        throw new Error('Delay must be a non-negative value');
      }

      const data = await processVideoOnServer('delay_audio', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (audio delayed):', false, videoUrl, 'processed', 'video/mp4');
      return 'Audio delayed successfully.';
    } catch (error) {
      addMessage('Error delaying audio: ' + error.message, false);
      return 'Failed to delay audio: ' + error.message;
    }
  },
  
  adjust_brightness: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.brightness === null || args.brightness === undefined) {
        throw new Error('Brightness value is required');
      }
      if (args.brightness < -1 || args.brightness > 1) {
        throw new Error('Brightness must be between -1 and 1');
      }

      const data = await processVideoOnServer('adjust_brightness', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (brightness adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Brightness adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting brightness: ' + error.message, false);
      return 'Failed to adjust brightness: ' + error.message;
    }
  },
  
  adjust_hue: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.degrees === null || args.degrees === undefined) {
        throw new Error('Hue degrees value is required');
      }
      if (args.degrees < -360 || args.degrees > 360) {
        throw new Error('Degrees must be between -360 and 360');
      }

      const data = await processVideoOnServer('adjust_hue', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (hue adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Hue adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting hue: ' + error.message, false);
      return 'Failed to adjust hue: ' + error.message;
    }
  },
  
  adjust_saturation: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.saturation === null || args.saturation === undefined) {
        throw new Error('Saturation value is required');
      }
      if (args.saturation < 0 || args.saturation > 3) {
        throw new Error('Saturation must be between 0 and 3');
      }

      const data = await processVideoOnServer('adjust_saturation', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (saturation adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Saturation adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting saturation: ' + error.message, false);
      return 'Failed to adjust saturation: ' + error.message;
    }
  },
  
  // Note: Some complex operations are not yet fully implemented
  // add_audio_track - needs multipart upload handling on server
  // convert_to_format - needs format-aware server handling
  
  get_video_info: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const fileMimeType = currentFileMimeType || 'video/mp4';
      const response = await fetch('/api/process-video', {
        method: 'POST',
        headers: {
          'Content-Type': fileMimeType,
          'x-operation': 'get_video_info',
          'x-args': JSON.stringify({}),
          ...(sampleModeEnabled && sampleModeAccessToken ? { 'sample-access-token': sampleModeAccessToken } : {})
        },
        body: videoFileData
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Server processing failed');
      }

      // Get metadata as JSON
      const metadata = await response.json();
      
      // Format the metadata for display
      const videoInfo = metadata.format || {};
      const videoStream = metadata.streams?.find(s => s.codec_type === 'video') || {};
      
      const info = `Video Information:
- Duration: ${videoInfo.duration ? Math.round(videoInfo.duration) + 's' : 'Unknown'}
- Size: ${videoInfo.size ? (videoInfo.size / 1024 / 1024).toFixed(2) + ' MB' : 'Unknown'}
- Resolution: ${videoStream.width || '?'} x ${videoStream.height || '?'}
- Codec: ${videoStream.codec_name || 'Unknown'}
- Frame Rate: ${videoStream.r_frame_rate || 'Unknown'}`;
      
      addMessage(info, false);
      return info;
    } catch (error) {
      addMessage('Error getting video info: ' + error.message, false);
      return 'Failed to get video info: ' + error.message;
    }
  },
  
  add_audio_track: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      if (args.audioFile === null || args.audioFile === undefined) {
        throw new Error('audioFile is required');
      }

      const mode = args.mode || 'replace';
      if (mode !== 'replace' && mode !== 'mix') {
        throw new Error('Mode must be either "replace" or "mix"');
      }

      const volume = args.volume ?? 1.0;
      if (typeof volume !== 'number' || Number.isNaN(volume) || volume < 0 || volume > 2) {
        throw new Error('Volume must be between 0.0 and 2.0');
      }

      const normalizedAudioFile = normalizeAudioFileInput(args.audioFile);
      // add_audio_track requires secondary binary audio input; use FormData so both files are sent together
      const fileMimeType = currentFileMimeType || 'video/mp4';
      const formData = new FormData();
      const videoBlob = new Blob([videoFileData], { type: fileMimeType });
      formData.append('video', videoBlob, 'input.mp4');
      formData.append('operation', 'add_audio_track');
      formData.append('args', JSON.stringify({ audioFile: normalizedAudioFile, mode, volume }));

      const response = await fetch('/api/process-video', {
        method: 'POST',
        headers: sampleModeEnabled && sampleModeAccessToken
          ? { 'sample-access-token': sampleModeAccessToken }
          : undefined,
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Server processing failed');
      }

      // Stream the response
      const data = await collectStreamChunks(response.body.getReader());

      setVideoFileData(data);
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage(`Processed video (audio track ${mode === 'mix' ? 'mixed' : 'replaced'}):`, false, videoUrl, 'processed', 'video/mp4');
      return mode === 'mix' ? 'Audio track mixed successfully.' : 'Audio track replaced successfully.';
    } catch (error) {
      addMessage('Error adding audio track: ' + error.message, false);
      return 'Failed to add audio track: ' + error.message;
    }
  },
  
  convert_to_format: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // This would need format-aware server handling
      addMessage('Format conversion is not yet implemented on server-side', false);
      return 'Feature not yet available with server-side processing';
    } catch (error) {
      addMessage('Error converting format: ' + error.message, false);
      return 'Failed to convert format: ' + error.message;
    }
  },

  convert_video_format: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      if (!args.format) {
        throw new Error('Target format is required');
      }
      if (!SUPPORTED_VIDEO_FORMATS.includes(args.format)) {
        throw new Error(`Unsupported format: ${args.format}. Supported formats: ${SUPPORTED_VIDEO_FORMATS.join(', ')}`);
      }

      const mimeType = VIDEO_MIME_TYPES[args.format] || 'video/mp4';

      const data = await processVideoOnServer('convert_video_format', args, videoFileData);
      setVideoFileData(data);
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));
      addMessage(`Converted video to ${args.format.toUpperCase()} format:`, false, videoUrl, 'processed', mimeType);
      return `Video converted to ${args.format} successfully.`;
    } catch (error) {
      addMessage('Error converting video format: ' + error.message, false);
      return 'Failed to convert video format: ' + error.message;
    }
  },

  convert_audio_format: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      if (!args.format) {
        throw new Error('Target audio format is required');
      }
      if (!SUPPORTED_AUDIO_FORMATS.includes(args.format)) {
        throw new Error(`Unsupported format: ${args.format}. Supported formats: ${SUPPORTED_AUDIO_FORMATS.join(', ')}`);
      }

      const mimeType = AUDIO_MIME_TYPES[args.format] || 'audio/mpeg';

      const data = await processVideoOnServer('convert_audio_format', args, videoFileData);
      setVideoFileData(data);
      const audioUrl = URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));
      addMessage(`Converted audio to ${args.format.toUpperCase()} format:`, false, audioUrl, 'processed', mimeType);
      return `Audio converted to ${args.format} successfully.`;
    } catch (error) {
      addMessage('Error converting audio format: ' + error.message, false);
      return 'Failed to convert audio format: ' + error.message;
    }
  },

  extract_audio: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const format = args.format || 'mp3';
      if (!SUPPORTED_EXTRACT_FORMATS.includes(format)) {
        throw new Error(`Unsupported format: ${format}. Supported formats: ${SUPPORTED_EXTRACT_FORMATS.join(', ')}`);
      }

      const mimeType = AUDIO_MIME_TYPES[format] || 'audio/mpeg';

      const data = await processVideoOnServer('extract_audio', { ...args, format }, videoFileData);
      setVideoFileData(data);
      const audioUrl = URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));
      addMessage(`Extracted audio as ${format.toUpperCase()}:`, false, audioUrl, 'processed', mimeType);
      return `Audio extracted as ${format} successfully.`;
    } catch (error) {
      addMessage('Error extracting audio: ' + error.message, false);
      return 'Failed to extract audio: ' + error.message;
    }
  },

  get_supported_formats: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const response = await fetch('/api/supported-formats', {
        method: 'GET',
        headers: sampleModeEnabled && sampleModeAccessToken
          ? { 'sample-access-token': sampleModeAccessToken }
          : undefined
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch supported formats');
      }

      const formats = await response.json();
      const info = `Supported conversion formats:
- Video formats: ${formats.video.formats.join(', ')}
- Video codecs: ${formats.video.codecs.join(', ')}
- Audio formats: ${formats.audio.formats.join(', ')}
- Audio bitrates: ${formats.audio.bitrates.join(', ')}
- Extract audio formats: ${formats.extract.formats.join(', ')}`;

      addMessage(info, false);
      return info;
    } catch (error) {
      addMessage('Error fetching supported formats: ' + error.message, false);
      return 'Failed to fetch supported formats: ' + error.message;
    }
  },
  
  resize_to_aspect_ratio: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (!args.ratio || !ASPECT_RATIO_PRESETS[args.ratio]) {
        throw new Error('Invalid aspect ratio. Must be one of: ' + Object.keys(ASPECT_RATIO_PRESETS).join(', '));
      }
      
      const preset = ASPECT_RATIO_PRESETS[args.ratio];
      const fitMode = args.fit || 'contain';
      
      // For now, use simple resize - more complex fitting logic would need server implementation
      const data = await processVideoOnServer('resize_video', { 
        width: preset.width, 
        height: preset.height 
      }, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage(`Processed video (resized to ${args.ratio}):\n${preset.description}`, false, videoUrl, 'processed', 'video/mp4');
      return `Video resized to ${args.ratio} aspect ratio successfully.`;
    } catch (error) {
      addMessage('Error resizing to aspect ratio: ' + error.message, false);
      return 'Failed to resize to aspect ratio: ' + error.message;
    }
  },
  
  add_video_transition: async (args, videoFileData, setVideoFileData, addMessage, uploadedVideos) => {
    try {
      // Use uploaded videos if available, otherwise expect videos in args
      let videosToProcess = [];
      
      if (uploadedVideos && uploadedVideos.length >= 2) {
        // Use the uploaded videos from the UI
        videosToProcess = uploadedVideos.map(v => v.data);
      } else if (args.videos && Array.isArray(args.videos) && args.videos.length >= 2) {
        // Fallback to videos passed in args (for testing or direct calls)
        videosToProcess = args.videos;
      } else {
        throw new Error('At least two video clips are required for transitions. Please upload multiple videos first.');
      }
      
      if (!args.transition) {
        throw new Error('Transition type is required');
      }

      const formData = new FormData();
      
      // Add all video files
      videosToProcess.forEach((videoData, index) => {
        const videoBlob = new Blob([videoData], { type: 'video/mp4' });
        formData.append('videos', videoBlob, `input-${index}.mp4`);
      });
      
      formData.append('transition', args.transition);
      formData.append('duration', args.duration || 1);
      
      const response = await fetch('/api/transition-videos', {
        method: 'POST',
        headers: sampleModeEnabled ? {
          ...(sampleModeAccessToken ? { 'sample-access-token': sampleModeAccessToken } : {})
        } : undefined,
        body: formData
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Server processing failed');
      }
      
      // Get the processed video as array buffer
      const arrayBuffer = await response.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage(`Processed video with ${args.transition} transition between ${videosToProcess.length} clips:`, false, videoUrl, 'processed', 'video/mp4');
      return `Video transition (${args.transition}) applied successfully to ${videosToProcess.length} clips.`;
    } catch (error) {
      addMessage('Error applying video transition: ' + error.message, false);
      return 'Failed to apply video transition: ' + error.message;
    }
  },
  
  // Aliases for backward compatibility with tests
  adjust_audio_volume: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.adjust_volume(args, videoFileData, setVideoFileData, addMessage),
  audio_highpass: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.highpass_filter(args, videoFileData, setVideoFileData, addMessage),
  audio_lowpass: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.lowpass_filter(args, videoFileData, setVideoFileData, addMessage),
  audio_echo: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.echo_effect(args, videoFileData, setVideoFileData, addMessage),
  adjust_bass: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.bass_adjustment(args, videoFileData, setVideoFileData, addMessage),
  adjust_treble: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.treble_adjustment(args, videoFileData, setVideoFileData, addMessage),
  audio_equalizer: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.equalizer(args, videoFileData, setVideoFileData, addMessage),
  audio_delay: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.delay_audio(args, videoFileData, setVideoFileData, addMessage),
  resize_video_preset: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      if (!args.preset) {
        throw new Error('Preset is required');
      }
      if (!ASPECT_RATIO_PRESETS[args.preset]) {
        throw new Error('Invalid preset: ' + args.preset + '. Must be one of: ' + Object.keys(ASPECT_RATIO_PRESETS).join(', '));
      }
      const preset = ASPECT_RATIO_PRESETS[args.preset];
      const data = await processVideoOnServer('resize_video', {
        width: preset.width,
        height: preset.height
      }, videoFileData);
      setVideoFileData(data);
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage(`Processed video (resized to ${args.preset}):\n${preset.description}`, false, videoUrl, 'processed', 'video/mp4');
      return `Video resized to ${args.preset} aspect ratio successfully.`;
    } catch (error) {
      addMessage('Error resizing video to preset: ' + error.message, false);
      return 'Failed to resize video to preset: ' + error.message;
    }
  },
  get_video_dimensions: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.get_video_info(args, videoFileData, setVideoFileData, addMessage),

  generate_captions: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const language = args.language || 'auto';
      const style = args.style || 'default';
      const position = args.position || 'bottom';
      const burnIn = args.burn_in !== false; // default true

      const fileMimeType = currentFileMimeType || 'video/mp4';

      // Step 1: Generate captions via xAI speech-to-text
      const captionResponse = await fetch('/api/generate-captions', {
        method: 'POST',
        headers: {
          'Content-Type': fileMimeType,
          'x-args': JSON.stringify({ language }),
          ...(sampleModeEnabled && sampleModeAccessToken ? { 'sample-access-token': sampleModeAccessToken } : {})
        },
        body: videoFileData
      });

      if (!captionResponse.ok) {
        const errorData = await captionResponse.json();
        throw new Error(errorData.error || 'Failed to generate captions');
      }

      const { srt, vtt } = await captionResponse.json();

      if (!srt) {
        throw new Error('No captions were generated from the audio');
      }

      // Step 2: Create downloadable subtitle files
      const srtBlob = new Blob([srt], { type: 'text/plain' });
      const vttBlob = new Blob([vtt], { type: 'text/vtt' });
      const srtUrl = URL.createObjectURL(srtBlob);
      const vttUrl = URL.createObjectURL(vttBlob);

      // Show a short excerpt of the transcript in chat.
      // Filter out SRT sequence numbers (lines with only digits) and timestamp lines (contain '-->').
      const lines = srt.split('\n').filter(l => l.trim() && !/^\d+$/.test(l.trim()) && !l.includes('-->'));
      const excerpt = lines.slice(0, 4).join(' ').substring(0, 200);
      addMessage(`Captions generated! Preview: "${excerpt}${lines.length > 4 ? '...' : ''}"\n\nDownload subtitles:`, false, srtUrl, 'subtitle-srt', 'text/plain');
      addMessage(`VTT subtitle file:`, false, vttUrl, 'subtitle-vtt', 'text/vtt');

      // Step 3: Optionally burn subtitles into the video
      if (burnIn) {
        const formData = new FormData();
        const videoBlob = new Blob([videoFileData], { type: fileMimeType });
        formData.append('video', videoBlob, 'input.mp4');
        formData.append('operation', 'burn_subtitles');
        formData.append('args', JSON.stringify({ srtContent: srt, style, position }));

        const burnResponse = await fetch('/api/process-video', {
          method: 'POST',
          headers: sampleModeEnabled && sampleModeAccessToken
            ? { 'sample-access-token': sampleModeAccessToken }
            : {},
          body: formData
        });

        if (!burnResponse.ok) {
          const errorData = await burnResponse.json();
          throw new Error(errorData.error || 'Failed to burn subtitles into video');
        }

        const arrayBuffer = await burnResponse.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        setVideoFileData(data);
        const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        addMessage(`Video with burned-in subtitles (${style} style, ${position}):`, false, videoUrl, 'processed', 'video/mp4');
        return `Captions generated and burned into video successfully. Language: ${language === 'auto' ? 'auto-detected' : language}. Style: ${style}, Position: ${position}. SRT and VTT files are also available for download.`;
      }

      return `Captions generated successfully. Language: ${language === 'auto' ? 'auto-detected' : language}. SRT and VTT subtitle files are available for download above.`;
    } catch (error) {
      addMessage('Error generating captions: ' + error.message, false);
      return 'Failed to generate captions: ' + error.message;
    }
  },
};
