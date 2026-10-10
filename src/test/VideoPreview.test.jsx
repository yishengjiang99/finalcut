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

  it('renders collapse button', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByLabelText(/collapse preview/i)).toBeInTheDocument();
  });

  it('is expanded by default when defaultCollapsed is not provided', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    const video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(screen.getByLabelText(/collapse preview/i)).toBeInTheDocument();
  });

  it('is collapsed by default when defaultCollapsed is true', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" defaultCollapsed={true} />);
    const video = container.querySelector('video');
    expect(video).not.toBeInTheDocument();
    expect(screen.getByLabelText(/expand preview/i)).toBeInTheDocument();
  });

  it('toggles between collapsed and expanded states when button is clicked', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);

    // Initially expanded
    let video = container.querySelector('video');
    expect(video).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByLabelText(/collapse preview/i));

    // Should be collapsed now (mini bar, no video element)
    video = container.querySelector('video');
    expect(video).not.toBeInTheDocument();
    expect(screen.getByLabelText(/expand preview/i)).toBeInTheDocument();

    // Click to expand again
    fireEvent.click(screen.getByLabelText(/expand preview/i));

    // Should be expanded again
    video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(screen.getByLabelText(/collapse preview/i)).toBeInTheDocument();
  });

  it('mini bar play button expands the preview', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" defaultCollapsed={true} />);
    expect(container.querySelector('video')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/^play$/i));
    expect(container.querySelector('video')).toBeInTheDocument();
  });

  it('renders video element with correct source', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    const video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(video.src).toContain('test-video.mp4');
  });

  it('renders play button', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByLabelText(/^play$/i)).toBeInTheDocument();
  });

  it('renders frame forward and backward buttons', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByLabelText(/step back one frame/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/step forward one frame/i)).toBeInTheDocument();
  });

  it('shows burned-webm download state for caption preview', () => {
    render(<VideoPreview videoUrl="test-video.mp4" vttUrl="test-captions.vtt" />);
    const downloadButton = screen.getByRole('button', { name: /Preparing Burned WebM/i });
    expect(downloadButton).toBeDisabled();
  });

  it('hides manual recording controls when caption track is present', () => {
    render(<VideoPreview videoUrl="test-video.mp4" vttUrl="test-captions.vtt" />);
    expect(screen.queryByText(/Start Recording/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Stop Recording/i)).not.toBeInTheDocument();
  });

  it('renders range slider for video scrubbing', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    const slider = container.querySelector('input[type="range"]');
    expect(slider).toBeInTheDocument();
  });

  it('renders FPS chip with default value of 30', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByText('30 fps')).toBeInTheDocument();
  });

  it('cycles FPS through 24/25/30/60 when the chip is clicked', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    fireEvent.click(screen.getByText('30 fps'));
    expect(screen.getByText('60 fps')).toBeInTheDocument();
    fireEvent.click(screen.getByText('60 fps'));
    expect(screen.getByText('24 fps')).toBeInTheDocument();
    fireEvent.click(screen.getByText('24 fps'));
    expect(screen.getByText('25 fps')).toBeInTheDocument();
  });

  it('displays frame information', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByText(/F 0 \/ 0/)).toBeInTheDocument();
  });

  it('displays time information', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByText(/00:00\.00/)).toBeInTheDocument();
  });

  it('disables frame backward button at start', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    expect(screen.getByLabelText(/step back one frame/i)).toBeDisabled();
  });
});
