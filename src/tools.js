export const tools = [
  {
    type: 'function',
    function: {
      name: 'resize_video',
      description: 'Resize the video to the specified width and height while maintaining aspect ratio if needed. This filter scales the video dimensions.',
      parameters: {
        type: 'object',
        properties: {
          width: { type: 'integer', description: 'The new width in pixels. Must be a positive even number for most codecs.' },
          height: { type: 'integer', description: 'The new height in pixels. Must be a positive even number for most codecs. Use -1 to auto-scale based on width.' }
        },
        required: ['width', 'height']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'crop_video',
      description: 'Crop a region of the video starting from the specified top-left corner with given width and height. Useful for removing borders or focusing on a part of the frame.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer', description: 'The x-coordinate of the top-left corner of the crop area.' },
          y: { type: 'integer', description: 'The y-coordinate of the top-left corner of the crop area.' },
          width: { type: 'integer', description: 'The width of the crop area in pixels.' },
          height: { type: 'integer', description: 'The height of the crop area in pixels.' }
        },
        required: ['x', 'y', 'width', 'height']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rotate_video',
      description: 'Rotate the video by the specified angle in degrees. Common for correcting orientation, e.g., 90 for clockwise, -90 for counter-clockwise.',
      parameters: {
        type: 'object',
        properties: {
          angle: { type: 'number', description: 'The rotation angle in degrees. Positive for clockwise, negative for counter-clockwise.' }
        },
        required: ['angle']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'flip_video_horizontal',
      description: 'Flip the video horizontally (mirror effect). This creates a mirror image of the video along the vertical axis.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_text',
      description: 'Overlay text on the video at a specified position with customizable size and color. Note: This assumes a default font is available in FFmpeg.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to overlay on the video.' },
          x: { type: 'integer', description: 'The x-position for the text (default: 10).', default: 10 },
          y: { type: 'integer', description: 'The y-position for the text (default: 10).', default: 10 },
          fontsize: { type: 'integer', description: 'The font size (default: 24).', default: 24 },
          color: { type: 'string', description: 'The font color (default: white).', default: 'white' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'trim_video',
      description: 'Trim the video to keep only the portion between the start and end times. Times can be in seconds or HH:MM:SS format.',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'The start time (e.g., 00:00:10 or 10).' },
          end: { type: 'string', description: 'The end time (e.g., 00:00:30 or 30).' }
        },
        required: ['start', 'end']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_speed',
      description: 'Change the playback speed of the video and audio. A factor >1 speeds up, <1 slows down.',
      parameters: {
        type: 'object',
        properties: {
          speed: { type: 'number', description: 'The speed factor (e.g., 2 for double speed, 0.5 for half speed).' }
        },
        required: ['speed']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_audio_track',
      description: 'Add or replace the audio track in a video with a new audio file. This can be used to add background music, voiceovers, or replace the existing audio entirely.',
      parameters: {
        type: 'object',
        properties: {
          audioFile: { type: 'string', description: 'The audio file data (base64 encoded or file reference) to add to the video.' },
          mode: { 
            type: 'string', 
            description: 'The audio mixing mode: "replace" to replace existing audio, or "mix" to mix with existing audio.',
            enum: ['replace', 'mix'],
            default: 'replace'
          },
          volume: { 
            type: 'number', 
            description: 'Volume level for the new audio track (0.0 to 2.0, where 1.0 is original volume). Default is 1.0.',
            default: 1.0
          }
        },
        required: ['audioFile']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_audio_volume',
      description: 'Adjust the volume level of the audio track. Can be used to make audio louder or quieter.',
      parameters: {
        type: 'object',
        properties: {
          volume: { 
            type: 'number', 
            description: 'Volume multiplier (e.g., 0.5 for half volume, 2.0 for double volume, 1.0 for no change).',
            default: 1.0
          }
        },
        required: ['volume']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'audio_fade',
      description: 'Apply fade in or fade out effect to the audio. Useful for smooth transitions at the beginning or end of videos.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Type of fade: "in" for fade in at start, "out" for fade out at end.',
            enum: ['in', 'out']
          },
          duration: {
            type: 'number',
            description: 'Duration of the fade effect in seconds.',
            default: 3
          }
        },
        required: ['type', 'duration']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'audio_highpass',
      description: 'Apply a high-pass filter to remove low frequency sounds (bass). Useful for reducing rumble or bass noise.',
      parameters: {
        type: 'object',
        properties: {
          frequency: {
            type: 'number',
            description: 'Cutoff frequency in Hz. Frequencies below this will be attenuated. Typical values: 80-300 Hz.',
            default: 200
          }
        },
        required: ['frequency']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'audio_lowpass',
      description: 'Apply a low-pass filter to remove high frequency sounds (treble). Useful for reducing hiss or high-pitched noise.',
      parameters: {
        type: 'object',
        properties: {
          frequency: {
            type: 'number',
            description: 'Cutoff frequency in Hz. Frequencies above this will be attenuated. Typical values: 3000-8000 Hz.',
            default: 3000
          }
        },
        required: ['frequency']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'audio_echo',
      description: 'Add an echo effect to the audio. Creates a repetition of the sound with decay.',
      parameters: {
        type: 'object',
        properties: {
          delay: {
            type: 'number',
            description: 'Delay time in milliseconds for the echo effect. Typical values: 500-2000 ms.',
            default: 1000
          },
          decay: {
            type: 'number',
            description: 'Echo decay factor (0.0 to 1.0). Higher values create longer-lasting echoes.',
            default: 0.5
          }
        },
        required: ['delay', 'decay']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_bass',
      description: 'Adjust the bass (low frequency) level of the audio. Boost or cut bass frequencies.',
      parameters: {
        type: 'object',
        properties: {
          gain: {
            type: 'number',
            description: 'Bass gain in dB. Positive values boost bass, negative values reduce bass. Range: -20 to 20 dB.',
            default: 0
          }
        },
        required: ['gain']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_treble',
      description: 'Adjust the treble (high frequency) level of the audio. Boost or cut treble frequencies.',
      parameters: {
        type: 'object',
        properties: {
          gain: {
            type: 'number',
            description: 'Treble gain in dB. Positive values boost treble, negative values reduce treble. Range: -20 to 20 dB.',
            default: 0
          }
        },
        required: ['gain']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'audio_equalizer',
      description: 'Apply a parametric equalizer to adjust specific frequency bands. Useful for fine-tuning audio.',
      parameters: {
        type: 'object',
        properties: {
          frequency: {
            type: 'number',
            description: 'Center frequency in Hz to adjust. Common values: 100 (bass), 1000 (midrange), 10000 (treble).',
          },
          width: {
            type: 'number',
            description: 'Bandwidth of the frequency range in Hz. Wider values affect more frequencies.',
            default: 200
          },
          gain: {
            type: 'number',
            description: 'Gain in dB. Positive values boost, negative values cut. Range: -20 to 20 dB.',
            default: 0
          }
        },
        required: ['frequency', 'gain']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'normalize_audio',
      description: 'Normalize audio loudness to a standard level. Useful for ensuring consistent volume across different videos.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'number',
            description: 'Target loudness in LUFS (Loudness Units relative to Full Scale). Standard values: -23 (broadcast), -16 (streaming).',
            default: -16
          }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'audio_delay',
      description: 'Delay audio by a specified amount of time. Useful for syncing audio with video.',
      parameters: {
        type: 'object',
        properties: {
          delay: {
            type: 'number',
            description: 'Delay time in milliseconds. Positive values delay the audio.',
            default: 0
          }
        },
        required: ['delay']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'resize_video_preset',
      description: 'Resize video to a preset aspect ratio optimized for specific social media platforms and use cases. The video will be scaled to fit the preset dimensions while maintaining aspect ratio, with padding added if needed.',
      parameters: {
        type: 'object',
        properties: {
          preset: {
            type: 'string',
            description: 'The aspect ratio preset to use.',
            enum: ['9:16', '16:9', '1:1', '2:3', '3:2']
          }
        },
        required: ['preset']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_brightness',
      description: 'Adjust the brightness level of the video. Can be used to make the video lighter or darker.',
      parameters: {
        type: 'object',
        properties: {
          brightness: {
            type: 'number',
            description: 'Brightness adjustment value. Range: -1.0 to 1.0. Negative values darken the video, positive values brighten it. 0 means no change.'
          }
        },
        required: ['brightness']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_hue',
      description: 'Rotate the hue (color) of the video. Shifts all colors by the specified angle on the color wheel.',
      parameters: {
        type: 'object',
        properties: {
          degrees: {
            type: 'number',
            description: 'Hue rotation angle in degrees. Range: -360 to 360. 0 means no change, 180 inverts colors.'
          }
        },
        required: ['degrees']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_saturation',
      description: 'Adjust the color saturation (intensity) of the video. Can make colors more vivid or more muted.',
      parameters: {
        type: 'object',
        properties: {
          saturation: {
            type: 'number',
            description: 'Saturation multiplier. Range: 0 to 3. Values < 1 desaturate (0 = grayscale), values > 1 oversaturate, 1 = no change.'
          }
        },
        required: ['saturation']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_video_dimensions',
      description: 'Get the dimensions (width and height) and other metadata of the video such as duration, codec, and frame rate.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'convert_video_format',
      description: 'Convert video from one format to another. Supports common formats like mp4, webm, mov, avi, mkv, flv, etc.',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: 'The target format to convert to (e.g., "mp4", "webm", "mov", "avi", "mkv").',
            enum: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv']
          },
          codec: {
            type: 'string',
            description: 'Optional: Video codec to use. Common codecs: "libx264" (H.264), "libx265" (H.265), "libvpx-vp9" (VP9 for WebM).',
            default: 'auto'
          }
        },
        required: ['format']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'convert_audio_format',
      description: 'Convert audio file from one format to another. Supports formats like mp3, wav, aac, ogg, flac, m4a, etc.',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: 'The target audio format to convert to (e.g., "mp3", "wav", "aac", "ogg", "flac", "m4a").',
            enum: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma']
          },
          bitrate: {
            type: 'string',
            description: 'Optional: Audio bitrate (e.g., "128k", "192k", "320k"). Higher bitrate = better quality.',
            default: '192k'
          }
        },
        required: ['format']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'extract_audio',
      description: 'Extract audio track from a video file and save it as an audio file. Useful for getting just the audio from a video.',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: 'The audio format to extract to (e.g., "mp3", "wav", "aac", "ogg").',
            enum: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'],
            default: 'mp3'
          },
          bitrate: {
            type: 'string',
            description: 'Optional: Audio bitrate (e.g., "128k", "192k", "320k").',
            default: '192k'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_video_transition',
      description: 'Add professional transitions between multiple video clips that the user has uploaded. This creates smooth scene transitions in vlogs, professional-looking montages, and educational content with multiple segments. Supports fade, crossfade, wipe (horizontal/vertical), slide, and dissolve transitions. IMPORTANT: The user must upload multiple videos first before this tool can be used. The system will automatically use all uploaded videos.',
      parameters: {
        type: 'object',
        properties: {
          transition: {
            type: 'string',
            description: 'Type of transition to apply between clips.',
            enum: ['crossfade', 'fade', 'dissolve', 'wipe_left', 'wipe_right', 'wipe_up', 'wipe_down', 'slide_left', 'slide_right', 'slide_up', 'slide_down']
          },
          duration: {
            type: 'number',
            description: 'Duration of each transition in seconds. Default is 1 second.',
            default: 1
          }
        },
        required: ['transition']
      }
    }
  }
];

export const systemPrompt = 'You are a helpful video and audio editing assistant. Use the provided tools to apply filters and edits to the uploaded video or audio. Respond with descriptions of actions and call tools when appropriate to perform the edits.';
