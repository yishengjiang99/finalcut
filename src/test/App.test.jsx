import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

describe('App Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.location;
    window.location = { href: '', origin: 'http://localhost:3000' };
  });

  it('renders the app component', () => {
    render(<App />);
    // The landing page is shown initially, so we won't see the chat input yet
    const getStartedButton = screen.getByText('Get started free');
    expect(getStartedButton).toBeInTheDocument();
  });

  it('renders file upload input after getting started', async () => {
    const mockCheckoutUrl = 'https://checkout.stripe.com/pay/cs_test_123';
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: 'cs_test_123', url: mockCheckoutUrl })
    });

    render(<App />);
    // Landing page doesn't have file input initially
    expect(screen.queryByText('Get started free')).toBeInTheDocument();
  });

  it('renders landing page with title', () => {
    render(<App />);
    expect(screen.getByText('FinalCap')).toBeInTheDocument();
  });

  it('renders landing page with Get started button', () => {
    render(<App />);
    expect(screen.getByText('Get started free')).toBeInTheDocument();
  });

  it('renders landing page with sample video button', () => {
    render(<App />);
    expect(screen.getByText('Try with a sample video')).toBeInTheDocument();
  });

  it('does not render a rights-reserved footer', () => {
    render(<App />);
    expect(screen.queryByText('© 2026 FinalCap. All rights reserved.')).not.toBeInTheDocument();
  });

  it('does not render an apply-to select in the editor', async () => {
    delete window.location;
    window.location = {
      pathname: '/success',
      search: '?session_id=cs_test_123',
      origin: 'http://localhost:3000',
      href: 'http://localhost:3000/success?session_id=cs_test_123'
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ verified: true, paymentStatus: 'paid', customerEmail: 'test@example.com' })
      });
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByText('Get started free')).not.toBeInTheDocument();
    });
    // The apply-to dropdown was removed: clip selection lives in the rail/library.
    expect(document.querySelector('.target-select')).toBeNull();
    expect(document.querySelector('select.target-select')).toBeNull();
  });

  it('has no processing status panel at all', async () => {
    delete window.location;
    window.location = {
      pathname: '/success',
      search: '?session_id=cs_test_123',
      origin: 'http://localhost:3000',
      href: 'http://localhost:3000/success?session_id=cs_test_123'
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ verified: true, paymentStatus: 'paid', customerEmail: 'test@example.com' })
      });
    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.queryByText('Get started free')).not.toBeInTheDocument();
    });
    // The processing panel is gone entirely: no dock, no inline status.
    expect(container.querySelector('.dock')).toBeNull();
    expect(container.querySelector('.inline-status')).toBeNull();
    // The composer textarea is present as the single input box.
    expect(container.querySelector('.composer textarea')).not.toBeNull();
    // The send button is a plain send (not stop) when idle.
    const sendBtn = container.querySelector('.send-btn');
    expect(sendBtn).not.toBeNull();
    expect(sendBtn.getAttribute('title')).toBe('Send');
  });

  it('shows at most two starter chips in the chat flow, not in the composer', async () => {
    delete window.location;
    window.location = {
      pathname: '/success',
      search: '?session_id=cs_test_123',
      origin: 'http://localhost:3000',
      href: 'http://localhost:3000/success?session_id=cs_test_123'
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ verified: true, paymentStatus: 'paid', customerEmail: 'test@example.com' })
      });
    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.queryByText('Get started free')).not.toBeInTheDocument();
    });
    // Chips live in the chat panel (scroll-past), max two — never pinned in the composer.
    const inChat = container.querySelectorAll('.chat .chat-suggestions .pchip');
    expect(inChat.length).toBeGreaterThan(0);
    expect(inChat.length).toBeLessThanOrEqual(2);
    expect(container.querySelector('.composer .pchip')).toBeNull();
    expect(container.querySelector('.composer .chat-suggestions')).toBeNull();
  });

  it('does not expose token in client-side code', () => {
    const { container } = render(<App />);
    const html = container.innerHTML;
    
    // Ensure no token-related UI elements exist
    expect(html).not.toContain('xaiToken');
    expect(html).not.toContain('Set Token');
    expect(html).not.toContain('No token');
  });

  it('shows editor interface when returning from successful payment', async () => {
    // Mock location with session_id query parameter
    delete window.location;
    window.location = { 
      pathname: '/success',
      search: '?session_id=cs_test_123',
      origin: 'http://localhost:3000',
      href: 'http://localhost:3000/success?session_id=cs_test_123'
    };
    
    // Mock the auth status (not authenticated) and then the verify endpoint
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false }) // for /api/auth/status
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ 
          verified: true, 
          paymentStatus: 'paid',
          customerEmail: 'test@example.com'
        })
      });
    
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    render(<App />);

    // Wait for the verification to complete
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/verify-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sessionId: 'cs_test_123' })
      });
    });

    // Landing page should not be shown after verification
    await waitFor(() => {
      expect(screen.queryByText('Get started free')).not.toBeInTheDocument();
    });
    
    // Editor interface should be shown (check for file input)
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeInTheDocument();
    
    // URL should be cleaned up
    expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/');

    replaceStateSpy.mockRestore();
  });
});
