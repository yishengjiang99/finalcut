import React, { useState, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { systemPrompt } from './tools.js';
import { setSampleModeAccessToken, setSampleModeEnabled, setCurrentFileMimeType, muxCaptionTrack, sampleAuthHeaders } from './toolFunctions.js';
import VideoPreview from './VideoPreview.jsx';
import TimelineStrip from './TimelineStrip.jsx';
import { soundtrackPrompt } from './soundtrackPrompt.js';

// Timeline strip switch. (It was briefly set false on 2026-10-27 under a
// misread instruction and restored the same day — the feature ordered off
// was the project history list, which the web editor doesn't have.)
const TIMELINE_ENABLED = true;
import { useCallAPI } from './useCallAPI.js';
import VoiceButton, { summarize } from './VoiceButton.jsx';
import { setFetchAbortSignal } from './abortableFetch.js';
import {
  fetchClientConfig,
  setUploadConsentHandler,
} from './engineMode.js';
import { checkClip, DEFAULT_CLIP_LIMITS, isConstrainedBrowser } from './wasm/clipLimits.js';
import logoUrl from './brand/logo-96.webp';
import Landing from './Landing.jsx';
import { track, trackOnce, sizeBucket, lengthBucket, landingProps } from './telemetry.js';
import { takePendingPrompt } from './pendingPrompt.js';
import { newBuildAvailable } from './buildInfo.js';
import { makeShareFile, canShareFile, shareOrDownload } from './shareFile.js';
import { subscribeTracks, tracksVersion, getTrack, restoreTrack, trackToSrt } from './captionTrack.js';
import { videoHasBurnedCaptions } from './captionLineage.js';
import { createClientLog } from './clientLog.js';
import { exportCaptionedVideo, EXPORT_NOTICES } from './captionExport.js';
import { burnCaptionsWebCodecs, webCodecsAvailable } from './captionBurn.js';
import './App.css';

const sampleCommands = [
  { icon: '📐', text: 'Resize this video to 1280x720' },
  { icon: '✏️', text: 'Add text "Hello World" at the center of the video' },
  { icon: '✂️', text: 'Trim the video to keep only seconds 5 to 15' },
  { icon: '💬', text: 'Generate captions for this video' },
  { icon: '⚡', text: 'Make the video play at 2x speed' },
  { icon: '💡', text: 'Increase the brightness by 0.3' },
  { icon: '🔊', text: 'Adjust audio volume to 150%' },
  { icon: '📱', text: 'Convert this video to 9:16 aspect ratio for Instagram' }
];


const captionCommands = [
  'Generate captions for this video',
  'Generate captions and translate them to Spanish',
  'Add lyric captions to this video'
];

const MIME_EXTENSIONS = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv', 'video/x-flv': 'flv', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/x-ms-wma': 'wma'
};

// Short name for a media message: the file name for uploads, the edit for results
// ("Processed video (trimmed):" → "Trimmed").
export const mediaLabel = (msg) => {
  if (msg?.name) return msg.name;
  const firstLine = String(msg?.content || '').split('\n')[0];
  const inParens = /\(([^)]+)\)/.exec(firstLine);
  const label = (inParens ? inParens[1] : firstLine.replace(/:\s*$/, '')).trim() || 'Result';
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const downloadFile = (url, filename) => {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
};

const mediaFilename = (item) => {
  if (item.kind === 'original' && /\.\w+$/.test(item.label)) return item.label;
  const slug = item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
  return `finalcap-${slug}.${MIME_EXTENSIONS[item.mimeType] || (item.isAudio ? 'mp3' : 'mp4')}`;
};

const saveBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  downloadFile(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

// Thumbnail with the clip's first frame; reports duration and frame size once known.
function MediaThumb({ item, onMeta }) {
  const [duration, setDuration] = useState(null);
  const handleMeta = (e) => {
    const el = e.currentTarget;
    setDuration(el.duration);
    if (onMeta) onMeta({ duration: el.duration, width: el.videoWidth || 0, height: el.videoHeight || 0 });
  };
  return (
    <div className="thumb">
      {item.isAudio ? '🎵' : '🎬'}
      {item.isAudio
        ? <audio src={item.url} preload="metadata" onLoadedMetadata={handleMeta} hidden />
        : <video src={`${item.url}#t=0.1`} preload="metadata" muted playsInline onLoadedMetadata={handleMeta} />}
      {Number.isFinite(duration) && <span className="dur">{formatDuration(duration)}</span>}
    </div>
  );
}

function ClipRow({ item, active, disabled, onSelect }) {
  const [meta, setMeta] = useState(null);
  const detail = item.isAudio ? 'audio' : (meta?.width ? `${meta.width}×${meta.height}` : 'video');
  return (
    <button type="button" className={`clip${active ? ' active' : ''}`} disabled={disabled} onClick={onSelect} title={active ? 'Edits apply to this clip' : 'Edit this clip'}>
      <MediaThumb item={item} onMeta={setMeta} />
      <div className="meta">
        <div className="name">{item.label}</div>
        <div className="sub">{detail} · {item.kind}</div>
      </div>
    </button>
  );
}

// Re-renders on its own timer so a ticking clock doesn't re-render the whole editor.
function useNow(intervalMs, enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

function TimeAgo({ at }) {
  const minutes = Math.floor((useNow(30000) - at) / 60000);
  if (minutes < 1) return 'just now';
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

const JOB_STATUS_TEXT = { done: 'Done', error: 'Failed', cancelled: 'Cancelled' };

// A prompt can finish without changing the clip (a question, or a lookup the model stopped at).
export const jobStatusText = (job) => (
  job.status === 'done' && !job.producedFile ? 'Done — no edit was made' : JOB_STATUS_TEXT[job.status]
);

// Stage text for the running tool: lookups are not edits, so they are not "processing".
export const toolStageText = (toolName, args) => {
  if (toolName === 'get_video_dimensions') return 'Reading video details…';
  if (toolName === 'ffmpeg_cli' && args?.action !== 'run') return 'Working out the ffmpeg command…';
  return 'Processing with ffmpeg…';
};
// What an upload to the server would send, for the consent prompt.
const UPLOAD_NOUN = { video: 'your video', photo: 'your photo', audio: 'the audio of your clip (not the video)' };
const JOB_ICONS = { done: '✅', error: '⚠️', cancelled: '🚫' };

// Tool results and tool-call-only assistant turns are for the model, not the chat window.
export const isVisibleMessage = (msg) => msg?.role !== 'tool' && Boolean(msg?.content || msg?.videoUrl);

const welcomeMessage = {
  role: 'assistant',
  content: 'Welcome to FinalCap! Open a video or audio file to get started (opening it does not upload it), then tell me what to do with it, or pick a starting point below.',
  id: 0,
  excludeFromAPI: true,
  showSampleLinks: true
};

export const isDownloadOnlyAttachment = (msg) => {
  return msg?.videoType === 'subtitle-srt' || (
    msg?.mimeType &&
    !msg.mimeType.startsWith('video/') &&
    !msg.mimeType.startsWith('audio/')
  );
};

export const shouldRenderVideoPreview = (msg) => {
  return Boolean(msg?.videoUrl) && !isDownloadOnlyAttachment(msg);
};

// skipLanding/startWithSample are set by Root.jsx, which renders the landing page itself and loads
// this module as a separate chunk only when the editor is needed. Without props (tests), App
// still renders its own landing first.
export default function App({ skipLanding = false, startWithSample = false } = {}) {
  const [showLanding, setShowLanding] = useState(!skipLanding); // Show landing page initially
  const [loaded, setLoaded] = useState(true); // Server-side processing doesn't require loading
  const [processing, setProcessing] = useState(false); // Track ffmpeg processing state
  const [authError, setAuthError] = useState(null); // Track authentication errors
  const [sessionExpired, setSessionExpired] = useState(false); // Set when the server rejects the login session
  const [isCallingAPI, setIsCallingAPI] = useState(false); // Track API call state
  const videoRef = useRef(null);
  const messageRef = useRef(null);

  const [messages, setMessages] = useState([{ role: 'system', content: systemPrompt, id: -1 }, welcomeMessage]);
  const [chatInput, setChatInput] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [videoFileData, setVideoFileData] = useState(null);
  const [uploadedVideos, setUploadedVideos] = useState([]); // Array of {data: Uint8Array, url: string, name: string, mimeType: string}
  const [fileType, setFileType] = useState('video'); // 'video' or 'audio'
  const [fileMimeType, setFileMimeType] = useState(''); // Store MIME type for proper detection
  const [isSampleMode, setIsSampleMode] = useState(false);
  const [sampleAccessToken, setSampleAccessTokenState] = useState(null);
  const messageIdCounterRef = useRef(1); // Counter for unique message IDs
  const lastPromptRef = useRef(''); // the last thing the user asked: what a Retry button sends again
  useSyncExternalStore(subscribeTracks, tracksVersion); // re-render when a caption track changes
  const [exportSheet, setExportSheet] = useState(null); // { working, pct }: captions being added; { file, notice }: a finished export waiting for a fresh tap to share
  const exportAbortRef = useRef(null);
  const restoreTriedRef = useRef(new Set());
  const [newVersion, setNewVersion] = useState(false); // the server runs a newer build than this tab
  const chatWindowRef = useRef(null);
  const composerZoneRef = useRef(null);
  // Pin the composer to the bottom of the *visual* viewport (iPhone Safari keyboard):
  // --kb-offset = how far the visible bottom sits above the layout bottom; --composer-h = its height.
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    const update = () => {
      const offset = vv ? Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)) : 0;
      root.style.setProperty('--kb-offset', `${Math.round(offset)}px`);
      const el = composerZoneRef.current;
      if (el) root.style.setProperty('--composer-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    };
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro && composerZoneRef.current) ro.observe(composerZoneRef.current);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, []);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const [view, setView] = useState('editor'); // 'editor' | 'captions' | 'library'
  const [health, setHealth] = useState(null); // null while checking, then { ok, ffmpegVersion }
  const [jobs, setJobs] = useState([]); // One per sent prompt, newest first
  const [compareIds, setCompareIds] = useState(() => new Set());
  const [toastText, setToastText] = useState('');
  const toastTimerRef = useRef(null);
  const jobIdCounterRef = useRef(1);
  const [toolStage, setToolStage] = useState(null); // what the running job's current tool is doing
  const [clipLimits, setClipLimits] = useState(DEFAULT_CLIP_LIMITS);
  const [turnStatus, setTurnStatus] = useState(null); // { text, progress?, etaSeconds? } for the running job
  const [uploadConsent, setUploadConsent] = useState(null); // { tool, reason, uploads, resolve } while asking
  const currentJobRef = useRef(null); // { id, controller } while a prompt is running
  // Which clip the next edit applies to. Bytes are kept per media message so any
  // clip (an upload or an earlier result) can become the edit target again.
  const [activeMediaId, setActiveMediaId] = useState(null);
  const activeMediaIdRef = useRef(null);
  // Timeline strip (layout rethink): expanded ⇄ slim, and the registry of live
  // preview <video> elements by message id so the strip can follow/scrub the
  // active card's preview.
  const [stripOpen, setStripOpen] = useState(true);
  const previewElsRef = useRef(new Map()); // message id → <video> element
  const registerPreviewEl = (id, el) => {
    if (el) previewElsRef.current.set(id, el);
    else previewElsRef.current.delete(id);
  };
  const mediaBytesRef = useRef(new Map()); // message id → Uint8Array
  const pendingResultBytesRef = useRef(null); // set by a tool just before it posts its result message

  const activateMedia = (id) => {
    activeMediaIdRef.current = id;
    setActiveMediaId(id);
  };

  const toast = (text) => {
    setToastText(text);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastText(''), 2200);
  };

  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // One row by default; grow only when the typed text wraps, up to ~5 rows. An empty box stays
    // one row even when the long placeholder wraps (Safari counts the placeholder in scrollHeight).
    const cs = window.getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3 || 20;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const oneRow = Math.ceil(line + pad + border);
    if (!chatInput) { el.style.height = oneRow + 'px'; el.style.overflowY = 'hidden'; return; }
    el.style.height = oneRow + 'px';
    const cap = Math.ceil(line * 5 + pad + border);
    const want = el.scrollHeight + border;
    el.style.height = Math.min(Math.max(want, oneRow), cap) + 'px';
    el.style.overflowY = want > cap ? 'auto' : 'hidden';
  }, [chatInput, showLanding, view]);

  // A prompt carried over from a guide page deep link (/?prompt=…): prefill the chat box once the
  // editor is showing. Never sent automatically.
  useEffect(() => {
    if (showLanding) return;
    const pending = takePendingPrompt();
    if (pending) setChatInput(prev => prev || pending);
  }, [showLanding]);

  // Fade landing sections in as they scroll into view
  useEffect(() => {
    if (!showLanding) return;
    const targets = document.querySelectorAll('.landing .reveal');
    if (typeof IntersectionObserver === 'undefined') {
      targets.forEach(el => el.classList.add('in'));
      return;
    }
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    }), { threshold: .12 });
    targets.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [showLanding]);

  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
      // Mobile: the whole editor scrolls (header scrolls away), so pin that to the bottom too.
      const root = chatWindowRef.current.closest('.fc.editor');
      if (root && root.scrollHeight > root.clientHeight) root.scrollTop = root.scrollHeight;
    }
  }, [messages, isCallingAPI]);

  useEffect(() => {
    setSampleModeEnabled(isSampleMode);
  }, [isSampleMode]);

  useEffect(() => {
    setSampleModeAccessToken(sampleAccessToken);
  }, [sampleAccessToken]);

  const getSampleAccessToken = async ({ force = false } = {}) => {
    if (sampleAccessToken && !force) return sampleAccessToken;

    if (!force && window.__FINALCUT_SAMPLE_TOKEN_PROMISE__) {
      try {
        const token = await window.__FINALCUT_SAMPLE_TOKEN_PROMISE__;
        if (token) {
          setSampleAccessTokenState(token);
          return token;
        }
      } catch (error) {
        // Fall through to direct API request
      }
    }

    const response = await fetch('/api/sample-access-token');
    if (!response.ok) {
      throw new Error('Failed to initialize sample access token');
    }
    const data = await response.json();
    const token = data?.token;
    if (!token) {
      throw new Error('Sample access token missing in response');
    }
    setSampleAccessTokenState(token);
    // Tools read the token from toolFunctions; update it now, ahead of the next render.
    setSampleModeAccessToken(token);
    return token;
  };

  const getSampleAuthHeaders = () => {
    if (isSampleMode && sampleAccessToken) {
      return { 'sample-access-token': sampleAccessToken };
    }
    return {};
  };

  // Check if user is authenticated and has subscription
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const errorParam = urlParams.get('error');

        if (errorParam) {
          const errorMessages = {
            'payment_not_configured': 'Subscription service is not configured. Please contact support.',
            'payment_unavailable': 'Payment system is temporarily unavailable. Please try again later.',
            'auth_failed': 'Authentication failed. Please try again.',
            'invalid_user': 'User authentication failed. Please try again.'
          };

          setAuthError(errorMessages[errorParam] || 'An error occurred. Please try again.');

          window.history.replaceState({}, '', '/');
          return;
        }

        const response = await fetch('/api/auth/status', {
          headers: getSampleAuthHeaders()
        });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated) {
            try {
              if (sessionStorage.getItem('finalcap.signin.started')) {
                sessionStorage.removeItem('finalcap.signin.started');
                track('signup', { method: 'google' });
              }
            } catch { /* storage blocked */ }
            // Only hide landing page if user has subscription
            if (data.user && data.user.hasSubscription) {
              setShowLanding(false);
            }
            // If authenticated but no subscription, keep showing landing page
            // (user will be redirected to Stripe when they try to access)
          }
        }
      } catch (error) {
        console.error('Error checking auth status:', error);
      }
    };

    checkAuth();
  }, []);

  // Anonymous funnel telemetry (src/telemetry.js): landing view on first load.
  const landingOnMountRef = useRef(showLanding);
  useEffect(() => {
    if (landingOnMountRef.current) trackOnce('landing_view', landingProps());
  }, []);

  // Check if user is returning from successful payment
  useEffect(() => {
    const verifyPayment = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const sessionId = urlParams.get('session_id');

      if (sessionId && window.location.pathname === '/success') {
        try {
          const response = await fetch('/api/verify-checkout-session', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getSampleAuthHeaders()
            },
            body: JSON.stringify({ sessionId })
          });

          if (response.ok) {
            const data = await response.json();
            if (data.verified && data.paymentStatus === 'paid') {
              track('upgrade', { step: 'paid', method: 'stripe' });
              // Hide landing page and show editor after verified payment
              setShowLanding(false);
              window.history.replaceState({}, '', '/');
            }
          }
        } catch (error) {
          console.error('Error verifying payment:', error);
        }
      }
    };

    verifyPayment();
  }, []);

  // Server config: clip limits and caption availability. Editing always runs in this
  // browser (ffmpeg.wasm, nothing uploaded).
  useEffect(() => {
    let ignore = false;
    fetchClientConfig().then((config) => {
      if (ignore) return;
      if (config?.limits?.clip) setClipLimits(config.limits.clip);
    });
    return () => { ignore = true; };
  }, []);

  // A step that cannot run in the browser asks here before anything is uploaded. The answer is
  // "no" unless the user presses the upload button.
  useEffect(() => {
    setUploadConsentHandler((request) => new Promise((resolve) => {
      setUploadConsent({ ...request, resolve });
    }));
    return () => setUploadConsentHandler(null);
  }, []);

  const answerUploadConsent = (allowed) => {
    if (uploadConsent) track('upload_consent', { allowed: Boolean(allowed), uploads: String(uploadConsent.uploads || 'file'), tool: uploadConsent.tool });
    uploadConsent?.resolve(allowed);
    setUploadConsent(null);
  };

  // Server status for the top bar (unauthenticated endpoint)
  useEffect(() => {
    let ignore = false;
    const checkHealth = async () => {
      try {
        const response = await fetch('/api/health');
        const data = response?.ok ? await response.json() : null;
        if (!ignore) setHealth({ ok: Boolean(data?.ok), ffmpegVersion: data?.ffmpeg?.version || null });
      } catch (error) {
        if (!ignore) setHealth({ ok: false, ffmpegVersion: null });
      }
    };
    checkHealth();
    return () => { ignore = true; };
  }, []);

  // An open tab keeps its old bundle: offer a reload when the server has a newer build (never reload by itself).
  useEffect(() => {
    let stopped = false;
    const check = async () => { if (!stopped && await newBuildAvailable()) setNewVersion(true); };
    const first = setTimeout(check, 10_000);
    const timer = setInterval(check, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearTimeout(first); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const addMessage = ({
    text,
    isUser = false,
    videoUrl = null,
    videoType = 'processed',
    mimeType = null,
    showSampleLinks = false,
    vttUrl = null,
    retry = false,
    captions = null
  }) => {
    // Whatever a cancelled job still reports (its aborted request) is not shown.
    if (currentJobRef.current?.controller.signal.aborted) return null;
    const id = messageIdCounterRef.current++;
    let parentId = null;
    // The "Captions · A → B" card belongs to the clip whose bytes carry the caption track.
    let captionMediaId = null;
    if (captions?.bytes) {
      captionMediaId = [...mediaBytesRef.current.entries()].find(([, b]) => b === captions.bytes)?.[0] ?? activeMediaIdRef.current;
      if (captionMediaId !== null && mediaBytesRef.current.get(captionMediaId) !== captions.bytes) mediaBytesRef.current.set(captionMediaId, captions.bytes);
      if (captionMediaId !== null && captionMediaId !== activeMediaIdRef.current) { activateMedia(captionMediaId); setVideoFileData(captions.bytes); }
    }
    if (videoUrl) {
      if (currentJobRef.current) {
        const jobId = currentJobRef.current.id;
        setJobs(prev => prev.map(job => job.id === jobId ? { ...job, producedFile: true } : job));
      }
      const resultBytes = pendingResultBytesRef.current;
      pendingResultBytesRef.current = null;
      if (resultBytes && shouldRenderVideoPreview({ videoUrl, videoType, mimeType })) {
        // A tool just produced this clip: remember its bytes and make it the edit target.
        mediaBytesRef.current.set(id, resultBytes);
        parentId = activeMediaIdRef.current;
        activateMedia(id);
        if (currentJobRef.current) {
          const jobId = currentJobRef.current.id;
          setJobs(prev => prev.map(job => job.id === jobId ? { ...job, resultMessageId: id } : job));
        }
      }
    }
    setMessages(prev => [...prev, { role: isUser ? 'user' : 'assistant', content: text, videoUrl, videoType, mimeType, id, excludeFromAPI: true, showSampleLinks, vttUrl, parentId, retryText: retry ? lastPromptRef.current : null, captionCard: captionMediaId !== null ? { mediaId: captionMediaId, lines: captions.lines } : null }]);
    return id;
  };

  // Tools hand back edited bytes through this setter, then post the result message.
  const setWorkingVideoFileData = (data) => {
    if (currentJobRef.current?.controller.signal.aborted) return;
    pendingResultBytesRef.current = data;
    setVideoFileData(data);
  };

  // The video clips of the project, for tools that combine clips (concat_videos). Reads a ref so a
  // clip added earlier in the same turn is included.
  const mediaListRef = useRef([]);
  const project = {
    listClips: () => mediaListRef.current
      .filter(item => item.mimeType.startsWith('video/'))
      .map(item => ({ id: String(item.id), label: item.label })),
    loadClips: async (ids) => Promise.all(ids.map(async (id) => {
      const item = mediaListRef.current.find(m => String(m.id) === String(id) && m.mimeType.startsWith('video/'));
      if (!item) throw new Error(`Clip ${id} is not in the project.`);
      let bytes = mediaBytesRef.current.get(item.id);
      if (!bytes) {
        bytes = new Uint8Array(await (await fetch(item.url)).arrayBuffer());
        mediaBytesRef.current.set(item.id, bytes);
      }
      return { bytes, mimeType: item.mimeType };
    })),
  };

  const getVideoTitle = (videoType) => {
    return videoType === 'original' ? 'Original Video' : 'Processed Video';
  };

  const callAPI = useCallAPI({
    isSampleMode,
    sampleAccessToken,
    setIsCallingAPI,
    setProcessing,
    setMessages,
    messageIdCounterRef,
    videoFileData,
    setVideoFileData: setWorkingVideoFileData,
    addMessage,
    uploadedVideos,
    project,
    refreshSampleAccessToken: () => getSampleAccessToken({ force: true }),
    onAuthExpired: () => setSessionExpired(true),
    onToolStart: (toolName, args) => setToolStage(toolStageText(toolName, args)),
  });

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files || files.length === 0) return;

    try {
      const newVideos = [];
      let hasError = false;

      // Upload progress is a transient status, not part of the conversation
      toast(`Opening ${files.length} file${files.length > 1 ? 's' : ''}…`);

      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Some browsers leave HEIC/HEIF type empty; infer it from the extension.
        const type = file.type || (/\.(heic|heif)$/i.test(file.name) ? 'image/heic' : '');
        const isAudio = type.startsWith('audio/');
        const isVideo = type.startsWith('video/');
        const isPhoto = type.startsWith('image/');

        if (!isAudio && !isVideo && !isPhoto) {
          toast(`“${file.name}” is not a valid video, photo or audio file`);
          hasError = true;
          continue;
        }

        // In-browser editing has to fit the clip in this tab's memory.
        const clip = checkClip({ bytes: file.size }, { limits: clipLimits });
        if (clip.level === 'block') {
          addMessage({ text: `"${file.name}" is too large to edit in this browser. ${clip.reasons.join(' ')} Try a shorter or lower-resolution clip.` });
          hasError = true;
          continue;
        }
        if (clip.level === 'warn') addMessage({ text: `"${file.name}": ${clip.reasons.join(' ')}` });

        const arrayBuffer = await file.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const url = URL.createObjectURL(file);

        newVideos.push({
          id: messageIdCounterRef.current++,
          data: data,
          url: url,
          name: file.name,
          mimeType: type,
          isAudio: isAudio
        });

        mediaBytesRef.current.set(newVideos[newVideos.length - 1].id, data);

        // For the first file, set it as the main video for backward compatibility
        if (i === 0) {
          activateMedia(newVideos[0].id);
          setVideoFileData(data);
          setFileType(isAudio ? 'audio' : 'video');
          setFileMimeType(type);
          setCurrentFileMimeType(type);
        }
      }

      if (newVideos.length === 0) {
        if (!hasError) toast('No valid files were opened');
        e.target.value = '';
        return;
      }

      track('video_loaded', {
        source: 'file',
        files: newVideos.length,
        kind: newVideos[0].isAudio ? 'audio' : 'video',
        container: String(newVideos[0].mimeType || 'unknown').split(';')[0].slice(0, 64),
        size_bucket: sizeBucket(newVideos[0].data?.byteLength),
      });

      setUploadedVideos(prev => [...prev, ...newVideos]);
      setIsSampleMode(false);

      // Each upload gets a clip card in the chat, with no status bubble
      const uploadedMessages = newVideos.map((video) => ({
        role: 'user',
        content: '',
        videoUrl: video.url,
        videoType: 'original',
        mimeType: video.mimeType,
        name: video.name,
        apiContent: `A ${video.isAudio ? 'audio' : video.mimeType.startsWith('image/') ? 'photo' : 'video'} file is available for editing.`,
        id: video.id
      }));

      setMessages(prev => [...prev, ...uploadedMessages]);
      if (!hasError) toast(`${newVideos.length} file${newVideos.length > 1 ? 's' : ''} ready for editing${newVideos.length > 1 ? ' or transitions' : ''}`);
    } catch (error) {
      toast('Error opening files: ' + error.message);
    }

    // Clear the input so the same files can be uploaded again if needed
    e.target.value = '';
  };

  const handleSend = async (textOverride = null) => {
    const hasStringOverride = typeof textOverride === 'string';
    const text = (hasStringOverride ? textOverride : chatInput).trim();
    if (!text || isCallingAPI) return;
    if (!hasStringOverride) setChatInput('');
    // Dismiss the on-screen keyboard after sending (the box shrinks back to one row via chatInput).
    textareaRef.current?.blur();
    lastPromptRef.current = text;
    const newMessage = { role: 'user', content: text, id: messageIdCounterRef.current++ };
    trackOnce('first_prompt', { prompt_len_bucket: lengthBucket(text.length), input: hasStringOverride ? 'suggestion' : 'typed' });
    const newMessages = [...messages, newMessage];
    setMessages(newMessages);

    // Track this prompt as a job in the inline processing status; the controller lets it be cancelled.
    const controller = new AbortController();
    const job = { id: jobIdCounterRef.current++, prompt: text, status: 'running', startedAt: Date.now(), endedAt: null, resultMessageId: null, producedFile: false };
    currentJobRef.current = { id: job.id, controller };
    pendingResultBytesRef.current = null;
    setToolStage(null);
    setFetchAbortSignal(controller.signal);
    setJobs(prev => [job, ...prev]);

    let status;
    try {
      // callAPI appends to the array it is given; hand it a copy, not the array held in state.
      status = await callAPI([...newMessages], { signal: controller.signal, onStatus: setTurnStatus });
    } finally {
      setTurnStatus(null);
      // A pending upload question belongs to the job that just ended.
      setUploadConsent(prev => { prev?.resolve(false); return null; });
      currentJobRef.current = null;
      setFetchAbortSignal(null);
    }
    if (controller.signal.aborted) status = 'cancelled';
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: status || 'done', endedAt: Date.now() } : j));
    if (status === 'cancelled') toast(`Cancelled: “${text}”`);
    return status || 'done';
  };

  // Voice: run a spoken request through the same chat/edit flow, then return the reply to speak.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const busyRef = useRef(isCallingAPI);
  busyRef.current = isCallingAPI;
  const runVoicePrompt = async (text) => {
    if (!text.trim()) return 'I did not catch an instruction.';
    if (busyRef.current) return summarize('busy');
    const before = messagesRef.current.length;
    const status = await handleSendRef.current(text);
    await new Promise(r => setTimeout(r, 0));
    const reply = messagesRef.current.slice(before).filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()).pop();
    return summarize(status, reply?.content);
  };
  const handleSendRef = useRef(null);
  handleSendRef.current = handleSend;

  const cancelRunning = () => {
    currentJobRef.current?.controller.abort();
  };

  const handleSampleClick = (sampleText) => {
    setChatInput(sampleText);
    setView('editor');
    textareaRef.current?.focus();
  };

  const showMessage = (messageId) => {
    setView('editor');
    // Wait for the chat to be on screen before scrolling to the message.
    setTimeout(() => {
      const el = chatWindowRef.current?.querySelector(`[data-message-id="${messageId}"]`);
      el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 0);
  };

  // Every playable clip in the project: uploads and edit results, oldest first.
  const media = useMemo(() => messages
    .filter(msg => !msg.mediaRemoved && shouldRenderVideoPreview(msg))
    .map(msg => {
      const mimeType = msg.mimeType || 'video/mp4';
      return {
        id: msg.id,
        url: msg.videoUrl,
        mimeType,
        isAudio: mimeType.startsWith('audio/'),
        kind: msg.videoType === 'original' ? 'original' : 'result',
        label: mediaLabel(msg),
        parentId: msg.parentId ?? null
      };
    }), [messages]);

  mediaListRef.current = media;
  const mediaById = (id) => media.find(item => item.id === id) || null;
  const activeMedia = mediaById(activeMediaId);

  // Make a clip the target of the next edit.
  const selectMedia = async (item) => {
    if (!item || isCallingAPI) return false;
    try {
      let bytes = mediaBytesRef.current.get(item.id);
      if (!bytes) {
        const response = await fetch(item.url);
        bytes = new Uint8Array(await response.arrayBuffer());
        mediaBytesRef.current.set(item.id, bytes);
      }
      setVideoFileData(bytes);
      setFileType(item.isAudio ? 'audio' : 'video');
      setFileMimeType(item.mimeType);
      setCurrentFileMimeType(item.mimeType);
      activateMedia(item.id);
      return true;
    } catch (error) {
      toast('Could not load that clip: ' + error.message);
      return false;
    }
  };

  const handleSelectMedia = async (item) => {
    if (item.id === activeMediaId) return showMessage(item.id);
    if (await selectMedia(item)) toast(`Edits now apply to “${item.label}”`);
  };

  const handleUndo = async (item) => {
    const parent = mediaById(item.parentId);
    if (!parent) return toast('The clip this edit was made from is no longer in the project');
    if (await selectMedia(parent)) {
      toast(`Undid “${item.label}”. Your next edit applies to “${parent.label}”.`);
    }
  };

  const toggleCompare = (id) => {
    setCompareIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const removeMedia = (item) => {
    if (isCallingAPI) return;
    setMessages(prev => prev.map(msg => msg.id === item.id ? { ...msg, mediaRemoved: true } : msg));
    setUploadedVideos(prev => prev.filter(video => video.id !== item.id));
    mediaBytesRef.current.delete(item.id);
    if (item.id === activeMediaId) {
      const remaining = media.filter(other => other.id !== item.id);
      if (remaining.length > 0) {
        selectMedia(remaining[remaining.length - 1]);
      } else {
        setVideoFileData(null);
        activateMedia(null);
      }
    }
  };

  // In-page bridge for agent tools (public/webmcp.js, docs/webmcp.md). Reads the latest state via a ref, so it
  // never goes stale; it only calls the same handlers the buttons use.
  const agentBridgeRef = useRef(null);
  agentBridgeRef.current = {
    busy: () => isCallingAPI,
    messages: () => messagesRef.current
      .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ id: m.id, role: m.role, text: m.content })),
    media: () => media.map(({ id, label, mimeType, isAudio, kind, parentId }) => ({ id, label, mimeType, isAudio, kind, parentId, active: id === activeMediaId })),
    send: async (text) => { setView('editor'); return runVoicePrompt(String(text || '')); },
    cancel: () => { cancelRunning(); return true; },
    select: async (id) => { const item = mediaById(Number(id)); return item ? selectMedia(item) : false; },
    undo: async (id) => { const item = mediaById(Number(id ?? activeMediaId)); if (!item) return false; await handleUndo(item); return true; },
    remove: (id) => { const item = mediaById(Number(id)); if (!item) return false; removeMedia(item); return true; },
    exportActive: () => { if (!activeMedia) return false; handleExport(); return activeMedia.label; },
    addFile: async (file) => { setView('editor'); await handleUpload({ target: { files: [file] } }); return true; },
  };
  useEffect(() => {
    const ref = agentBridgeRef;
    window.finalcutApp = new Proxy({}, { get: (_, key) => ref.current?.[key] });
    window.dispatchEvent(new Event('finalcut:ready'));
    return () => { delete window.finalcutApp; };
  }, []);

  // ─── Captions: overlay, style, export ─────────────────────────────────────────────────────────
  const trackOfMedia = (id) => getTrack(mediaBytesRef.current.get(id));

  // Put back captions saved for a video (a reload or crashed tab lost the in-memory ones).
  useEffect(() => {
    for (const item of media) {
      if (restoreTriedRef.current.has(item.id)) continue;
      const bytes = mediaBytesRef.current.get(item.id);
      if (!bytes) continue;
      restoreTriedRef.current.add(item.id);
      if (!getTrack(bytes) && restoreTrack(bytes)) addMessage({ text: 'Restored the captions you made for this video.', captions: { bytes, lines: getTrack(bytes)?.lines.length || 0 } });
    }
  }, [media]);

  const captionFileBase = (item) => mediaFilename(item).replace(/\.\w+$/, '');
  const handleExport = () => {
    if (!activeMedia) return toast('Add a video or audio file first');
    const capTrack = trackOfMedia(activeMedia.id);
    if (capTrack && !activeMedia.isAudio && !videoHasBurnedCaptions(mediaBytesRef.current.get(activeMedia.id))) {
      exportWithCaptions(activeMedia);
      return;
    }
    plainExport(activeMedia);
  };

  // Phones: the share sheet ("Save Video" puts it in Photos). It must start inside the tap, so the file
  // is built synchronously from the bytes we already hold. Everything else downloads, as before.
  const shareLog = (event, data) => createClientLog({ headers: sampleAuthHeaders() }).log(event, data);
  const plainExport = (item) => {
    const bytes = mediaBytesRef.current.get(item.id);
    const file = bytes ? makeShareFile(bytes, mediaFilename(item), item.mimeType) : null;
    if (file && canShareFile(file)) {
      shareOrDownload(file, { download: (f) => saveBlob(f, f.name), log: shareLog, kind: 'export' }).then((outcome) => {
        if (outcome === 'shared') toast(`Exported “${item.label}”`);
      });
    } else {
      downloadFile(item.url, mediaFilename(item));
      toast(`Exported “${item.label}”`);
    }
    track('export', { format: String(item.mimeType || 'unknown').split(';')[0].slice(0, 64), placement: 'export_button' }); track('export_done', { placement: 'export_button' });
  };

  // Export with captions: the captions are drawn into the frames in the browser (WebCodecs + canvas, hardware
  // H.264, audio copied), so they show in Photos and everywhere else. Nothing is uploaded. A browser that
  // cannot do that gets the soft caption track plus an SRT instead, with one line saying so.
  const exportWithCaptions = async (item) => {
    const bytes = mediaBytesRef.current.get(item.id);
    const capTrack = bytes && getTrack(bytes);
    if (!capTrack) return plainExport(item);
    const clog = createClientLog({ headers: sampleAuthHeaders() });
    clog.attach();
    clog.env();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportSheet({ working: true, pct: null });
    try {
      const result = await exportCaptionedVideo({
        bytes, mime: item.mimeType || 'video/mp4', track: capTrack, clog, signal: controller.signal,
        constrained: isConstrainedBrowser(),
        onProgress: (pct) => setExportSheet(prev => (prev?.working ? { working: true, pct } : prev)),
        deps: { burn: burnCaptionsWebCodecs, mux: muxCaptionTrack, webCodecs: webCodecsAvailable },
      });
      setExportSheet(null);
      const base = captionFileBase(item);
      if (result.srt) saveBlob(new Blob([result.srt], { type: 'text/plain;charset=utf-8' }), `${base}.srt`);
      if (result.kind === 'srt') {
        toast(result.notice);
        return;
      }
      const file = makeShareFile(result.bytes, `${base}.${result.ext}`, result.mime);
      track('export', { format: result.mime, placement: result.kind === 'burned' ? 'export_captions_burned' : 'export_captions_track' }); track('export_done', { placement: result.kind === 'burned' ? 'export_captions_burned' : 'export_captions_track' });
      const outcome = await shareOrDownload(file, { download: (f) => saveBlob(f, f.name), log: (e, d) => clog.log(e, d), kind: 'export_captions' });
      if (outcome === 'needsTap') {
        // Encoding took a while, so the tap is no longer a user activation: ask for a fresh one.
        clog.log('share_ready', { bytes: file.size });
        setExportSheet({ file, notice: result.notice });
      } else if (outcome !== 'cancelled') {
        toast(result.notice);
      }
    } catch (error) {
      setExportSheet(null);
      toast(error?.code === 'cancelled' ? EXPORT_NOTICES.cancelled : EXPORT_NOTICES.srt);
    } finally {
      exportAbortRef.current = null;
      clog.detach();
    }
  };

  // The "Share" tap: a fresh user activation for navigator.share.
  const shareReadyExport = () => {
    const file = exportSheet?.file;
    if (!file) return;
    shareOrDownload(file, { download: (f) => saveBlob(f, f.name), log: shareLog, kind: 'export_captions' }).then((outcome) => {
      if (outcome === 'cancelled') return; // the sheet stays so they can share again
      setExportSheet(null);
      toast(outcome === 'shared' ? (exportSheet?.notice || 'Exported') : 'Saved to your downloads');
    });
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const handleGetStarted = () => {
    window.location.href = '/auth/google';
  };

  const loadSampleVideo = async () => {
    trackOnce('sample_start', { source: 'sample' });
    setShowLanding(false);
    // Sample video path - bundled example clip (public/sample-lake.mp4)
    const sampleVideoUrl = '/sample-lake.mp4';

    try {
      await getSampleAccessToken();

      const response = await fetch(sampleVideoUrl);
      if (!response.ok) {
        // If sample video doesn't exist, just show a message
        toast('Sample video not available. Please open your own video.');
        return;
      }

      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      setVideoFileData(data);
      const url = URL.createObjectURL(blob);
      setIsSampleMode(true);

      setFileType('video');
      setFileMimeType('video/mp4');
      setCurrentFileMimeType('video/mp4');

      const uploadedMessage = { role: 'user', content: '', apiContent: 'A video file is available for editing.', videoUrl: url, videoType: 'original', mimeType: 'video/mp4', name: 'sample-lake.mp4', id: messageIdCounterRef.current++ };
      mediaBytesRef.current.set(uploadedMessage.id, data);
      activateMedia(uploadedMessage.id);
      setMessages(prev => [...prev, uploadedMessage]);
      toast('Sample video loaded and ready for editing');
      track('video_loaded', { source: 'sample', kind: 'video', files: 1 });

    } catch (error) {
      toast('Error loading sample video. Please open your own video.');
    }
  };

  // Root.jsx opened the editor from "Try the sample video": load the sample once.
  const sampleStartedRef = useRef(false);
  const loadSampleVideoRef = useRef(loadSampleVideo);
  loadSampleVideoRef.current = loadSampleVideo;
  useEffect(() => {
    if (!startWithSample || sampleStartedRef.current) return;
    sampleStartedRef.current = true;
    loadSampleVideoRef.current();
  }, [startWithSample]);

  if (showLanding) {
    return (
      <Landing
        onGetStarted={() => {
          track('cta_click', { cta: 'start' });
          try { sessionStorage.setItem('finalcap.signin.started', '1'); } catch { /* storage blocked */ }
          handleGetStarted();
        }}
        onLoadSample={() => { track('cta_click', { cta: 'sample' }); loadSampleVideo(); }}
        authError={authError}
      />
    );
  }

  const visibleMessages = messages.slice(1).filter(isVisibleMessage);
  const finishedJobs = jobs.filter(job => job.status !== 'running');
  const originals = media.filter(item => item.kind === 'original');
  // Gemini-style composer: slim pill when idle, expanded card when active.
  const composerActive = composerFocused || chatInput.trim().length > 0 || originals.length > 0 || isCallingAPI;
  const captionFiles = messages.filter(msg => msg.videoUrl && (msg.videoType === 'subtitle-srt' || msg.vttUrl));
  const onDevice = true; // editing always runs in this browser
  const statusText = health === null
    ? 'checking server…'
    : health.ok
      ? `${health.ffmpegVersion ? `ffmpeg ${health.ffmpegVersion} · ` : ''}server ready`
      : 'server unavailable';

  const renderAttachment = (msg) => {
    if (msg.mediaRemoved) return null;
    const item = mediaById(msg.id);
    if (!item) {
      // Captions and stills are not playable clips: offer the file itself.
      const isImage = msg.mimeType?.startsWith('image/');
      return (
        <div className="result-card">
          {isImage && <img className="still" src={msg.videoUrl} alt={mediaLabel(msg)} />}
          <div className="rc-body">
            <div className="rc-actions">
              <a
                className="chip-btn primary"
                href={msg.videoUrl}
                download={msg.videoType === 'subtitle-srt' ? 'captions.srt' : (isImage ? `finalcap-image.${msg.mimeType.split('/')[1]}` : '')}
              >
                ⬇ Download
              </a>
            </div>
          </div>
        </div>
      );
    }

    const isActive = item.id === activeMediaId;
    const parent = mediaById(item.parentId);
    const comparing = Boolean(parent) && compareIds.has(item.id);
    return (
      <div className={`result-card${isActive ? ' active' : ''}${item.kind !== 'result' ? ' compact' : ''}`} title={item.label} aria-label={item.label}>
        {comparing && (
          <>
            <div className="compare">
              <div className="compare-label">Before · {parent.label}</div>
              {parent.isAudio
                ? <audio src={parent.url} controls />
                : <video src={parent.url} controls playsInline />}
            </div>
            <div className="compare-label after">After · {item.label}</div>
          </>
        )}
        <div className="rc-media">
          {msg.mimeType?.startsWith('image/') ? <img className="still" src={msg.videoUrl} alt={item.label} /> : <VideoPreview
            key={`preview-${msg.id}`}
            videoUrl={msg.videoUrl}
            title={getVideoTitle(msg.videoType)}
            mimeType={msg.mimeType}
            vttUrl={msg.vttUrl || null}
            captionTrack={trackOfMedia(item.id)}
            onVideoMount={(el) => registerPreviewEl(msg.id, el)}
          />}
          {item.kind !== 'result' && (
            <div className="rc-overlay">
              {isActive
                ? <span className="rc-badge">Editing this</span>
                : <button type="button" className="rc-badge rc-edit" disabled={isCallingAPI} onClick={() => handleSelectMedia(item)}>✎ Edit</button>}
              <button
                type="button"
                className="media-x"
                title="Remove from edit"
                aria-label={`Remove ${item.label} from edit`}
                disabled={isCallingAPI}
                onClick={(e) => { e.stopPropagation(); removeMedia(item); }}
              >×</button>
            </div>
          )}
        </div>
        {item.kind === 'result' && <div className="rc-body">
          <div className="rc-title">
            {`✓ ${item.label}`}
            {isActive && <span className="rc-badge">Editing this</span>}
          </div>
          <div className="rc-actions">
            {!isActive && (
              <button className="chip-btn primary" disabled={isCallingAPI} onClick={() => handleSelectMedia(item)}>✎ Edit this</button>
            )}
            {parent && (
              <button className="chip-btn" disabled={isCallingAPI} onClick={() => handleUndo(item)}>↩ Undo</button>
            )}
            {parent && (
              <button className={`chip-btn${comparing ? ' on' : ''}`} onClick={() => toggleCompare(item.id)}>⇄ Compare</button>
            )}
          </div>
        </div>}
      </div>
    );
  };

  // "Captions · English → Chinese": the clip with the live overlay, and the style/export controls.
  const renderCaptionCard = (msg) => {
    const item = mediaById(msg.captionCard.mediaId);
    const capTrack = item && trackOfMedia(item.id);
    if (!item || !capTrack) return <div className="caption-card"><span className="cap-note">These captions are no longer on a clip (removed or the clip changed).</span></div>;
    return (
      <div className="result-card caption-card" title={item.label}>
        <div className="rc-media">
          <VideoPreview key={`captions-${msg.id}`} videoUrl={item.url} title={item.label} mimeType={item.mimeType} captionTrack={capTrack} />
        </div>
        <div className="rc-body">
          <div className="rc-title">{`✓ ${msg.captionCard.lines} caption lines`}</div>
          <p className="cap-note">Press Export to save the video with the captions in it.</p>
        </div>
      </div>
    );
  };

  return (
    <div className="fc editor">
      {uploadConsent && (uploadConsent.kind === 'streaming_audio' || uploadConsent.kind === 'connection_dropped') && (
        // Streaming captions: the wording comes with the request (asked every time, never remembered).
        <div className="consent-backdrop" role="dialog" aria-modal="true" aria-labelledby={uploadConsent.title ? 'consent-title' : undefined}>
          <div className="consent">
            {uploadConsent.title && <h3 id="consent-title">{uploadConsent.title}</h3>}
            <p>
              {uploadConsent.body}
              {uploadConsent.privacyHref && (<> <a href={uploadConsent.privacyHref} target="_blank" rel="noopener noreferrer">{uploadConsent.privacyLabel || 'Privacy details'}</a></>)}
            </p>
            <div className="consent-actions">
              <button className="jbtn open" autoFocus={uploadConsent.kind === 'streaming_audio'} onClick={() => answerUploadConsent(false)}>{uploadConsent.declineLabel}</button>
              <button className="jbtn" autoFocus={uploadConsent.kind === 'connection_dropped'} onClick={() => answerUploadConsent(true)}>{uploadConsent.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
      {uploadConsent && uploadConsent.kind !== 'streaming_audio' && uploadConsent.kind !== 'connection_dropped' && (
        <div className="consent-backdrop" role="dialog" aria-modal="true" aria-labelledby="consent-title">
          <div className="consent">
            <h3 id="consent-title">This step uploads {UPLOAD_NOUN[uploadConsent.uploads] || 'your file'}</h3>
            <p>
              “{String(uploadConsent.tool || 'This edit').replace(/_/g, ' ')}” cannot run in this browser
              {uploadConsent.reason ? ` (${uploadConsent.reason})` : ''}. It can run on our server instead, which means
              sending {UPLOAD_NOUN[uploadConsent.uploads] || 'your file'} there. Nothing is uploaded unless you choose to.
            </p>
            <div className="consent-actions">
              <button className="jbtn open" autoFocus onClick={() => answerUploadConsent(false)}>Keep it on my device (skip this step)</button>
              <button className="jbtn" onClick={() => answerUploadConsent(true)}>Upload and continue</button>
            </div>
          </div>
        </div>
      )}
      {exportSheet && (
        <div className="consent-backdrop" role="dialog" aria-modal="true" aria-labelledby="export-title">
          <div className="consent">
            <h3 id="export-title">Export</h3>
            {exportSheet.working ? (
              <>
                <p className="export-status" role="status">Adding the captions to the video…{Number.isFinite(exportSheet.pct) ? ` ${Math.round(exportSheet.pct * 100)}%` : ''}</p>
                <div className="consent-actions">
                  <button className="jbtn open" onClick={() => exportAbortRef.current?.abort()}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <p className="export-status" role="status">Your video is ready.</p>
                <div className="consent-actions">
                  <button className="jbtn" autoFocus onClick={shareReadyExport}>Share</button>
                  <button className="jbtn open" onClick={() => { setExportSheet(null); }}>Close</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <img src={logoUrl} alt="FinalCap logo" width="30" height="30" />
          <span className="brand-name">FinalCap</span> <small>AI Video Editor</small>
        </div>
        <nav className="nav">
          {[['editor', 'Editor'], ['captions', 'Captions'], ['library', 'Library']].map(([id, label]) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}</button>
          ))}
        </nav>
        <div className="spacer"></div>
        {onDevice && (
          <div className="status-pill device-badge" title="Edits run in this browser with FFmpeg (WebAssembly). Your video is not sent to our servers.">
            🔒 Processed on your device, nothing uploaded
          </div>
        )}
        <div className="status-pill">
          <span className={`status-dot${health === null ? ' pending' : (health.ok ? '' : ' down')}`}></span> {statusText}
        </div>
        {sessionExpired && <button className="btn-export" onClick={handleGetStarted} title="Your session has expired">Sign in again</button>}
        <button className="btn-export" onClick={handleExport} disabled={!activeMedia} title={activeMedia ? `Download “${activeMedia.label}”` : 'Add a file to export'}>Export</button>
      </header>
      {newVersion && (
        <div className="new-version-bar" role="status">
          <span>New version available — reload</span>
          <button className="chip-btn primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}

      <div className="layout">
        <aside className="rail">
          <div className="rail-scroll">
          <h3>Project media</h3>
          {media.length === 0 && <p className="rail-empty">No media yet. Add a video or audio file to start editing.</p>}
          {media.map(item => (
            <ClipRow key={item.id} item={item} active={item.id === activeMediaId} disabled={isCallingAPI && item.id !== activeMediaId} onSelect={() => handleSelectMedia(item)} />
          ))}
          <button className="add-btn" onClick={openFilePicker} disabled={isCallingAPI}>+ Add media</button>
          <h3 className="spaced">Recent jobs</h3>
          {finishedJobs.length === 0 && <p className="rail-empty">Finished edits show up here.</p>}
          {finishedJobs.slice(0, 10).map(job => (
            <button
              type="button"
              key={job.id}
              className="clip"
              disabled={job.resultMessageId === null}
              onClick={() => showMessage(job.resultMessageId)}
              title={job.prompt}
            >
              <div className="thumb">{JOB_ICONS[job.status]}</div>
              <div className="meta">
                <div className="name">{job.prompt}</div>
                <div className="sub">{jobStatusText(job).toLowerCase()} · <TimeAgo at={job.endedAt} /></div>
              </div>
            </button>
          ))}
          </div>

        </aside>

        <div className="main">
          {view === 'editor' && (
            <div className="chat" ref={chatWindowRef}>
              {visibleMessages.map((msg, i) => (
                <React.Fragment key={msg.id}>
                  <div className={`msg ${msg.role === 'user' ? 'user' : 'assistant'}`} data-message-id={msg.id}>
                    {msg.content && <div className="bubble">{msg.content}</div>}
                    {msg.retryText && (
                      <div className="rc-actions">
                        <button className="chip-btn primary" disabled={isCallingAPI} onClick={() => handleSend(msg.retryText)}>↻ Retry</button>
                      </div>
                    )}
                    {msg.videoUrl && renderAttachment(msg)}
                    {msg.captionCard && renderCaptionCard(msg)}
                  </div>
                  {i === 0 && (
                    <div className="chat-suggestions">
                      {sampleCommands.slice(0, 2).map((cmd) => (
                        <button key={cmd.text} className="pchip" onClick={() => handleSampleClick(cmd.text)}>{cmd.icon} {cmd.text}</button>
                      ))}
                    </div>
                  )}
                </React.Fragment>
              ))}
              {isCallingAPI && !messages[messages.length - 1]?.streaming && (
                <div className="msg assistant">
                  <div className="bubble typing" aria-live="polite">
                    <span></span><span></span><span></span>
                    <span className="typing-stage">{(Number.isFinite(turnStatus?.progress) && turnStatus.text) || toolStage || 'Working\u2026'}</span>
                  </div>
                  {turnStatus?.hint && <div className="typing-hint" aria-live="polite">{turnStatus.hint}</div>}
                </div>
              )}
            </div>
          )}

          {view === 'captions' && (
            <div className="view">
              <h2>Captions</h2>
              <p className="lead">
                {activeMedia
                  ? <>Captions are generated for <b>{activeMedia.label}</b>. Pick an action to fill the prompt, or describe what you need in the editor.</>
                  : 'Add a video or audio file, then generate or translate captions for it.'}
              </p>
              <div className="view-actions">
                {captionCommands.map(command => (
                  <button key={command} className="chip-btn" onClick={() => handleSampleClick(command)}>💬 {command}</button>
                ))}
              </div>
              <h3>Caption files</h3>
              {captionFiles.length === 0 && <p className="rail-empty">No captions yet.</p>}
              {captionFiles.map(msg => (
                <div className="file-row" key={msg.id}>
                  <span className="grow">{String(msg.content || 'Captions').replace(/:\s*$/, '')}</span>
                  {msg.videoType === 'subtitle-srt'
                    ? <a className="chip-btn primary" href={msg.videoUrl} download="captions.srt">⬇ SRT</a>
                    : <a className="chip-btn primary" href={msg.vttUrl} download="captions.vtt">⬇ VTT</a>}
                  {msg.videoType !== 'subtitle-srt' && <button className="chip-btn" onClick={() => showMessage(msg.id)}>Show in chat</button>}
                </div>
              ))}
            </div>
          )}

          {view === 'library' && (
            <div className="view">
              <h2>Library</h2>
              <p className="lead">Every clip you opened and every edit result in this session. Any of them can become the clip your next edit applies to. <a href="/legal/licenses.html" target="_blank" rel="noopener">Open-source licenses</a></p>
              {media.length === 0 && <p className="rail-empty">No media yet.</p>}
              <div className="grid">
                {media.map(item => (
                  <div key={item.id} className={`lib-card${item.id === activeMediaId ? ' active' : ''}`}>
                    {item.isAudio
                      ? <audio src={item.url} controls preload="metadata" />
                      : <video src={item.url} controls playsInline preload="metadata" />}
                    <div className="rc-body">
                      <div className="rc-title">
                        {item.label}
                        {item.id === activeMediaId && <span className="rc-badge">Editing this</span>}
                      </div>
                      <div className="rc-sub">{item.isAudio ? 'audio' : 'video'} · {item.kind}</div>
                      <div className="rc-actions">
                        {item.id !== activeMediaId && (
                          <button className="chip-btn primary" disabled={isCallingAPI} onClick={() => handleSelectMedia(item)}>✎ Edit this</button>
                        )}
                        <button className="chip-btn" onClick={() => { downloadFile(item.url, mediaFilename(item)); track('export', { format: String(item.mimeType || 'unknown').split(';')[0].slice(0, 64), placement: 'library' }); track('export_done', { placement: 'library' }); }}>⬇ Download</button>
                        <button className="chip-btn" onClick={() => showMessage(item.id)}>Show in chat</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {TIMELINE_ENABLED && view === 'editor' && activeMedia && !activeMedia.isAudio && (
            <TimelineStrip
              media={activeMedia}
              getVideoEl={() => previewElsRef.current.get(activeMediaIdRef.current)}
              onTrimPrompt={handleSampleClick}
              open={stripOpen}
              onToggle={() => setStripOpen((v) => !v)}
            />
          )}

          <div className="composer-zone" ref={composerZoneRef}>
            <div
              className={`composer${composerActive ? ' active' : ''}`}
              onClick={() => { if (!composerActive) textareaRef.current?.focus(); }}
            >
              <div className="composer-input-row">
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleUpload}
                  accept="video/*,audio/*,image/*,.heic,.heif,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp3,audio/ogg,audio/aac"
                  multiple
                  hidden
                />
                <button className="icon-btn attach-btn" title="Attach video, photo or audio" disabled={isCallingAPI} onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); openFilePicker(); }}>📎</button>
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={videoFileData ? 'Describe the video edit… e.g. “trim seconds 5–15 and add burned-in captions”' : 'Ask anything, or attach a file to edit…'}
                  aria-label="Message input"
                />
                {activeMedia && !activeMedia.isAudio && !activeMedia.mimeType?.startsWith('image/') && (
                  <button className="icon-btn soundtrack-btn" title="Add soundtrack" aria-label="Add soundtrack" disabled={isCallingAPI} onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => { e.stopPropagation(); handleSampleClick(soundtrackPrompt(previewElsRef.current.get(activeMediaIdRef.current)?.duration)); }}>🎵</button>
                )}
                <VoiceButton runPrompt={runVoicePrompt} disabled={false} onNotice={toast} />
                <button className="send-btn" title={isCallingAPI ? 'Stop' : 'Send'} onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); isCallingAPI ? cancelRunning() : handleSend(); }} disabled={!isCallingAPI && !chatInput.trim()}>
                  {isCallingAPI ? '■' : '↑'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`toast${toastText ? ' show' : ''}`} role="status">{toastText}</div>
    </div>
  );
}
