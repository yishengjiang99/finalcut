import { ffmpeg as defaultFFmpeg, loadFFmpeg } from './ffmpeg.js';

// Aspect ratio presets for social media platforms
const ASPECT_RATIO_PRESETS = {
  '9:16': { width: 1080, height: 1920, description: 'Stories, Reels, & TikToks' },
  '16:9': { width: 1920, height: 1080, description: 'YT thumbnails & Cinematic widescreen' },
  '1:1': { width: 1080, height: 1080, description: 'X feed posts & Profile pics' },
  '2:3': { width: 1080, height: 1620, description: 'Posters, Pinterest & Tall Portraits' },
  '3:2': { width: 1620, height: 1080, description: 'Classic photography, Landscape' }
};

export const toolFunctions = {
  resize_video: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      // Validate inputs
      if (args.width === null || args.width === undefined || args.height === null || args.height === undefined) {
        throw new Error('Width and height are required');
      }
      if (args.width <= 0 || args.height <= 0) {
        throw new Error('Width and height must be positive numbers');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      await ffmpeg.exec(['-i', 'input.mp4', '-vf', `scale=${args.width}:${args.height}`, '-c:a', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (resized):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video resized successfully.';
    } catch (error) {
      addMessage('Error resizing video: ' + error.message, false);
      return 'Failed to resize video: ' + error.message;
    }
  },
  crop_video: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      // Validate inputs - use strict equality to allow 0 values
      if (args.x === null || args.x === undefined || args.y === null || args.y === undefined || args.width === null || args.width === undefined || args.height === null || args.height === undefined) {
        throw new Error('x, y, width, and height are required for cropping');
      }
      if (args.x < 0 || args.y < 0 || args.width <= 0 || args.height <= 0) {
        throw new Error('Crop dimensions must be valid positive numbers');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      await ffmpeg.exec(['-i', 'input.mp4', '-vf', `crop=${args.width}:${args.height}:${args.x}:${args.y}`, '-c:a', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (cropped):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video cropped successfully.';
    } catch (error) {
      addMessage('Error cropping video: ' + error.message, false);
      return 'Failed to crop video: ' + error.message;
    }
  },
  rotate_video: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      // Validate inputs
      if (args.angle === null || args.angle === undefined) {
        throw new Error('Angle is required for rotation');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      await ffmpeg.exec(['-i', 'input.mp4', '-vf', `rotate=${args.angle}*PI/180`, '-c:a', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (rotated):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video rotated successfully.';
    } catch (error) {
      addMessage('Error rotating video: ' + error.message, false);
      return 'Failed to rotate video: ' + error.message;
    }
  },
  add_text: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      // Validate inputs - explicitly reject empty strings along with null/undefined
      if (typeof args.text !== 'string' || args.text === '') {
        throw new Error('Text is required and cannot be empty');
      }
      // Escape special characters in text to prevent injection
      // Replace single quotes with escaped version and handle other special chars
      const escapedText = args.text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/:/g, '\\:')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(/\t/g, '\\t');
      await ffmpeg.writeFile('input.mp4', videoFileData);
      await ffmpeg.exec(['-i', 'input.mp4', '-vf', `drawtext=text='${escapedText}':x=${args.x || 10}:y=${args.y || 10}:fontsize=${args.fontsize || 24}:fontcolor=${args.color || 'white'}`, '-c:a', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');

      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      console.log(videoUrl)
      addMessage('Processed video (text added):', false, videoUrl, 'processed', 'video/mp4');
      return 'Text added to video successfully.';
    } catch (error) {
      addMessage('Error adding text to video: ' + error.message, false);
      return 'Failed to add text to video: ' + error.message;
    }
  },
  trim_video: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      // Validate inputs - use strict equality to allow 0 as a valid start time
      if (args.start === null || args.start === undefined || args.end === null || args.end === undefined) {
        throw new Error('Start and end times are required for trimming');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      await ffmpeg.exec(['-i', 'input.mp4', '-ss', args.start, '-to', args.end, '-c', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (trimmed):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video trimmed successfully.';
    } catch (error) {
      addMessage('Error trimming video: ' + error.message, false);
      return 'Failed to trim video: ' + error.message;
    }
  },
  adjust_speed: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      // Validate inputs
      if (args.speed === null || args.speed === undefined || args.speed <= 0) {
        throw new Error('Speed must be a positive number');
      }
      await ffmpeg.writeFile('input.mp4', videoFileData);

      // atempo filter only supports values between 0.5 and 2.0
      // For values outside this range, we need to chain multiple atempo filters
      let audioFilter = '';
      let speed = args.speed;

      if (speed >= 0.5 && speed <= 2.0) {
        audioFilter = `atempo=${speed}`;
      } else if (speed < 0.5) {
        // Chain atempo filters for slow speeds
        let remainingSpeed = speed;
        const filters = [];
        while (remainingSpeed < 0.5) {
          filters.push('atempo=0.5');
          remainingSpeed *= 2;
        }
        if (remainingSpeed !== 1.0) {
          filters.push(`atempo=${remainingSpeed}`);
        }
        audioFilter = filters.join(',');
      } else {
        // Chain atempo filters for fast speeds
        let remainingSpeed = speed;
        const filters = [];
        while (remainingSpeed > 2.0) {
          filters.push('atempo=2.0');
          remainingSpeed /= 2;
        }
        if (remainingSpeed !== 1.0) {
          filters.push(`atempo=${remainingSpeed}`);
        }
        audioFilter = filters.join(',');
      }

      await ffmpeg.exec(['-i', 'input.mp4', '-filter:v', `setpts=PTS/${args.speed}`, '-filter:a', audioFilter, 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (speed adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Video speed adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting video speed: ' + error.message, false);
      return 'Failed to adjust video speed: ' + error.message;
    }
  },
  add_audio_track: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      // Validate inputs
      if (!args.audioFile || args.audioFile === '') {
        throw new Error('Audio file is required');
      }

      const mode = args.mode || 'replace';
      const volume = args.volume !== undefined ? args.volume : 1.0;

      // Validate mode
      if (mode !== 'replace' && mode !== 'mix') {
        throw new Error('Mode must be either "replace" or "mix"');
      }

      // Validate volume
      if (volume < 0.0 || volume > 2.0) {
        throw new Error('Volume must be between 0.0 and 2.0');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);

      // Handle both base64 strings and Uint8Array audio data
      let audioData;
      if (typeof args.audioFile === 'string') {
        // If it's a base64 string, decode it
        const base64Data = args.audioFile.split(',')[1] || args.audioFile;
        const binaryString = atob(base64Data);
        audioData = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          audioData[i] = binaryString.charCodeAt(i);
        }
      } else if (args.audioFile instanceof Uint8Array) {
        audioData = args.audioFile;
      } else {
        throw new Error('Audio file must be a base64 string or Uint8Array');
      }

      await ffmpeg.writeFile('audio.mp3', audioData);

      // Build FFmpeg command based on mode
      if (mode === 'replace') {
        // Replace audio: use video from first input, audio from second input
        await ffmpeg.exec([
          '-i', 'input.mp4',
          '-i', 'audio.mp3',
          '-map', '0:v',
          '-map', '1:a',
          '-filter:a', `volume=${volume}`,
          '-c:v', 'copy',
          '-shortest',
          'output.mp4'
        ]);
      } else {
        // Mix audio: combine both audio tracks
        await ffmpeg.exec([
          '-i', 'input.mp4',
          '-i', 'audio.mp3',
          '-filter_complex', `[0:a]volume=1.0[a0];[1:a]volume=${volume}[a1];[a0][a1]amix=inputs=2:duration=shortest`,
          '-map', '0:v',
          '-c:v', 'copy',
          'output.mp4'
        ]);
      }

      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage(`Processed video (audio track ${mode === 'replace' ? 'replaced' : 'mixed'}):`, false, videoUrl, 'processed', 'video/mp4');
      return `Audio track ${mode === 'replace' ? 'replaced' : 'mixed'} successfully.`;
    } catch (error) {
      addMessage('Error adding audio track: ' + error.message, false);
      return 'Failed to add audio track: ' + error.message;
    }
  },
  adjust_audio_volume: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.volume === null || args.volume === undefined) {
        throw new Error('Volume is required');
      }
      if (args.volume < 0 || args.volume > 10) {
        throw new Error('Volume must be between 0 and 10');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      await ffmpeg.exec(['-i', 'input.mp4', '-filter:a', `volume=${args.volume}`, '-c:v', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (audio volume adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Audio volume adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting audio volume: ' + error.message, false);
      return 'Failed to adjust audio volume: ' + error.message;
    }
  },
  audio_fade: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (!args.type || (args.type !== 'in' && args.type !== 'out')) {
        throw new Error('Type must be either "in" or "out"');
      }
      if (args.duration === null || args.duration === undefined || args.duration <= 0) {
        throw new Error('Duration must be a positive number');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      const fadeFilter = args.type === 'in'
        ? `afade=t=in:st=0:d=${args.duration}`
        : `afade=t=out:st=0:d=${args.duration}`;
      await ffmpeg.exec(['-i', 'input.mp4', '-filter:a', fadeFilter, '-c:v', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage(`Processed video (audio fade ${args.type} applied):`, false, videoUrl, 'processed', 'video/mp4');
      return `Audio fade ${args.type} applied successfully.`;
    } catch (error) {
      addMessage('Error applying audio fade: ' + error.message, false);
      return 'Failed to apply audio fade: ' + error.message;
    }
  },
  audio_highpass: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.frequency === null || args.frequency === undefined || args.frequency <= 0) {
        throw new Error('Frequency must be a positive number');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      await ffmpeg.exec(['-i', 'input.mp4', '-filter:a', `highpass=f=${args.frequency}`, '-c:v', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (highpass filter applied):', false, videoUrl, 'processed', 'video/mp4');
      return 'Highpass filter applied successfully.';
    } catch (error) {
      addMessage('Error applying highpass filter: ' + error.message, false);
      return 'Failed to apply highpass filter: ' + error.message;
    }
  },
  audio_lowpass: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.frequency === null || args.frequency === undefined || args.frequency <= 0) {
        throw new Error('Frequency must be a positive number');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      await ffmpeg.exec(['-i', 'input.mp4', '-filter:a', `lowpass=f=${args.frequency}`, '-c:v', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (lowpass filter applied):', false, videoUrl, 'processed', 'video/mp4');
      return 'Lowpass filter applied successfully.';
    } catch (error) {
      addMessage('Error applying lowpass filter: ' + error.message, false);
      return 'Failed to apply lowpass filter: ' + error.message;
    }
  },
  audio_echo: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.delay === null || args.delay === undefined || args.delay <= 0) {
        throw new Error('Delay must be a positive number');
      }
      if (args.decay === null || args.decay === undefined || args.decay < 0 || args.decay > 1) {
        throw new Error('Decay must be between 0 and 1');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      // aecho filter: in_gain:out_gain:delays:decays
      await ffmpeg.exec(['-i', 'input.mp4', '-filter:a', `aecho=1.0:0.7:${args.delay}:${args.decay}`, '-c:v', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (echo effect applied):', false, videoUrl, 'processed', 'video/mp4');
      return 'Echo effect applied successfully.';
    } catch (error) {
      addMessage('Error applying echo effect: ' + error.message, false);
      return 'Failed to apply echo effect: ' + error.message;
    }
  },
  adjust_bass: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.gain === null || args.gain === undefined) {
        throw new Error('Gain is required');
      }
      if (args.gain < -20 || args.gain > 20) {
        throw new Error('Gain must be between -20 and 20 dB');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      // bass filter adjusts frequencies around 100 Hz
      await ffmpeg.exec(['-i', 'input.mp4', '-filter:a', `bass=g=${args.gain}`, '-c:v', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (bass adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Bass adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting bass: ' + error.message, false);
      return 'Failed to adjust bass: ' + error.message;
    }
  },
  adjust_treble: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.gain === null || args.gain === undefined) {
        throw new Error('Gain is required');
      }
      if (args.gain < -20 || args.gain > 20) {
        throw new Error('Gain must be between -20 and 20 dB');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      // treble filter adjusts frequencies around 3000 Hz
      await ffmpeg.exec(['-i', 'input.mp4', '-filter:a', `treble=g=${args.gain}`, '-c:v', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (treble adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Treble adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting treble: ' + error.message, false);
      return 'Failed to adjust treble: ' + error.message;
    }
  },
  audio_equalizer: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.frequency === null || args.frequency === undefined || args.frequency <= 0) {
        throw new Error('Frequency must be a positive number');
      }
      if (args.gain === null || args.gain === undefined) {
        throw new Error('Gain is required');
      }
      if (args.gain < -20 || args.gain > 20) {
        throw new Error('Gain must be between -20 and 20 dB');
      }
      const width = args.width || 200;

      await ffmpeg.writeFile('input.mp4', videoFileData);
      // equalizer filter: frequency=f:width_type=h:width=w:gain=g
      await ffmpeg.exec(['-i', 'input.mp4', '-filter:a', `equalizer=f=${args.frequency}:width_type=h:width=${width}:g=${args.gain}`, '-c:v', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (equalizer applied):', false, videoUrl, 'processed', 'video/mp4');
      return 'Equalizer applied successfully.';
    } catch (error) {
      addMessage('Error applying equalizer: ' + error.message, false);
      return 'Failed to apply equalizer: ' + error.message;
    }
  },
  normalize_audio: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.target === null || args.target === undefined) {
        throw new Error('Target loudness is required');
      }
      if (args.target < -70 || args.target > -5) {
        throw new Error('Target must be between -70 and -5 LUFS');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      // loudnorm filter normalizes audio loudness
      await ffmpeg.exec(['-i', 'input.mp4', '-filter:a', `loudnorm=I=${args.target}:TP=-1.5:LRA=11`, '-c:v', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (audio normalized):', false, videoUrl, 'processed', 'video/mp4');
      return 'Audio normalized successfully.';
    } catch (error) {
      addMessage('Error normalizing audio: ' + error.message, false);
      return 'Failed to normalize audio: ' + error.message;
    }
  },
  audio_delay: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.delay === null || args.delay === undefined) {
        throw new Error('Delay is required');
      }
      if (args.delay < 0) {
        throw new Error('Delay must be non-negative');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      // adelay filter delays audio by milliseconds
      await ffmpeg.exec(['-i', 'input.mp4', '-filter:a', `adelay=${args.delay}|${args.delay}`, '-c:v', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (audio delayed):', false, videoUrl, 'processed', 'video/mp4');
      return 'Audio delayed successfully.';
    } catch (error) {
      addMessage('Error delaying audio: ' + error.message, false);
      return 'Failed to delay audio: ' + error.message;
    }
  },
  resize_video_preset: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      // Validate preset parameter
      if (!args.preset) {
        throw new Error('Preset is required');
      }

      const preset = ASPECT_RATIO_PRESETS[args.preset];
      if (!preset) {
        throw new Error(`Invalid preset. Available presets: ${Object.keys(ASPECT_RATIO_PRESETS).join(', ')}`);
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);

      // Scale video to fit preset dimensions while maintaining aspect ratio,
      // then pad with black bars if needed to reach exact dimensions
      const scaleFilter = `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease`;
      const padFilter = `pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2`;
      const videoFilter = `${scaleFilter},${padFilter}`;

      await ffmpeg.exec([
        '-i', 'input.mp4',
        '-vf', videoFilter,
        '-c:a', 'copy',
        'output.mp4'
      ]);

      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage(`Processed video (resized to ${args.preset} - ${preset.description}):`, false, videoUrl, 'processed', 'video/mp4');
      return `Video resized to ${args.preset} aspect ratio successfully.`;
    } catch (error) {
      addMessage('Error resizing video to preset: ' + error.message, false);
      return 'Failed to resize video to preset: ' + error.message;
    }
  },
  adjust_brightness: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.brightness === null || args.brightness === undefined) {
        throw new Error('Brightness is required');
      }
      if (args.brightness < -1.0 || args.brightness > 1.0) {
        throw new Error('Brightness must be between -1.0 and 1.0');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      // eq filter's brightness parameter: -1.0 (very dark) to 1.0 (very bright), 0 is no change
      await ffmpeg.exec(['-i', 'input.mp4', '-vf', `eq=brightness=${args.brightness}`, '-c:a', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (brightness adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Brightness adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting brightness: ' + error.message, false);
      return 'Failed to adjust brightness: ' + error.message;
    }
  },
  adjust_hue: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.degrees === null || args.degrees === undefined) {
        throw new Error('Degrees is required');
      }
      if (args.degrees < -360 || args.degrees > 360) {
        throw new Error('Degrees must be between -360 and 360');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      // hue filter's h parameter accepts degrees
      await ffmpeg.exec(['-i', 'input.mp4', '-vf', `hue=h=${args.degrees}`, '-c:a', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (hue adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Hue adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting hue: ' + error.message, false);
      return 'Failed to adjust hue: ' + error.message;
    }
  },
  adjust_saturation: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (args.saturation === null || args.saturation === undefined) {
        throw new Error('Saturation is required');
      }
      if (args.saturation < 0 || args.saturation > 3) {
        throw new Error('Saturation must be between 0 and 3');
      }

      await ffmpeg.writeFile('input.mp4', videoFileData);
      // eq filter's saturation parameter: 0 (grayscale) to 3 (very saturated), 1 is no change
      await ffmpeg.exec(['-i', 'input.mp4', '-vf', `eq=saturation=${args.saturation}`, '-c:a', 'copy', 'output.mp4']);
      const data = await ffmpeg.readFile('output.mp4');
      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      addMessage('Processed video (saturation adjusted):', false, videoUrl, 'processed', 'video/mp4');
      return 'Saturation adjusted successfully.';
    } catch (error) {
      addMessage('Error adjusting saturation: ' + error.message, false);
      return 'Failed to adjust saturation: ' + error.message;
    }
  },
  get_video_dimensions: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      await ffmpeg.writeFile('input.mp4', videoFileData);

      // Helper function to calculate file size
      const getFileSizeMB = () => (videoFileData.length / (1024 * 1024)).toFixed(2);

      // Create a promise to capture ffmpeg logs
      let logOutput = '';
      const logHandler = ({ message }) => {
        logOutput += message + '\n';
      };

      // Add temporary log listener
      ffmpeg.on('log', logHandler);

      try {
        // Use -f null to extract metadata without creating output file
        // This is more reliable than intentionally failing the command
        await ffmpeg.exec(['-i', 'input.mp4', '-f', 'null', '-']);
      } catch (e) {
        // Even with -f null, might produce some errors but logs are captured
      }

      // Remove the temporary log listener
      ffmpeg.off('log', logHandler);

      // Parse the log output to extract video information
      // More robust patterns to handle different FFmpeg output formats
      const streamMatch = logOutput.match(/Stream #\d+:\d+.*Video:\s*([a-zA-Z0-9_-]+).*?(\d+)x(\d+)/);
      const durationMatch = logOutput.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      const fpsMatch = logOutput.match(/(\d+(?:\.\d+)?)\s*(?:fps|tb\(r\))/);
      const bitrateMatch = logOutput.match(/bitrate:\s*(\d+)\s*kb\/s/);

      let result = 'Video Information:\n';

      if (streamMatch) {
        const codec = streamMatch[1];
        const width = streamMatch[2];
        const height = streamMatch[3];
        result += `Resolution: ${width}x${height}\n`;
        result += `Video Codec: ${codec}\n`;
      }

      if (durationMatch) {
        const hours = durationMatch[1];
        const minutes = durationMatch[2];
        const seconds = durationMatch[3];
        result += `Duration: ${hours}:${minutes}:${seconds}\n`;
      }

      if (fpsMatch) {
        result += `Frame Rate: ${fpsMatch[1]} fps\n`;
      }

      if (bitrateMatch) {
        result += `Bitrate: ${bitrateMatch[1]} kb/s\n`;
      }

      const fileSizeMB = getFileSizeMB();
      result += `File Size: ${fileSizeMB} MB`;

      // If we couldn't parse dimensions, provide basic info
      if (!streamMatch) {
        result = `Video file loaded successfully.\n`;
        result += `File size: ${fileSizeMB} MB\n`;
        result += `Video is ready for editing. Detailed metadata could not be extracted from logs.`;
      }

      addMessage(result, false);
      return result;
    } catch (error) {
      // Even if ffmpeg fails, we can still return file size info
      const fileSizeMB = (videoFileData.length / (1024 * 1024)).toFixed(2);
      const result = `Video file loaded (${fileSizeMB} MB). Ready for editing operations.`;
      addMessage(result, false);
      return result;
    }
  },
  convert_video_format: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (!args.format) {
        throw new Error('Target format is required');
      }

      const format = args.format.toLowerCase();
      const validFormats = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv'];

      if (!validFormats.includes(format)) {
        throw new Error(`Unsupported format. Supported formats: ${validFormats.join(', ')}`);
      }

      await ffmpeg.writeFile('input', videoFileData);

      // Set codec based on format or use user-specified codec
      let codecArgs = [];
      if (args.codec && args.codec !== 'auto') {
        codecArgs = ['-c:v', args.codec];
      } else {
        // Auto-select codec based on format
        if (format === 'webm') {
          codecArgs = ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'];
        } else if (format === 'mp4') {
          codecArgs = ['-c:v', 'libx264', '-c:a', 'aac'];
        } else if (format === 'ogv') {
          codecArgs = ['-c:v', 'libtheora', '-c:a', 'libvorbis'];
        } else {
          // For other formats, let FFmpeg decide the codec
          codecArgs = [];
        }
      }

      const outputFile = `output.${format}`;
      await ffmpeg.exec(['-i', 'input', ...codecArgs, outputFile]);

      const data = await ffmpeg.readFile(outputFile);

      // Determine MIME type for blob
      let mimeType = 'video/mp4';
      if (format === 'webm') mimeType = 'video/webm';
      else if (format === 'ogv') mimeType = 'video/ogg';
      else if (format === 'avi') mimeType = 'video/x-msvideo';
      else if (format === 'mov') mimeType = 'video/quicktime';
      else if (format === 'mkv') mimeType = 'video/x-matroska';
      else if (format === 'flv') mimeType = 'video/x-flv';

      const videoUrl = URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));
      addMessage(`Processed video (converted to ${format.toUpperCase()}):`, false, videoUrl, 'processed', mimeType);
      return `Video converted to ${format.toUpperCase()} successfully.`;
    } catch (error) {
      addMessage('Error converting video format: ' + error.message, false);
      return 'Failed to convert video format: ' + error.message;
    }
  },
  convert_audio_format: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      if (!args.format) {
        throw new Error('Target format is required');
      }

      const format = args.format.toLowerCase();
      const validFormats = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'];

      if (!validFormats.includes(format)) {
        throw new Error(`Unsupported format. Supported formats: ${validFormats.join(', ')}`);
      }

      const bitrate = args.bitrate || '192k';

      await ffmpeg.writeFile('input', videoFileData);

      // Build codec arguments based on format
      let codecArgs = ['-vn']; // -vn = no video

      if (format === 'mp3') {
        codecArgs.push('-c:a', 'libmp3lame', '-b:a', bitrate);
      } else if (format === 'wav') {
        codecArgs.push('-c:a', 'pcm_s16le');
      } else if (format === 'aac' || format === 'm4a') {
        codecArgs.push('-c:a', 'aac', '-b:a', bitrate);
      } else if (format === 'ogg') {
        codecArgs.push('-c:a', 'libvorbis', '-b:a', bitrate);
      } else if (format === 'flac') {
        codecArgs.push('-c:a', 'flac');
      } else if (format === 'wma') {
        codecArgs.push('-c:a', 'wmav2', '-b:a', bitrate);
      }

      const outputFile = `output.${format}`;
      await ffmpeg.exec(['-i', 'input', ...codecArgs, outputFile]);

      const data = await ffmpeg.readFile(outputFile);

      // Determine MIME type for blob
      let mimeType = 'audio/mpeg';
      if (format === 'wav') mimeType = 'audio/wav';
      else if (format === 'aac') mimeType = 'audio/aac';
      else if (format === 'ogg') mimeType = 'audio/ogg';
      else if (format === 'flac') mimeType = 'audio/flac';
      else if (format === 'm4a') mimeType = 'audio/mp4';
      else if (format === 'wma') mimeType = 'audio/x-ms-wma';

      const audioUrl = URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));
      addMessage(`Processed audio (converted to ${format.toUpperCase()}):`, false, audioUrl, 'processed', mimeType);
      return `Audio converted to ${format.toUpperCase()} successfully.`;
    } catch (error) {
      addMessage('Error converting audio format: ' + error.message, false);
      return 'Failed to convert audio format: ' + error.message;
    }
  },
  extract_audio: async (args, videoFileData, setVideoFileData, addMessage, ffmpeg = defaultFFmpeg) => {
    try {
      const format = args.format || 'mp3';
      const bitrate = args.bitrate || '192k';

      const validFormats = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'];

      if (!validFormats.includes(format)) {
        throw new Error(`Unsupported format. Supported formats: ${validFormats.join(', ')}`);
      }

      await ffmpeg.writeFile('input', videoFileData);

      // Build codec arguments based on format
      let codecArgs = ['-vn']; // -vn = no video (extract audio only)

      if (format === 'mp3') {
        codecArgs.push('-c:a', 'libmp3lame', '-b:a', bitrate);
      } else if (format === 'wav') {
        codecArgs.push('-c:a', 'pcm_s16le');
      } else if (format === 'aac' || format === 'm4a') {
        codecArgs.push('-c:a', 'aac', '-b:a', bitrate);
      } else if (format === 'ogg') {
        codecArgs.push('-c:a', 'libvorbis', '-b:a', bitrate);
      } else if (format === 'flac') {
        codecArgs.push('-c:a', 'flac');
      }

      const outputFile = `output.${format}`;
      await ffmpeg.exec(['-i', 'input', ...codecArgs, outputFile]);

      const data = await ffmpeg.readFile(outputFile);

      // Determine MIME type for blob
      let mimeType = 'audio/mpeg';
      if (format === 'wav') mimeType = 'audio/wav';
      else if (format === 'aac') mimeType = 'audio/aac';
      else if (format === 'ogg') mimeType = 'audio/ogg';
      else if (format === 'flac') mimeType = 'audio/flac';
      else if (format === 'm4a') mimeType = 'audio/mp4';

      const audioUrl = URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));
      addMessage(`Extracted audio (${format.toUpperCase()}):`, false, audioUrl, 'processed', mimeType);
      return `Audio extracted to ${format.toUpperCase()} successfully.`;
    } catch (error) {
      addMessage('Error extracting audio: ' + error.message, false);
      return 'Failed to extract audio: ' + error.message;
    }
  }
};
