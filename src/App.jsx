import React, { useState, useRef, useEffect, useMemo } from 'react';
import { systemPrompt } from './tools.js';
import { setSampleModeAccessToken, setSampleModeEnabled, setCurrentFileMimeType } from './toolFunctions.js';
import VideoPreview from './VideoPreview.jsx';
import { useCallAPI } from './useCallAPI.js';
import { setFetchAbortSignal } from './abortableFetch.js';
import {
  fetchClientConfig,
  setUploadConsentHandler, getCloudCaptions, setCloudCaptions,
} from './engineMode.js';
import { checkClip, DEFAULT_CLIP_LIMITS } from './wasm/clipLimits.js';
import logoUrl from '../logo.png';
import explainerVideoUrl from '../docs/finalcap-explainer.mp4';
import './App.css';

// Sample commands for quick access
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

const landingStats = [
  ['500+', 'FFmpeg filters & effects'],
  ['11', 'Caption languages'],
  ['4K', 'Max export resolution'],
  ['~10s', 'Typical edit turnaround']
];

const landingFeatures = [
  ['💬', 'Chat to edit', 'Describe the edit in words. Trim, crop, resize, rotate, overlay text — the AI plans the filter chain for you.', 'trim seconds 5–15'],
  ['🔤', 'AI captions', 'Generate accurate subtitles, translate across 11 languages, and burn them in with styled typography.', 'add Spanish captions'],
  ['🎨', 'Color & effects', 'Brightness, saturation, hue, vignette, film looks — 500+ real FFmpeg filters, not presets.', 'make it moodier'],
  ['📱', 'Social presets', 'One sentence to 9:16 for Reels and TikTok, 1:1 for feeds, or 16:9 for YouTube — reframed automatically.', 'make it vertical'],
  ['⚡', 'Speed & audio', 'Time-remap, volume, fade, loudness normalization, EQ — full audio pipeline included.', '2x speed, keep pitch'],
  ['📦', 'Any format out', 'MP4, WebM, MOV, GIF, MP3 extraction — server-side rendering up to 4K.', 'export as GIF']
];

const landingSteps = [
  ['Drop in your video', 'Upload a file or try the built-in sample. Your media stays private to your session.', '“BigBuckBunny.mp4 attached ✓”'],
  ['Describe the edit', "Type it like you'd tell an editor. Ask follow-ups, stack changes, undo anything.", '“Cut the boring middle, punch up the colors”'],
  ['Download the result', "Rendering happens in the background while you keep working. Grab the MP4 when it's ready.", '“✓ Done in 11s — Download MP4”']
];

