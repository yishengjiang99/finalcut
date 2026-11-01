import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import App from '../App.jsx';

vi.mock('../ffmpeg.js', () => ({
  ffmpeg: { on: vi.fn(), load: vi.fn(), exec: vi.fn(), writeFile: vi.fn(), readFile: vi.fn(), loaded: false },
  loadFFmpeg: vi.fn().mockResolvedValue(undefined),
  fetchFile: vi.fn(),
}));

global.URL.createObjectURL = vi.fn(() => 'mock-url');

describe('photo upload', () => {
  it('picker accepts photos and an untyped .heic opens as a photo', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: true, user: { hasSubscription: true } }) });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector('input[type="file"]')).toBeInTheDocument(), { timeout: 3000 });
    const input = container.querySelector('input[type="file"]');
    expect(input.getAttribute('accept')).toMatch(/image\/\*/);
    const photo = new File(['x'], 'IMG_0001.HEIC', { type: '' });
    photo.arrayBuffer = async () => new ArrayBuffer(1);
    fireEvent.change(input, { target: { files: [photo] } });
    await waitFor(() => expect(container.querySelector('img[src="mock-url"]')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByText(/not a valid/)).toBeNull();
  });
});
