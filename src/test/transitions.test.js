import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toolFunctions } from '../toolFunctions.js';

// Mock fetch for server API calls
global.fetch = vi.fn();
global.FormData = class FormData {
  constructor() {
    this.data = {};
    this.files = [];
  }
  append(key, value, filename) {
    if (!this.data[key]) {
      this.data[key] = [];
    }
    this.data[key].push({ value, filename });
  }
};

describe('Video Transitions', () => {
  let mockAddMessage;
  let mockSetVideoFileData;
  let mockVideoFileData1;
  let mockVideoFileData2;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddMessage = vi.fn();
    mockSetVideoFileData = vi.fn();
    mockVideoFileData1 = new Uint8Array([1, 2, 3, 4]);
    mockVideoFileData2 = new Uint8Array([5, 6, 7, 8]);
    global.URL.createObjectURL = vi.fn(() => 'mock-url');
    global.Blob = vi.fn();
    
    // Mock successful server response by default
    global.fetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(16)
    });
  });

  describe('add_video_transition', () => {
    it('should require at least two videos', async () => {
      const result = await toolFunctions.add_video_transition(
        { videos: [mockVideoFileData1], transition: 'crossfade' },
        mockVideoFileData1,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to apply video transition');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('At least two video clips are required'),
        false
      );
    });

    it('should require transition type', async () => {
      const result = await toolFunctions.add_video_transition(
        { videos: [mockVideoFileData1, mockVideoFileData2] },
        mockVideoFileData1,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Failed to apply video transition');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Transition type is required'),
        false
      );
    });

    it('should successfully apply crossfade transition', async () => {
      const result = await toolFunctions.add_video_transition(
        { 
          videos: [mockVideoFileData1, mockVideoFileData2], 
          transition: 'crossfade',
          duration: 2
        },
        mockVideoFileData1,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Video transition (crossfade) applied successfully');
      expect(mockSetVideoFileData).toHaveBeenCalled();
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('crossfade transition'),
        false,
        'mock-url',
        'processed',
        'video/mp4'
      );
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/transition-videos',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should successfully apply fade transition', async () => {
      const result = await toolFunctions.add_video_transition(
        { 
          videos: [mockVideoFileData1, mockVideoFileData2], 
          transition: 'fade'
        },
        mockVideoFileData1,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Video transition (fade) applied successfully');
    });

    it('should successfully apply wipe_left transition', async () => {
      const result = await toolFunctions.add_video_transition(
        { 
          videos: [mockVideoFileData1, mockVideoFileData2], 
          transition: 'wipe_left',
          duration: 1.5
        },
        mockVideoFileData1,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Video transition (wipe_left) applied successfully');
    });

    it('should successfully apply slide_right transition', async () => {
      const result = await toolFunctions.add_video_transition(
        { 
          videos: [mockVideoFileData1, mockVideoFileData2], 
          transition: 'slide_right'
        },
        mockVideoFileData1,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Video transition (slide_right) applied successfully');
    });

    it('should successfully apply dissolve transition', async () => {
      const result = await toolFunctions.add_video_transition(
        { 
          videos: [mockVideoFileData1, mockVideoFileData2], 
          transition: 'dissolve'
        },
        mockVideoFileData1,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Video transition (dissolve) applied successfully');
    });

    it('should handle multiple videos (more than 2)', async () => {
      const mockVideoFileData3 = new Uint8Array([9, 10, 11, 12]);
      const result = await toolFunctions.add_video_transition(
        { 
          videos: [mockVideoFileData1, mockVideoFileData2, mockVideoFileData3], 
          transition: 'crossfade',
          duration: 1
        },
        mockVideoFileData1,
        mockSetVideoFileData,
        mockAddMessage
      );
      expect(result).toContain('Video transition (crossfade) applied successfully');
    });

    it('should use default duration of 1 second if not specified', async () => {
      await toolFunctions.add_video_transition(
        { 
          videos: [mockVideoFileData1, mockVideoFileData2], 
          transition: 'crossfade'
        },
        mockVideoFileData1,
        mockSetVideoFileData,
        mockAddMessage
      );
      
      const fetchCall = global.fetch.mock.calls[0];
      const formData = fetchCall[1].body;
      // The FormData should contain duration
      expect(formData.data.duration).toBeDefined();
    });

    it('should handle server errors gracefully', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Processing failed' })
      });

      const result = await toolFunctions.add_video_transition(
        { 
          videos: [mockVideoFileData1, mockVideoFileData2], 
          transition: 'crossfade'
        },
        mockVideoFileData1,
        mockSetVideoFileData,
        mockAddMessage
      );
      
      expect(result).toContain('Failed to apply video transition');
      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.stringContaining('Error applying video transition'),
        false
      );
    });

    it('should support all transition types', async () => {
      const transitions = [
        'crossfade', 'fade', 'dissolve', 
        'wipe_left', 'wipe_right', 'wipe_up', 'wipe_down',
        'slide_left', 'slide_right', 'slide_up', 'slide_down'
      ];

      for (const transition of transitions) {
        vi.clearAllMocks();
        global.fetch.mockResolvedValue({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(16)
        });

        const result = await toolFunctions.add_video_transition(
          { 
            videos: [mockVideoFileData1, mockVideoFileData2], 
            transition
          },
          mockVideoFileData1,
          mockSetVideoFileData,
          mockAddMessage
        );
        
        expect(result).toContain(`Video transition (${transition}) applied successfully`);
      }
    });
  });
});
