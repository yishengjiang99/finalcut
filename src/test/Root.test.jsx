import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Root from '../Root.jsx';

// The landing shell renders without the editor chunk and loads App.jsx only when needed.
describe('Root (landing shell with lazy editor)', () => {
  beforeEach(() => {
    global.URL.createObjectURL = vi.fn(() => 'blob:mock');
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/api/auth/status')) return { ok: true, json: async () => ({ authenticated: false }) };
      if (String(url).includes('/api/sample-access-token')) return { ok: true, json: async () => ({ token: 't' }) };
      if (String(url).includes('BigBuckBunny')) return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }) };
      return { ok: false, json: async () => ({}) };
    });
  });

  it('renders the landing page with a single h1 and no editor', () => {
    const { container } = render(<Root />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getAllByText('Start editing free').length).toBeGreaterThan(0);
    expect(container.querySelector('.send-btn')).toBeNull();
  });

  it('loads the editor chunk when "Try the sample video" is clicked', async () => {
    const { container } = render(<Root />);
    fireEvent.click(screen.getByText(/Try the sample video/));
    await waitFor(() => expect(container.querySelector('.landing')).toBeNull(), { timeout: 10000 });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/BigBuckBunny.mp4'), { timeout: 10000 });
  });
});
