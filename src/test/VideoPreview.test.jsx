import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VideoPreview from '../VideoPreview.jsx';

// Mock HTMLMediaElement methods
beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

describe('VideoPreview Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders video preview with title', () => {
    render(<VideoPreview videoUrl="test-video.mp4" title="Test Video" />);
    expect(screen.getByText('Test Video')).toBeInTheDocument();
  });

  it('renders default title when not provided', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByText('Video Preview')).toBeInTheDocument();
  });

  it('renders collapse/expand button', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByText(/Collapse/)).toBeInTheDocument();
  });

  it('is expanded by default when defaultCollapsed is not provided', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    const video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(screen.getByText(/Collapse/)).toBeInTheDocument();
  });

  it('is collapsed by default when defaultCollapsed is true', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" defaultCollapsed={true} />);
    const video = container.querySelector('video');
    expect(video).not.toBeInTheDocument();
    expect(screen.getByText(/Expand/)).toBeInTheDocument();
  });

  it('toggles between collapsed and expanded states when button is clicked', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    
    // Initially expanded
    let video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    
    // Click to collapse
    const toggleButton = screen.getByText(/Collapse/);
    fireEvent.click(toggleButton);
    
    // Should be collapsed now
    video = container.querySelector('video');
    expect(video).not.toBeInTheDocument();
    expect(screen.getByText(/Expand/)).toBeInTheDocument();
    
    // Click to expand again
    fireEvent.click(screen.getByText(/Expand/));
    
    // Should be expanded again
    video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(screen.getByText(/Collapse/)).toBeInTheDocument();
  });

  it('renders video element with correct source', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    const video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(video.src).toContain('test-video.mp4');
  });

  it('renders play button', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByText(/Play/)).toBeInTheDocument();
  });

  it('renders frame forward and backward buttons', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByText(/◀ Frame/)).toBeInTheDocument();
    expect(screen.getByText(/Frame ▶/)).toBeInTheDocument();
  });

  it('renders range slider for video scrubbing', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    const slider = container.querySelector('input[type="range"]');
    expect(slider).toBeInTheDocument();
  });

  it('renders FPS selector with default value of 30', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    const fpsSelect = container.querySelector('select');
    expect(fpsSelect).toBeInTheDocument();
    expect(fpsSelect.value).toBe('30');
  });

  it('displays frame information', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByText(/Frame:/)).toBeInTheDocument();
  });

  it('displays time information', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByText(/Time:/)).toBeInTheDocument();
  });

  it('allows FPS selection change', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    const fpsSelect = container.querySelector('select');
    
    fireEvent.change(fpsSelect, { target: { value: '60' } });
    
    expect(fpsSelect.value).toBe('60');
  });

  it('disables frame backward button at start', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    const frameBackwardButton = screen.getByText(/◀ Frame/);
    expect(frameBackwardButton).toBeDisabled();
  });

  it('renders all FPS options', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    const options = container.querySelectorAll('select option');
    expect(options).toHaveLength(4);
    expect(options[0].value).toBe('24');
    expect(options[1].value).toBe('25');
    expect(options[2].value).toBe('30');
    expect(options[3].value).toBe('60');
  });
});
