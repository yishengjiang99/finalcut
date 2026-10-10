import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VideoPreview from '../VideoPreview.jsx';

// Mock HTMLMediaElement methods
beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

// The preview opens as a thumbnail; click it to reach the full player.
const openPlayer = () => fireEvent.click(screen.getByRole('button', { name: /open video/i }));

describe('VideoPreview Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a thumbnail by default instead of the full player', () => {
    render(<VideoPreview videoUrl="test-video.mp4" title="Test Video" />);
    expect(screen.getByRole('button', { name: /open video: test video/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/collapse preview/i)).not.toBeInTheDocument();
  });

  it('clicking the thumbnail opens the full player', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    expect(screen.getByLabelText(/collapse preview/i)).toBeInTheDocument();
    const video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(video.src).toContain('test-video.mp4');
  });

  it('clicking the thumbnail starts playback', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('audio files skip the thumbnail', () => {
    const { container } = render(<VideoPreview videoUrl="test-audio.mp3" mimeType="audio/mp3" />);
    expect(screen.queryByRole('button', { name: /open video/i })).not.toBeInTheDocument();
    expect(container.querySelector('audio')).toBeInTheDocument();
  });

  it('renders video preview with title', () => {
    render(<VideoPreview videoUrl="test-video.mp4" title="Test Video" />);
    openPlayer();
    expect(screen.getByText('Test Video')).toBeInTheDocument();
  });

  it('renders default title when not provided', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    expect(screen.getByText('Video Preview')).toBeInTheDocument();
  });

  it('renders collapse button', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    expect(screen.getByLabelText(/collapse preview/i)).toBeInTheDocument();
  });

  it('renders transport glyphs, not literal unicode escapes', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    // The \u25B6-as-text bug: JSX text does not interpret \u escapes.
    expect(container.textContent).not.toMatch(/\\u[0-9a-fA-F]{4}/);
    expect(screen.getByLabelText(/step back one frame/i).textContent).toContain('⏮');
    expect(screen.getByLabelText(/step forward one frame/i).textContent).toContain('⏭');
  });

  it('shows the mini bar when defaultCollapsed is true after opening the thumbnail', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" defaultCollapsed={true} />);
    // Thumbnail still comes first; opening it lands on the mini bar.
    openPlayer();
    expect(container.querySelector('video')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/expand preview/i)).toBeInTheDocument();
  });

  it('toggles between collapsed and expanded states when button is clicked', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);

    // Open the thumbnail first
    openPlayer();
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
    openPlayer();
    expect(container.querySelector('video')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/^play$/i));
    expect(container.querySelector('video')).toBeInTheDocument();
  });

  it('renders video element with correct source', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    const video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(video.src).toContain('test-video.mp4');
  });

  it('tapping the playing video pauses and shows the play button', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    // Thumbnail tap autoplays: no play button while playing.
    expect(screen.queryByLabelText(/^play$/i)).not.toBeInTheDocument();
    // Tap the video surface to pause.
    const surface = container.querySelector('video').parentElement;
    fireEvent.click(surface);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(screen.getByLabelText(/^play$/i)).toBeInTheDocument();
  });

  it('renders frame forward and backward buttons', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    expect(screen.getByLabelText(/step back one frame/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/step forward one frame/i)).toBeInTheDocument();
  });

  it('shows burned-webm download state for caption preview', () => {
    render(<VideoPreview videoUrl="test-video.mp4" vttUrl="test-captions.vtt" />);
    openPlayer();
    const downloadButton = screen.getByRole('button', { name: /Preparing Burned WebM/i });
    expect(downloadButton).toBeDisabled();
  });

  it('hides manual recording controls when caption track is present', () => {
    render(<VideoPreview videoUrl="test-video.mp4" vttUrl="test-captions.vtt" />);
    openPlayer();
    expect(screen.queryByText(/Start Recording/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Stop Recording/i)).not.toBeInTheDocument();
  });

  it('renders range slider for video scrubbing', () => {
    const { container } = render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    const slider = container.querySelector('input[type="range"]');
    expect(slider).toBeInTheDocument();
  });

  it('renders FPS chip with default value of 30', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    expect(screen.getByText('30 fps')).toBeInTheDocument();
  });

  it('cycles FPS through 24/25/30/60 when the chip is clicked', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    fireEvent.click(screen.getByText('30 fps'));
    expect(screen.getByText('60 fps')).toBeInTheDocument();
    fireEvent.click(screen.getByText('60 fps'));
    expect(screen.getByText('24 fps')).toBeInTheDocument();
    fireEvent.click(screen.getByText('24 fps'));
    expect(screen.getByText('25 fps')).toBeInTheDocument();
  });

  it('displays frame information', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    expect(screen.getByText(/F 0 \/ 0/)).toBeInTheDocument();
  });

  it('displays time information', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    expect(screen.getByText(/00:00\.00/)).toBeInTheDocument();
  });

  it('disables frame backward button at start', () => {
    render(<VideoPreview videoUrl="test-video.mp4" />);
    openPlayer();
    expect(screen.getByLabelText(/step back one frame/i)).toBeDisabled();
  });
});
