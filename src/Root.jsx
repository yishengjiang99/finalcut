// Landing-first entry. The landing page (pre-rendered into index.html) renders from this small
// bundle; the editor/chat app (App.jsx + tools, ffmpeg.wasm host, VideoPreview, Stripe/auth
// flows) is a separate chunk loaded only when it is needed: "Try the sample video", a returning
// subscriber, or a verified Stripe checkout. "Start editing free" just redirects to Google
// sign-in, so it never waits for the editor. The chunk is prefetched on hover/focus/touch of a
// landing button and after the visitor's first interaction (on idle), so the click stays instant.
import React, { Suspense, lazy, useEffect, useState } from 'react';
import Landing from './Landing.jsx';
import { track, trackOnce, landingProps, captureAttribution } from './telemetry.js';

captureAttribution(); // ad click ids / utm_* from the landing URL -> first-party storage
import { readDeepLink, storePendingPrompt } from './pendingPrompt.js';
import './App.css';

const loadEditor = () => import('./App.jsx');
const Editor = lazy(loadEditor);

let editorPromise = null;
export function prefetchEditor() {
  if (!editorPromise) editorPromise = loadEditor().catch(() => { editorPromise = null; });
  return editorPromise;
}

const AUTH_ERRORS = {
  payment_not_configured: 'Subscription service is not configured. Please contact support.',
  payment_unavailable: 'Payment system is temporarily unavailable. Please try again later.',
  auth_failed: 'Authentication failed. Please try again.',
  invalid_user: 'User authentication failed. Please try again.',
};

function useLandingReveal(active) {
  useEffect(() => {
    if (!active) return undefined;
    const targets = document.querySelectorAll('.landing .reveal');
    if (typeof IntersectionObserver === 'undefined') {
      targets.forEach(el => el.classList.add('in'));
      return undefined;
    }
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    }), { threshold: .12 });
    targets.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [active]);
}

// Prefetch the editor chunk when a landing button is hovered, focused or touched, and on idle
// after the first real interaction (scroll, pointer move, key press). Nothing is fetched for a
// visitor (or a crawler / Lighthouse run) that never interacts.
function useEditorPrefetch(active) {
  useEffect(() => {
    if (!active || typeof window === 'undefined') return undefined;
    const onIntent = (e) => {
      if (e.target instanceof Element && e.target.closest('.landing button')) prefetchEditor();
    };
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500));
    const firstInteraction = () => {
      ['scroll', 'pointermove', 'keydown', 'touchstart'].forEach(t => window.removeEventListener(t, firstInteraction));
      idle(() => prefetchEditor(), { timeout: 4000 });
    };
    ['pointerover', 'focusin', 'touchstart'].forEach(t => document.addEventListener(t, onIntent, { passive: true }));
    ['scroll', 'pointermove', 'keydown', 'touchstart'].forEach(t => window.addEventListener(t, firstInteraction, { passive: true }));
    return () => {
      ['pointerover', 'focusin', 'touchstart'].forEach(t => document.removeEventListener(t, onIntent));
      ['scroll', 'pointermove', 'keydown', 'touchstart'].forEach(t => window.removeEventListener(t, firstInteraction));
    };
  }, [active]);
}

export default function Root() {
  // null = landing; 'editor' = signed-in subscriber or verified checkout; 'sample' = sample video.
  const [mode, setMode] = useState(null);
  const [authError, setAuthError] = useState(null);
  const onLanding = mode === null;
  useLandingReveal(onLanding);
  useEditorPrefetch(onLanding);

  // Deep link from a guide page: /?prompt=…&start=signin|sample (read once, before the URL is cleaned).
  const [deepLink] = useState(() => (typeof window === 'undefined' ? { prompt: '', start: null } : readDeepLink()));

  useEffect(() => { trackOnce('landing_view', landingProps()); }, []);

  // Runs after landing_view so the visit keeps its utm/ref props. The prompt waits in sessionStorage
  // until the editor opens (after sign-in for start=signin; right away for start=sample).
  useEffect(() => {
    if (!deepLink.prompt && !deepLink.start) return;
    storePendingPrompt(deepLink.prompt);
    window.history.replaceState({}, '', '/');
    if (deepLink.start === 'sample') {
      prefetchEditor();
      setMode('sample');
    }
  }, [deepLink]);

  // Auth status: subscribers go straight to the editor. Same logic App.jsx uses on its landing.
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const errorParam = new URLSearchParams(window.location.search).get('error');
        if (errorParam) {
          setAuthError(AUTH_ERRORS[errorParam] || 'An error occurred. Please try again.');
          window.history.replaceState({}, '', '/');
          return;
        }
        if (window.location.pathname === '/success') return; // handled below
        const response = await fetch('/api/auth/status');
        if (!response.ok) return;
        const data = await response.json();
        // start=signin: anyone who is not already a subscriber goes on to Google sign-in, exactly as
        // the "Start editing free" button does.
        if (deepLink.start === 'signin' && !ignore && !(data.authenticated && data.user && data.user.hasSubscription)) {
          try { sessionStorage.setItem('finalcap.signin.started', '1'); } catch { /* storage blocked */ }
          window.location.href = '/auth/google';
          return;
        }
        if (!data.authenticated) return;
        try {
          if (sessionStorage.getItem('finalcap.signin.started')) {
            sessionStorage.removeItem('finalcap.signin.started');
            track('signup', { method: 'google' });
          }
        } catch { /* storage blocked */ }
        if (data.user && data.user.hasSubscription && !ignore) setMode(m => m || 'editor');
      } catch (error) {
        console.error('Error checking auth status:', error);
      }
    })();
    return () => { ignore = true; };
  }, [deepLink]);

  // Returning from Stripe checkout: verify, then open the editor.
  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('session_id');
    if (!sessionId || window.location.pathname !== '/success') return;
    (async () => {
      try {
        const response = await fetch('/api/verify-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
        if (!response.ok) return;
        const data = await response.json();
        if (data.verified && data.paymentStatus === 'paid') {
          track('upgrade', { step: 'paid', method: 'stripe' });
          window.history.replaceState({}, '', '/');
          setMode('editor');
        }
      } catch (error) {
        console.error('Error verifying payment:', error);
      }
    })();
  }, []);

  const onGetStarted = () => {
    track('cta_click', { cta: 'start' });
    try { sessionStorage.setItem('finalcap.signin.started', '1'); } catch { /* storage blocked */ }
    window.location.href = '/auth/google';
  };
  const onLoadSample = () => {
    track('cta_click', { cta: 'sample' });
    prefetchEditor();
    setMode('sample');
  };

  const landing = <Landing onGetStarted={onGetStarted} onLoadSample={onLoadSample} authError={authError} />;
  if (onLanding) return landing;
  // While the editor chunk loads (usually already prefetched) the landing stays on screen.
  return (
    <Suspense fallback={landing}>
      <Editor skipLanding startWithSample={mode === 'sample'} />
    </Suspense>
  );
}
