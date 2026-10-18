import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import VideoPreview from '../VideoPreview.jsx';
import CaptionPanel from '../CaptionPanel.jsx';
import { normalizeStyle } from '../captionTrack.js';

beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

const lines = [{ start: 1, end: 3, text: 'Hello there', translation: '你好' }];
const trackWith = (style) => ({ id: 't1', lines, language: 'en', targetLanguage: 'zh-Hans', style: normalizeStyle(style) });
const at = (video, t) => { Object.defineProperty(video, 'currentTime', { value: t, configurable: true }); act(() => { fireEvent(video, new Event('timeupdate')); }); };

describe('live caption overlay on the preview', () => {
  it('shows the active line over the video at the right time, positioned by the style', () => {
    const { container } = render(<VideoPreview videoUrl="v.mp4" captionTrack={trackWith({ positionFromBottomPct: 30 })} />);
    fireEvent.click(screen.getByRole('button', { name: /open video/i }));
    const video = container.querySelector('video');
    expect(screen.queryByTestId('caption-overlay')).toBeNull();
    at(video, 2);
    const overlay = screen.getByTestId('caption-overlay');
    expect(overlay).toHaveTextContent('Hello there');
    expect(overlay).toHaveTextContent('你好');
    expect(overlay.style.bottom).toBe('30%');
    at(video, 5);
    expect(screen.queryByTestId('caption-overlay')).toBeNull();
  });

  it('a style change moves and resizes the overlay live', () => {
    const { container, rerender } = render(<VideoPreview videoUrl="v.mp4" captionTrack={trackWith({ positionFromBottomPct: 20, sizeScale: 1 })} />);
    fireEvent.click(screen.getByRole('button', { name: /open video/i }));
    at(container.querySelector('video'), 2);
    const small = parseFloat(screen.getByTestId('caption-overlay').style.fontSize);
    rerender(<VideoPreview videoUrl="v.mp4" captionTrack={trackWith({ positionFromBottomPct: 40, sizeScale: 1.8 })} />);
    const overlay = screen.getByTestId('caption-overlay');
    expect(overlay.style.bottom).toBe('40%');
    expect(parseFloat(overlay.style.fontSize)).toBeGreaterThan(small);
  });

  it('without a track there is no overlay', () => {
    const { container } = render(<VideoPreview videoUrl="v.mp4" />);
    fireEvent.click(screen.getByRole('button', { name: /open video/i }));
    at(container.querySelector('video'), 2);
    expect(screen.queryByTestId('caption-overlay')).toBeNull();
  });
});

describe('caption panel', () => {
  it('reports position and size changes and offers export, SRT, ASS and remove', () => {
    const calls = { style: [], export: 0, srt: 0, ass: 0, remove: 0 };
    render(<CaptionPanel track={trackWith()} onStyle={(p) => calls.style.push(p)} onExport={() => { calls.export += 1; }} onSrt={() => { calls.srt += 1; }} onAss={() => { calls.ass += 1; }} onRemove={() => { calls.remove += 1; }} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '33' } });
    fireEvent.click(screen.getByRole('button', { name: 'Large' }));
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('button', { name: /SRT/ }));
    fireEvent.click(screen.getByRole('button', { name: /ASS/ }));
    fireEvent.click(screen.getByRole('button', { name: /Remove captions/ }));
    expect(calls).toEqual({ style: [{ positionFromBottomPct: 33 }, { sizeScale: 1.4 }], export: 1, srt: 1, ass: 1, remove: 1 });
    expect(screen.getByText(/burned into the video when you export/i)).toBeInTheDocument();
  });
});