const landingExamples = [
  ['🏙️', 'linear-gradient(135deg,#1a2233,#2c3a58)', '“Convert to 9:16 for Instagram Reels”', '✓ Cropped 1080×1920 · 8s'],
  ['🎤', 'linear-gradient(135deg,#231a33,#3a2c58)', '“Generate captions and translate to Spanish”', '✓ 47 lines · burned in · 14s'],
  ['🌅', 'linear-gradient(135deg,#1a3327,#2c5844)', '“Trim 0:05–0:15, 2x speed, boost saturation”', '✓ 3 edits chained · 9s']
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

// Welcome message with sample links
const welcomeMessage = {
  role: 'assistant',
  content: 'Welcome to FinalCap! Upload a video or audio file to get started, then tell me what to do with it — or pick a starting point below.',
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

export default function App() {
  const [showLanding, setShowLanding] = useState(true); // Show landing page initially
  const [loaded, setLoaded] = useState(true); // Server-side processing doesn't require loading
  const [processing, setProcessing] = useState(false); // Track ffmpeg processing state
  const [authError, setAuthError] = useState(null); // Track authentication errors
  const [sessionExpired, setSessionExpired] = useState(false); // Set when the server rejects the login session
  const [isCallingAPI, setIsCallingAPI] = useState(false); // Track API call state
  const videoRef = useRef(null);
  const messageRef = useRef(null);

  const [messages, setMessages] = useState([{ role: 'system', content: systemPrompt, id: -1 }, welcomeMessage]);
  const [chatInput, setChatInput] = useState('');
  const [videoFileData, setVideoFileData] = useState(null);
  const [uploadedVideos, setUploadedVideos] = useState([]); // Array of {data: Uint8Array, url: string, name: string, mimeType: string}
  const [fileType, setFileType] = useState('video'); // 'video' or 'audio'
  const [fileMimeType, setFileMimeType] = useState(''); // Store MIME type for proper detection
  const [isSampleMode, setIsSampleMode] = useState(false);
  const [sampleAccessToken, setSampleAccessTokenState] = useState(null);
  const messageIdCounterRef = useRef(1); // Counter for unique message IDs
  const chatWindowRef = useRef(null);
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
  const [cloudCaptionsAvailable, setCloudCaptionsAvailable] = useState(false);
  const [cloudCaptions, setCloudCaptionsState] = useState(() => getCloudCaptions());
  const [, setTurnStatus] = useState(null); // { text, progress?, etaSeconds? } for the running job
  const [uploadConsent, setUploadConsent] = useState(null); // { tool, reason, uploads, resolve } while asking
  const currentJobRef = useRef(null); // { id, controller } while a prompt is running
  // Which clip the next edit applies to. Bytes are kept per media message so any
  // clip (an upload or an earlier result) can become the edit target again.
  const [activeMediaId, setActiveMediaId] = useState(null);
  const activeMediaIdRef = useRef(null);
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
    el.style.height = 'auto';
    const cap = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches ? 120 : 200;
    el.style.height = Math.min(el.scrollHeight, cap) + 'px';
  }, [chatInput, showLanding, view]);

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
        // Check for error parameters in URL
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

          // Clean up the URL
          window.history.replaceState({}, '', '/');
          return;
        }

        const response = await fetch('/api/auth/status', {
          headers: getSampleAuthHeaders()
        });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated) {
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

  // Check if user is returning from successful payment
  useEffect(() => {
    const verifyPayment = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const sessionId = urlParams.get('session_id');

      if (sessionId && window.location.pathname === '/success') {
        try {
          // Verify the session with the backend
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
              // Hide landing page and show editor after verified payment
              setShowLanding(false);
              // Clean up the URL without reloading the page
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
      setCloudCaptionsAvailable(Boolean(config?.captions?.cloud));
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
    uploadConsent?.resolve(allowed);
    setUploadConsent(null);
  };

  const toggleCloudCaptions = (enabled) => {
    setCloudCaptions(enabled);
    setCloudCaptionsState(enabled);
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

  const addMessage = ({
    text,
    isUser = false,
    videoUrl = null,
    videoType = 'processed',
    mimeType = null,
    showSampleLinks = false,
    vttUrl = null
  }) => {
    // Whatever a cancelled job still reports (its aborted request) is not shown.
    if (currentJobRef.current?.controller.signal.aborted) return;
    const id = messageIdCounterRef.current++;
    let parentId = null;
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
    setMessages(prev => [...prev, { role: isUser ? 'user' : 'assistant', content: text, videoUrl, videoType, mimeType, id, excludeFromAPI: true, showSampleLinks, vttUrl, parentId }]);
  };

  // Tools hand back edited bytes through this setter, then post the result message.
  const setWorkingVideoFileData = (data) => {
    if (currentJobRef.current?.controller.signal.aborted) return;
    pendingResultBytesRef.current = data;
    setVideoFileData(data);
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
      toast(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`);

      // Process all files
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Determine if it's audio or video
        const isAudio = file.type.startsWith('audio/');
        const isVideo = file.type.startsWith('video/');

        if (!isAudio && !isVideo) {
          toast(`“${file.name}” is not a valid audio or video file`);
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

        // Read file as array buffer for processing
        const arrayBuffer = await file.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const url = URL.createObjectURL(file);

        // Store the file data
        newVideos.push({
          id: messageIdCounterRef.current++,
          data: data,
          url: url,
          name: file.name,
          mimeType: file.type,
          isAudio: isAudio
        });

        mediaBytesRef.current.set(newVideos[newVideos.length - 1].id, data);

        // For the first file, set it as the main video for backward compatibility
        if (i === 0) {
          activateMedia(newVideos[0].id);
          setVideoFileData(data);
          setFileType(isAudio ? 'audio' : 'video');
          setFileMimeType(file.type);
          setCurrentFileMimeType(file.type);
        }
      }

      if (newVideos.length === 0) {
        if (!hasError) toast('No valid files were uploaded');
        e.target.value = '';
        return;
      }

      // Update the uploaded videos list
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
        apiContent: `A ${video.isAudio ? 'audio' : 'video'} file is available for editing.`,
        id: video.id
      }));

      setMessages(prev => [...prev, ...uploadedMessages]);
      if (!hasError) toast(`${newVideos.length} file${newVideos.length > 1 ? 's' : ''} uploaded and ready for editing${newVideos.length > 1 ? ' or transitions' : ''}`);
    } catch (error) {
      toast('Error uploading files: ' + error.message);
    }

    // Clear the input so the same files can be uploaded again if needed
    e.target.value = '';
  };

  const handleSend = async (textOverride = null) => {
    const hasStringOverride = typeof textOverride === 'string';
    const text = (hasStringOverride ? textOverride : chatInput).trim();
    if (!text || isCallingAPI) return;
    if (!hasStringOverride) setChatInput('');
    const newMessage = { role: 'user', content: text, id: messageIdCounterRef.current++ };
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
  };

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

  const handleExport = () => {
    if (!activeMedia) return toast('Add a video or audio file first');
    downloadFile(activeMedia.url, mediaFilename(activeMedia));
    toast(`Exported “${activeMedia.label}”`);
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const handleGetStarted = () => {
    // Redirect to Google login endpoint
    window.location.href = '/auth/google';
  };

  const loadSampleVideo = async () => {
    // Note: This bypasses authentication for demo purposes
    // In production, consider requiring authentication
    setShowLanding(false);
    // Sample video path - using BigBuckBunny.mp4 as specified
    const sampleVideoUrl = '/BigBuckBunny.mp4';

    try {
      await getSampleAccessToken();

      // Fetch the sample video
      const response = await fetch(sampleVideoUrl);
      if (!response.ok) {
        // If sample video doesn't exist, just show a message
        toast('Sample video not available. Please upload your own video.');
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

      // Show selected video
      const uploadedMessage = { role: 'user', content: '', apiContent: 'A video file is available for editing.', videoUrl: url, videoType: 'original', mimeType: 'video/mp4', name: 'BigBuckBunny.mp4', id: messageIdCounterRef.current++ };
      mediaBytesRef.current.set(uploadedMessage.id, data);
      activateMedia(uploadedMessage.id);
      setMessages(prev => [...prev, uploadedMessage]);
      toast('Sample video loaded and ready for editing');

    } catch (error) {
      toast('Error loading sample video. Please upload your own video.');
    }
  };

  // Landing page component
  if (showLanding) {
    return (
      <div className="fc landing">
        <nav className="lp-nav">
          <div className="wrap">
            <a className="lp-brand" href="#">
              <img src={logoUrl} alt="" />
              FinalCap
            </a>
            <div className="lp-nav-links">
              <a href="#features">Features</a>
              <a href="#how">How it works</a>
              <a href="#examples">Examples</a>
            </div>
            <div className="spacer" />
            <button className="btn-ghost" onClick={handleGetStarted}>Sign in</button>
            <button className="btn-primary" onClick={handleGetStarted}>Get started free</button>
          </div>
        </nav>

        <header className="hero">
          <div className="wrap">
            <div>
              <div className="eyebrow"><span className="dot" /> AI video editor</div>
              <h1>Edit video by <span className="grad">describing it.</span></h1>
              <p className="hero-sub">Type what you want — trim, captions, color, speed, formats. FinalCap turns your words into frame-perfect edits in seconds. No timeline. No learning curve.</p>

              {authError && <div className="auth-error">{authError}</div>}

              <div className="cta-row">
                <button className="btn-primary big" onClick={handleGetStarted}>Start editing — it's free</button>
                <button className="btn-secondary" onClick={loadSampleVideo}><span className="play">▶</span> Watch it work</button>
              </div>
              <div className="micro-proof">
                <span><span className="ok">✓</span> Free to try</span>
                <span><span className="ok">✓</span> No credit card</span>
                <span><span className="ok">✓</span> Runs in your browser</span>
              </div>
            </div>
            <div className="hero-visual" aria-hidden="true">
              <div className="editor-card">
                <div className="ec-video">
                  <video src={explainerVideoUrl} autoPlay muted loop playsInline preload="metadata" />
                  <span className="tag">preview</span>
                </div>
                <div className="ec-chat">
                  <div className="ec-bubble user">Convert this to 9:16 for Reels and add burned-in captions</div>
                  <div className="ec-bubble ai"><b>✓ Done in 11s</b> — cropped to 1080×1920, captions burned in.</div>
                </div>
              </div>
              <div className="float-card fc-1">
                <div className="ic">💬</div>
                <div>Captions generated<small>English → Spanish available</small></div>
              </div>
              <div className="float-card fc-2">
                <div className="ic">⚙️</div>
                <div>Rendering 4K…<div className="pbar-mini"><i /></div></div>
              </div>
            </div>
          </div>
        </header>

        <div className="stats">
          <div className="wrap">
            {landingStats.map(([num, label]) => (
              <div className="stat" key={label}>
                <div className="num"><span className="grad">{num}</span></div>
                <div className="lbl">{label}</div>
              </div>
            ))}
          </div>
        </div>

        <section className="block" id="features">
          <div className="wrap">
            <div className="kicker reveal">Features</div>
            <h2 className="sec reveal">Everything a timeline does, in one sentence</h2>
            <p className="sec-sub reveal">FinalCap understands plain language and maps it to professional-grade FFmpeg operations.</p>
            <div className="feat-grid">
              {landingFeatures.map(([icon, name, description, example]) => (
                <div className="feat reveal" key={name}>
                  <div className="fic">{icon}</div>
                  <h3>{name}</h3>
                  <p>{description}</p>
                  <span className="try">Try: “{example}” →</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="block alt" id="how">
          <div className="wrap">
            <div className="kicker reveal">How it works</div>
            <h2 className="sec reveal">Three steps. Zero timeline.</h2>
            <p className="sec-sub reveal">If you can describe it, you can edit it.</p>
            <div className="steps">
              {landingSteps.map(([name, description, example], index) => (
                <div className="step reveal" key={name}>
                  <div className="n">{index + 1}</div>
                  <h3>{name}</h3>
                  <p>{description}</p>
                  <div className="eg">{example}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="block" id="examples">
          <div className="wrap">
            <div className="kicker reveal">Examples</div>
            <h2 className="sec reveal">One sentence in, finished video out</h2>
            <p className="sec-sub reveal">Real prompts, real results.</p>
            <div className="examples">
              {landingExamples.map(([icon, background, prompt, result]) => (
                <div className="ex reveal" key={prompt}>
                  <div className="thumb" style={{ background }}>{icon}<span className="arrow">→</span></div>
                  <div className="cap">
                    <div className="q">{prompt}</div>
                    <div className="a">{result}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="wrap">
          <div className="cta-band reveal">
            <h2>Your next edit is one sentence away.</h2>
            <p>Join free, upload a video, and describe your first edit. It takes less than a minute.</p>
            <div className="cta-row">
              <button className="btn-primary big" onClick={handleGetStarted}>Start editing free</button>
              <button className="btn-secondary" onClick={loadSampleVideo}>Try with a sample video</button>
            </div>
          </div>
        </div>

        <footer>
          <div className="wrap">
            <div className="spacer" />
            <a href="/legal/privacy.html">Privacy</a>
            <a href="/legal/terms.html">Terms</a>
            <a href="/legal/licenses.html">Open-source licenses</a>
            <a href="/legal/support.html">Contact</a>
          </div>
        </footer>
      </div>
    );
  }

  const visibleMessages = messages.slice(1).filter(isVisibleMessage);
  const finishedJobs = jobs.filter(job => job.status !== 'running');
  const originals = media.filter(item => item.kind === 'original');
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
      <div className={`result-card${isActive ? ' active' : ''}`}>
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
        <VideoPreview
          key={`preview-${msg.id}`}
          videoUrl={msg.videoUrl}
          title={getVideoTitle(msg.videoType)}
          mimeType={msg.mimeType}
          vttUrl={msg.vttUrl || null}
        />
        <div className="rc-body">
          <div className="rc-title">
            {item.kind === 'result' ? `✓ ${item.label}` : item.label}
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
        </div>
      </div>
    );
  };

  return (
    <div className="fc editor">
      {uploadConsent && (
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
      <header className="topbar">
        <div className="brand">
          <img src={logoUrl} alt="" />
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
                    {msg.videoUrl && renderAttachment(msg)}
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
                    <span className="typing-stage">{toolStage || 'Working\u2026'}</span>
                  </div>
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
              <p className="lead">Every upload and edit result in this session. Any of them can become the clip your next edit applies to.</p>
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
                        <button className="chip-btn" onClick={() => downloadFile(item.url, mediaFilename(item))}>⬇ Download</button>
                        <button className="chip-btn" onClick={() => showMessage(item.id)}>Show in chat</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="composer-zone">
            <div className="composer">
              <div className="attachments">
                {originals.map(item => (
                  <div key={item.id} className={`attach${item.id === activeMediaId ? ' active' : ''}`}>
                    <MediaThumb item={item} />
                    <div className="aname" title={item.label}>{item.label}</div>
                    <button className="ax" title="Remove from project" disabled={isCallingAPI} onClick={() => removeMedia(item)}>×</button>
                  </div>
                ))}
              </div>
              <div className="composer-row">
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleUpload}
                  accept="video/*,audio/*,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp3,audio/ogg,audio/aac"
                  multiple
                  hidden
                />
                <button className="icon-btn" title="Attach video or audio" disabled={isCallingAPI} onClick={openFilePicker}>📎</button>
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={videoFileData ? 'Describe the video edit… e.g. “trim seconds 5–15 and add burned-in captions”' : 'Ask anything, or attach a file to edit…'}
                />
                <button className="send-btn" title={isCallingAPI ? 'Stop' : 'Send'} onClick={() => isCallingAPI ? cancelRunning() : handleSend()} disabled={!isCallingAPI && !chatInput.trim()}>
                  {isCallingAPI ? '■' : '↑'}
                </button>
              </div>
              <div className="composer-foot">
                <span className="hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <a href="/legal/licenses.html" target="_blank" rel="noopener">Open-source licenses</a></span>
                {onDevice && cloudCaptionsAvailable && (
                  <label className="cloud-captions" title="Off: captions are transcribed on this device. On: the audio track (never the video) is uploaded for more accurate transcription.">
                    <input type="checkbox" checked={cloudCaptions} onChange={(e) => toggleCloudCaptions(e.target.checked)} />
                    Cloud captions (uploads audio only)
                  </label>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`toast${toastText ? ' show' : ''}`} role="status">{toastText}</div>
    </div>
  );
}
