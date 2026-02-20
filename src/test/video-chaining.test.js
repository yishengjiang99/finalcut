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

// Helper: create a streaming response mock from an ArrayBuffer or Uint8Array
function makeStreamResponse(data) {
  const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  let consumed = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (!consumed) { consumed = true; return { done: false, value: uint8 }; }
          return { done: true, value: undefined };
        }
      })
    },
    arrayBuffer: async () => uint8.buffer
  };
}

describe('Video Editing Chaining', () => {
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
    global.fetch.mockResolvedValue(makeStreamResponse(new ArrayBuffer(8)));
  });

  it('should call setVideoFileData after resize_video', async () => {
    await toolFunctions.resize_video(
      { width: 640, height: 480 },
      mockVideoFileData,
      mockSetVideoFileData,
      mockAddMessage
    );
    
    expect(mockSetVideoFileData).toHaveBeenCalled();
    expect(mockSetVideoFileData).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('should call setVideoFileData after crop_video', async () => {
    await toolFunctions.crop_video(
      { x: 0, y: 0, width: 100, height: 100 },
      mockVideoFileData,
      mockSetVideoFileData,
      mockAddMessage
    );
    
    expect(mockSetVideoFileData).toHaveBeenCalled();
  });

  it('should call setVideoFileData after trim_video', async () => {
    await toolFunctions.trim_video(
      { start: 0, end: 5 },
      mockVideoFileData,
      mockSetVideoFileData,
      mockAddMessage
    );
    
    expect(mockSetVideoFileData).toHaveBeenCalled();
  });

  it('should call setVideoFileData after adjust_volume', async () => {
    await toolFunctions.adjust_volume(
      { volume: 1.5 },
      mockVideoFileData,
      mockSetVideoFileData,
      mockAddMessage
    );
    
    expect(mockSetVideoFileData).toHaveBeenCalled();
  });

  it('should call setVideoFileData after adjust_brightness', async () => {
    await toolFunctions.adjust_brightness(
      { brightness: 0.5 },
      mockVideoFileData,
      mockSetVideoFileData,
      mockAddMessage
    );
    
    expect(mockSetVideoFileData).toHaveBeenCalled();
  });

  it('should allow chaining edits by updating video data', async () => {
    // First edit - resize
    const processedData1 = new Uint8Array([4, 5, 6]);
    global.fetch.mockResolvedValueOnce(makeStreamResponse(processedData1));
    
    await toolFunctions.resize_video(
      { width: 640, height: 480 },
      mockVideoFileData,
      mockSetVideoFileData,
      mockAddMessage
    );
    
    expect(mockSetVideoFileData).toHaveBeenCalledWith(processedData1);
    
    // Second edit - crop (would use the processed data from resize)
    const processedData2 = new Uint8Array([7, 8, 9]);
    global.fetch.mockResolvedValueOnce(makeStreamResponse(processedData2));
    
    // Simulate using the processed data
    const updatedVideoData = mockSetVideoFileData.mock.calls[0][0];
    
    await toolFunctions.crop_video(
      { x: 0, y: 0, width: 320, height: 240 },
      updatedVideoData,
      mockSetVideoFileData,
      mockAddMessage
    );
    
    expect(mockSetVideoFileData).toHaveBeenCalledTimes(2);
    expect(mockSetVideoFileData).toHaveBeenLastCalledWith(processedData2);
  });
});
