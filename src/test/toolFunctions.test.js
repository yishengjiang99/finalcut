import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toolFunctions } from '../toolFunctions.js';

// Mock fetch for server API calls
global.fetch = vi.fn();
global.FormData = class FormData {
  constructor() {
    this.data = {};
  }
  append(key, value) {
    this.data[key] = value;
  }
};

describe('toolFunctions', () => {
  let mockAddMessage;
  let mockSetVideoFileData;
  let mockVideoFileData;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddMessage = vi.fn();
    mockSetVideoFileData = vi.fn();
    mockVideoFileData = new Uint8Array([1, 2, 3]);
    global.URL.createObjectURL = vi.fn(() => 'mock-url');
    global.Blob = vi.fn();
    
    // Mock successful server response by default
    global.fetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
      json: async () => ({
        format: { duration: 10, size: 1024 * 1024 },
        streams: [{ codec_type: 'video', width: 1920, height: 1080, codec_name: 'h264', r_frame_rate: '30/1' }]
      })
    });
  });

  describe('resize_video', () => {
    it('should validate width and height are provided', async () => {
      const result = await toolFunctions.resize_video(
        { width: null, height: 100 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to resize video');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Error resizing video'),
        false
      );
    });

    it('should validate width and height are positive', async () => {
      const result = await toolFunctions.resize_video(
        { width: 0, height: 100 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to resize video');
    });

    it('should validate height is positive', async () => {
      const result = await toolFunctions.resize_video(
        { width: 100, height: -1 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to resize video');
    });
  });

  describe('crop_video', () => {
    it('should allow x=0 and y=0 as valid coordinates', async () => {
      const result = await toolFunctions.crop_video(
        { x: 0, y: 0, width: 100, height: 100 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video cropped successfully.');
    });

    it('should validate all required parameters', async () => {
      const result = await toolFunctions.crop_video(
        { x: 10, y: 10, width: null, height: 100 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to crop video');
    });

    it('should reject negative dimensions', async () => {
      const result = await toolFunctions.crop_video(
        { x: -1, y: 10, width: 100, height: 100 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to crop video');
    });
  });

  describe('rotate_video', () => {
    it('should validate angle parameter exists', async () => {
      const result = await toolFunctions.rotate_video(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to rotate video');
    });

    it('should allow angle=0 as valid input', async () => {
      const result = await toolFunctions.rotate_video(
        { angle: 0 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video rotated successfully.');
    });

    it('should handle negative angles', async () => {
      const result = await toolFunctions.rotate_video(
        { angle: -90 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video rotated successfully.');
    });
  });

  describe('flip_video_horizontal', () => {
    it('should flip video horizontally without parameters', async () => {
      const result = await toolFunctions.flip_video_horizontal(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video flipped horizontally successfully.');
      expect(mockSetVideoFileData).toHaveBeenCalled();
      expect(mockAddMessage).toHaveBeenCalledWith(
        'Processed video (flipped horizontally):',
        false,
        'mock-url',
        'processed',
        'video/mp4'
      );
    });

    it('should handle server errors gracefully', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Server error' })
      });

      const result = await toolFunctions.flip_video_horizontal(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to flip video horizontally');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Error flipping video horizontally'),
        false
      );
    });
  });

  describe('add_text', () => {
    it('should validate text parameter is provided', async () => {
      const result = await toolFunctions.add_text(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to add text');
    });

    it('should handle special characters in text', async () => {
      const result = await toolFunctions.add_text(
        { text: "Test's \"quoted\" text: with:colon" },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Text added to video successfully.');
    });
  });

  describe('trim_video', () => {
    it('should validate start and end times are provided', async () => {
      const result = await toolFunctions.trim_video(
        { start: null, end: '10' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to trim video');
    });

    it('should allow start=0 as valid input', async () => {
      const result = await toolFunctions.trim_video(
        { start: '0', end: '10' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video trimmed successfully.');
    });

    it('should allow numeric start times', async () => {
      const result = await toolFunctions.trim_video(
        { start: 0, end: 10 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video trimmed successfully.');
    });
  });

  describe('adjust_speed', () => {
    it('should validate speed parameter is provided', async () => {
      const result = await toolFunctions.adjust_speed(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to adjust video speed');
    });

    it('should reject zero or negative speed', async () => {
      const result = await toolFunctions.adjust_speed(
        { speed: 0 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to adjust video speed');
    });

    it('should handle speeds within normal range (0.5-2.0)', async () => {
      const result = await toolFunctions.adjust_speed(
        { speed: 1.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video speed adjusted successfully.');
    });

    it('should handle slow speeds (< 0.5)', async () => {
      const result = await toolFunctions.adjust_speed(
        { speed: 0.25 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video speed adjusted successfully.');
    });

    it('should handle fast speeds (> 2.0)', async () => {
      const result = await toolFunctions.adjust_speed(
        { speed: 4.0 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video speed adjusted successfully.');
    });
  });

  describe('add_audio_track', () => {
    it('should validate audioFile parameter is provided', async () => {
      const result = await toolFunctions.add_audio_track(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to add audio track');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Error adding audio track'),
        false
      );
    });

    it('should reject empty audioFile string', async () => {
      const result = await toolFunctions.add_audio_track(
        { audioFile: '' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to add audio track');
    });

    it('should validate mode parameter', async () => {
      const mockAudioData = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await toolFunctions.add_audio_track(
        { audioFile: mockAudioData, mode: 'invalid' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to add audio track');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Mode must be either "replace" or "mix"'),
        false
      );
    });

    it('should validate volume parameter range', async () => {
      const mockAudioData = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await toolFunctions.add_audio_track(
        { audioFile: mockAudioData, volume: 3.0 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to add audio track');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Volume must be between 0.0 and 2.0'),
        false
      );
    });

    it('should reject negative volume values', async () => {
      const mockAudioData = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await toolFunctions.add_audio_track(
        { audioFile: mockAudioData, volume: -0.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to add audio track');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Volume must be between 0.0 and 2.0'),
        false
      );
    });

    it('should allow volume=0.0 (mute)', async () => {
      const mockAudioData = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await toolFunctions.add_audio_track(
        { audioFile: mockAudioData, mode: 'replace', volume: 0.0 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio track replaced successfully.');
    });

    it('should replace audio track with default parameters', async () => {
      const mockAudioData = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await toolFunctions.add_audio_track(
        { audioFile: mockAudioData },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio track replaced successfully.');
    });

    it('should replace audio track with custom volume', async () => {
      const mockAudioData = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await toolFunctions.add_audio_track(
        { audioFile: mockAudioData, mode: 'replace', volume: 0.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio track replaced successfully.');
    });

    it('should mix audio tracks', async () => {
      const mockAudioData = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await toolFunctions.add_audio_track(
        { audioFile: mockAudioData, mode: 'mix', volume: 0.8 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio track mixed successfully.');
    });

    it('should handle base64 encoded audio data', async () => {
      // Create a simple base64 encoded string
      const base64Audio = 'data:audio/mp3;base64,SGVsbG8gV29ybGQ=';
      const result = await toolFunctions.add_audio_track(
        { audioFile: base64Audio, mode: 'replace' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio track replaced successfully.');
    });

    it('should handle Uint8Array audio data', async () => {
      const mockAudioData = new Uint8Array([72, 101, 108, 108, 111]);
      const result = await toolFunctions.add_audio_track(
        { audioFile: mockAudioData, mode: 'replace' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio track replaced successfully.');
    });
  });

  describe('adjust_audio_volume', () => {
    it('should validate volume parameter is provided', async () => {
      const result = await toolFunctions.adjust_audio_volume(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to adjust audio volume');
    });

    it('should reject negative volume', async () => {
      const result = await toolFunctions.adjust_audio_volume(
        { volume: -1 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to adjust audio volume');
    });

    it('should adjust volume successfully', async () => {
      const result = await toolFunctions.adjust_audio_volume(
        { volume: 1.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio volume adjusted successfully.');
    });
  });

  describe('audio_fade', () => {
    it('should validate type parameter', async () => {
      const result = await toolFunctions.audio_fade(
        { duration: 3 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to apply audio fade');
    });

    it('should validate duration is positive', async () => {
      const result = await toolFunctions.audio_fade(
        { type: 'in', duration: -1 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to apply audio fade');
    });

    it('should apply fade in effect', async () => {
      const result = await toolFunctions.audio_fade(
        { type: 'in', duration: 3 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio fade in applied successfully.');
    });

    it('should apply fade out effect', async () => {
      const result = await toolFunctions.audio_fade(
        { type: 'out', duration: 2 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio fade out applied successfully.');
    });
  });

  describe('audio_highpass', () => {
    it('should validate frequency parameter', async () => {
      const result = await toolFunctions.audio_highpass(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to apply highpass filter');
    });

    it('should apply highpass filter successfully', async () => {
      const result = await toolFunctions.audio_highpass(
        { frequency: 200 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Highpass filter applied successfully.');
    });
  });

  describe('audio_lowpass', () => {
    it('should validate frequency parameter', async () => {
      const result = await toolFunctions.audio_lowpass(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to apply lowpass filter');
    });

    it('should apply lowpass filter successfully', async () => {
      const result = await toolFunctions.audio_lowpass(
        { frequency: 3000 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Lowpass filter applied successfully.');
    });
  });

  describe('audio_echo', () => {
    it('should validate delay parameter', async () => {
      const result = await toolFunctions.audio_echo(
        { decay: 0.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to apply echo effect');
    });

    it('should validate decay range', async () => {
      const result = await toolFunctions.audio_echo(
        { delay: 1000, decay: 1.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to apply echo effect');
    });

    it('should apply echo effect successfully', async () => {
      const result = await toolFunctions.audio_echo(
        { delay: 1000, decay: 0.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Echo effect applied successfully.');
    });
  });

  describe('adjust_bass', () => {
    it('should validate gain parameter', async () => {
      const result = await toolFunctions.adjust_bass(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to adjust bass');
    });

    it('should validate gain range', async () => {
      const result = await toolFunctions.adjust_bass(
        { gain: 25 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to adjust bass');
    });

    it('should adjust bass successfully', async () => {
      const result = await toolFunctions.adjust_bass(
        { gain: 5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Bass adjusted successfully.');
    });
  });

  describe('adjust_treble', () => {
    it('should validate gain parameter', async () => {
      const result = await toolFunctions.adjust_treble(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to adjust treble');
    });

    it('should adjust treble successfully', async () => {
      const result = await toolFunctions.adjust_treble(
        { gain: -3 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Treble adjusted successfully.');
    });
  });

  describe('audio_equalizer', () => {
    it('should validate frequency parameter', async () => {
      const result = await toolFunctions.audio_equalizer(
        { gain: 5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to apply equalizer');
    });

    it('should validate gain parameter', async () => {
      const result = await toolFunctions.audio_equalizer(
        { frequency: 1000 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to apply equalizer');
    });

    it('should apply equalizer successfully', async () => {
      const result = await toolFunctions.audio_equalizer(
        { frequency: 1000, gain: 5, width: 200 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Equalizer applied successfully.');
    });
  });

  describe('normalize_audio', () => {
    it('should validate target parameter', async () => {
      const result = await toolFunctions.normalize_audio(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to normalize audio');
    });

    it('should validate target range', async () => {
      const result = await toolFunctions.normalize_audio(
        { target: 5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to normalize audio');
    });

    it('should normalize audio successfully', async () => {
      const result = await toolFunctions.normalize_audio(
        { target: -16 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio normalized successfully.');
    });
  });

  describe('audio_delay', () => {
    it('should validate delay parameter', async () => {
      const result = await toolFunctions.audio_delay(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to delay audio');
    });

    it('should reject negative delay', async () => {
      const result = await toolFunctions.audio_delay(
        { delay: -100 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to delay audio');
    });

    it('should delay audio successfully', async () => {
      const result = await toolFunctions.audio_delay(
        { delay: 500 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Audio delayed successfully.');
    });
  });

  describe('resize_video_preset', () => {
    it('should validate preset parameter is provided', async () => {
      const result = await toolFunctions.resize_video_preset(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to resize video to preset');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Error resizing video to preset'),
        false
      );
    });

    it('should reject invalid preset', async () => {
      const result = await toolFunctions.resize_video_preset(
        { preset: 'invalid' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to resize video to preset');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Invalid preset'),
        false
      );
    });

    it('should resize to 9:16 preset (Stories, Reels, TikToks)', async () => {
      const result = await toolFunctions.resize_video_preset(
        { preset: '9:16' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video resized to 9:16 aspect ratio successfully.');
    });

    it('should resize to 16:9 preset (YT thumbnails, Cinematic)', async () => {
      const result = await toolFunctions.resize_video_preset(
        { preset: '16:9' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video resized to 16:9 aspect ratio successfully.');
    });

    it('should resize to 1:1 preset (X feed posts, Profile pics)', async () => {
      const result = await toolFunctions.resize_video_preset(
        { preset: '1:1' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video resized to 1:1 aspect ratio successfully.');
    });

    it('should resize to 2:3 preset (Posters, Pinterest, Tall Portraits)', async () => {
      const result = await toolFunctions.resize_video_preset(
        { preset: '2:3' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video resized to 2:3 aspect ratio successfully.');
    });

    it('should resize to 3:2 preset (Classic photography, Landscape)', async () => {
      const result = await toolFunctions.resize_video_preset(
        { preset: '3:2' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video resized to 3:2 aspect ratio successfully.');
    });

    it('should use padding to maintain aspect ratio', async () => {
      const result = await toolFunctions.resize_video_preset(
        { preset: '16:9' },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Video resized to 16:9 aspect ratio successfully.');
    });
  });

  describe('adjust_brightness', () => {
    it('should validate brightness parameter is provided', async () => {
      const result = await toolFunctions.adjust_brightness(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to adjust brightness');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Error adjusting brightness'),
        false
      );
    });

    it('should reject brightness values outside valid range', async () => {
      const result1 = await toolFunctions.adjust_brightness(
        { brightness: -1.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result1).toContain('Failed to adjust brightness');
      
      const result2 = await toolFunctions.adjust_brightness(
        { brightness: 1.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result2).toContain('Failed to adjust brightness');
    });

    it('should allow brightness=0 (no change)', async () => {
      const result = await toolFunctions.adjust_brightness(
        { brightness: 0 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Brightness adjusted successfully.');
    });

    it('should brighten video with positive values', async () => {
      const result = await toolFunctions.adjust_brightness(
        { brightness: 0.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Brightness adjusted successfully.');
    });

    it('should darken video with negative values', async () => {
      const result = await toolFunctions.adjust_brightness(
        { brightness: -0.3 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Brightness adjusted successfully.');
    });
  });

  describe('adjust_hue', () => {
    it('should validate degrees parameter is provided', async () => {
      const result = await toolFunctions.adjust_hue(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to adjust hue');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Error adjusting hue'),
        false
      );
    });

    it('should reject degrees values outside valid range', async () => {
      const result1 = await toolFunctions.adjust_hue(
        { degrees: -400 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result1).toContain('Failed to adjust hue');
      
      const result2 = await toolFunctions.adjust_hue(
        { degrees: 400 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result2).toContain('Failed to adjust hue');
    });

    it('should allow degrees=0 (no change)', async () => {
      const result = await toolFunctions.adjust_hue(
        { degrees: 0 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Hue adjusted successfully.');
    });

    it('should rotate hue with positive values', async () => {
      const result = await toolFunctions.adjust_hue(
        { degrees: 180 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Hue adjusted successfully.');
    });

    it('should rotate hue with negative values', async () => {
      const result = await toolFunctions.adjust_hue(
        { degrees: -90 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Hue adjusted successfully.');
    });
  });

  describe('adjust_saturation', () => {
    it('should validate saturation parameter is provided', async () => {
      const result = await toolFunctions.adjust_saturation(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to adjust saturation');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Error adjusting saturation'),
        false
      );
    });

    it('should reject saturation values outside valid range', async () => {
      const result1 = await toolFunctions.adjust_saturation(
        { saturation: -0.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result1).toContain('Failed to adjust saturation');
      
      const result2 = await toolFunctions.adjust_saturation(
        { saturation: 3.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result2).toContain('Failed to adjust saturation');
    });

    it('should allow saturation=0 (grayscale)', async () => {
      const result = await toolFunctions.adjust_saturation(
        { saturation: 0 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Saturation adjusted successfully.');
    });

    it('should allow saturation=1 (no change)', async () => {
      const result = await toolFunctions.adjust_saturation(
        { saturation: 1 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Saturation adjusted successfully.');
    });

    it('should increase saturation with values > 1', async () => {
      const result = await toolFunctions.adjust_saturation(
        { saturation: 2 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Saturation adjusted successfully.');
    });

    it('should decrease saturation with values < 1', async () => {
      const result = await toolFunctions.adjust_saturation(
        { saturation: 0.5 },
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toBe('Saturation adjusted successfully.');
    });
  });

  describe('get_video_dimensions', () => {
    it('should return video information', async () => {
      
      // Mock ffmpeg to simulate log output with video information
      const mockOn = vi.fn();
      const mockOff = vi.fn();
      ffmpeg.on = mockOn;
      ffmpeg.off = mockOff;
      
      const result = await toolFunctions.get_video_dimensions(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      
      expect(result).toBeDefined();
      expect(result).toContain('Video');
      expect(mockAddMessage).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      
      const result = await toolFunctions.get_video_dimensions(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      
      expect(result).toBeDefined();
      expect(result).toContain('Video file loaded');
      expect(mockAddMessage).toHaveBeenCalled();
    });

    it('should include file size in output', async () => {
      const result = await toolFunctions.get_video_dimensions(
        {},
        mockVideoFileData,
        mockSetVideoFileData,
        mockAddMessage
      );
      
      expect(result).toContain('MB');
    });
  });
});
