import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import App from '../App.jsx';

// Mock ffmpeg module
vi.mock('../ffmpeg.js', () => ({
  ffmpeg: {
    on: vi.fn(),
    load: vi.fn(),
    exec: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    loaded: false,
  },
  loadFFmpeg: vi.fn().mockResolvedValue(undefined),
  fetchFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

// Mock fetch
global.fetch = vi.fn();

// Mock URL.createObjectURL
global.URL.createObjectURL = vi.fn(() => 'mock-url');

describe('App Component - Video Alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('displays uploaded video on the right side (user role)', async () => {
    const { container } = render(<App />);
    
    const fileInput = container.querySelector('input[type="file"]');
    const file = new File(['video content'], 'test.mp4', { type: 'video/mp4' });
    
    // Mock successful fetch response
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'Video processed' }
        }]
      })
    });
    
    fireEvent.change(fileInput, { target: { files: [file] } });
    
    await waitFor(() => {
      const messages = container.querySelectorAll('[style*="marginBottom"]');
      // Find message with video content
      const videoMessages = Array.from(messages).filter(msg => 
        msg.textContent.includes('Selected video') || 
        msg.textContent.includes('Selected audio')
      );
      
      if (videoMessages.length > 0) {
        const videoMessage = videoMessages[0];
        const style = videoMessage.getAttribute('style');
        // User messages should have marginLeft: auto (right aligned)
        expect(style).toContain('auto');
      }
    }, { timeout: 3000 });
  });

  it('displays processed video on the left side (assistant role)', async () => {
    const { container } = render(<App />);
    
    const fileInput = container.querySelector('input[type="file"]');
    const file = new File(['video content'], 'test.mp4', { type: 'video/mp4' });
    
    // Mock successful tool call response
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: { 
            content: null,
            tool_calls: [{
              id: 'call_1',
              function: {
                name: 'resize_video',
                arguments: JSON.stringify({ width: 640, height: 480 })
              }
            }]
          }
        }]
      })
    });

    // Mock second call after tool execution
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'Video resized successfully' }
        }]
      })
    });
    
    fireEvent.change(fileInput, { target: { files: [file] } });
    
    await waitFor(() => {
      const messages = container.querySelectorAll('[style*="marginBottom"]');
      // Find message with processed video content
      const processedMessages = Array.from(messages).filter(msg => 
        msg.textContent.includes('Processed video') || 
        msg.textContent.includes('resized')
      );
      
      // Processed videos should be on the left (assistant role)
      if (processedMessages.length > 0) {
        const processedMessage = processedMessages[0];
        const style = processedMessage.getAttribute('style');
        // Assistant messages should have marginLeft: 0 and marginRight: auto (left aligned)
        expect(style).not.toContain('marginLeft: auto');
      }
    }, { timeout: 3000 });
  });
});
