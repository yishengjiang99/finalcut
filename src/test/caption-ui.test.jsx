import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import VideoPreview from '../VideoPreview.jsx';
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

describe('placement and font from the style the model chose in chat', () => {
  const overlayAt = (style) => {
    const { container } = render(<VideoPreview videoUrl="v.mp4" captionTrack={trackWith(style)} />);
    fireEvent.click(screen.getByRole('button', { name: /open video/i }));
    at(container.querySelector('video'), 2);
    return screen.getByTestId('caption-overlay');
  };
  it('bottom (Alignment 2) sits N% up, middle (5) is vertically centered, top (8) hangs from the top margin', () => {
    expect(overlayAt({ alignment: 2, positionFromBottomPct: 25 }).style.bottom).toBe('25%');
  });
  it('middle and top use top-based placement', () => {
    const mid = overlayAt({ alignment: 5 });
    expect(mid.style.top).toBe('50%');
    expect(mid.style.bottom).toBe('');
  });
  it('top', () => {
    const top = overlayAt({ alignment: 8 });
    expect(top.style.top).toBe('8%');
  });
  it('Inter is the overlay font when chosen; the CJK family otherwise', () => {
    expect(overlayAt({ font: 'Inter' }).style.fontFamily).toMatch(/^Inter/);
  });
  it('the default is the CJK family', () => {
    expect(overlayAt({}).style.fontFamily).toMatch(/Noto Sans CJK SC/);
  });
  it('there are no caption controls on the card: no style sliders or SRT/ASS/Remove buttons', () => {
    expect(document.querySelector('[data-testid="caption-panel"]')).toBeNull();
  });
});
