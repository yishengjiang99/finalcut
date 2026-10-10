import React, { useState, useRef, useEffect, useMemo } from 'react';
import { systemPrompt } from './tools.js';
import { setSampleModeAccessToken, setSampleModeEnabled, setCurrentFileMimeType } from './toolFunctions.js';
import VideoPreview from './VideoPreview.jsx';
import { useCallAPI } from './useCallAPI.js';
import { setFetchAbortSignal } from './abortableFetch.js';
import logoUrl from '../logo.png';
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

const landingTools = [
  ['✂️ Video Editing', 'Trim, crop, resize, and rotate'],
  ['🎨 Visual Effects', 'Brightness, hue, saturation, text'],
  ['🎵 Audio Tools', 'Volume, fade, equalizer, filters'],
  ['⚡ Speed Control', 'Speed up or slow down media'],
  ['📱 Social Media', 'Instagram, TikTok, YouTube presets'],
  ['🔄 Format Conversion', 'Convert MP4, WebM, MOV formats'],
  ['💬 AI Captioning', 'Generate and translate subtitles']
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

function Elapsed({ job }) {
  const now = useNow(1000, !job.endedAt);
  return <span className="elapsed">{Math.max(0, Math.round(((job.endedAt || now) - job.startedAt) / 1000))}s</span>;
}

function TimeAgo({ at }) {
  const minutes = Math.floor((useNow(30000) - at) / 60000);
  if (minutes < 1) return 'just now';
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

const JOB_STATUS_TEXT = { done: 'Done', error: 'Failed', cancelled: 'Cancelled' };
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
  const [dockOpen, setDockOpen] = useState(false);
  const [compareIds, setCompareIds] = useState(() => new Set());
  const [toastText, setToastText] = useState('');
  const toastTimerRef = useRef(null);
  const jobIdCounterRef = useRef(1);
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
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [chatInput, showLanding, view]);

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

  const getSampleAccessToken = async () => {
    if (sampleAccessToken) return sampleAccessToken;

    if (window.__FINALCUT_SAMPLE_TOKEN_PROMISE__) {
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
  });

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files || files.length === 0) return;

    try {
      const newVideos = [];
      let hasError = false;

      // Show uploading status
      const uploadingMessage = {
        role: 'user',
        content: `Uploading ${files.length} file${files.length > 1 ? 's' : ''}...`,
        excludeFromAPI: true,
        id: messageIdCounterRef.current++
      };
      setMessages(prev => [...prev, uploadingMessage]);

      // Process all files
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Determine if it's audio or video
        const isAudio = file.type.startsWith('audio/');
        const isVideo = file.type.startsWith('video/');

        if (!isAudio && !isVideo) {
          addMessage({ text: `Error: File "${file.name}" is not a valid audio or video file.` });
          hasError = true;
          continue;
        }

        // Read file as array buffer for server-side processing
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
        addMessage({ text: 'Error: No valid files were uploaded.' });
        return;
      }

      // Update the uploaded videos list
      setUploadedVideos(prev => [...prev, ...newVideos]);
      setIsSampleMode(false);

      // Show all uploaded files in the chat
      const uploadedMessages = newVideos.map((video, index) => ({
        role: 'user',
        content: `Uploaded ${video.isAudio ? 'audio' : 'video'}: ${video.name}`,
        videoUrl: video.url,
        videoType: 'original',
        mimeType: video.mimeType,
        name: video.name,
        apiContent: `A ${video.isAudio ? 'audio' : 'video'} file is available for editing.`,
        id: video.id
      }));

      const summaryMessage = {
        role: 'user',
        content: `${newVideos.length} file${newVideos.length > 1 ? 's' : ''} uploaded and ready for editing${newVideos.length > 1 ? ' or transitions' : ''}.`,
        excludeFromAPI: true,
        id: messageIdCounterRef.current++
      };

      // Update UI state with uploaded messages
      setMessages(prev => [...prev, ...uploadedMessages, summaryMessage]);
    } catch (error) {
      addMessage({ text: 'Error uploading files: ' + error.message });
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

    // Track this prompt as a job in the processing dock; the controller lets it be cancelled.
    const controller = new AbortController();
    const job = { id: jobIdCounterRef.current++, prompt: text, status: 'running', startedAt: Date.now(), endedAt: null, resultMessageId: null };
    currentJobRef.current = { id: job.id, controller };
    pendingResultBytesRef.current = null;
    setFetchAbortSignal(controller.signal);
    setJobs(prev => [job, ...prev]);
    setDockOpen(true);

    let status;
    try {
      // callAPI appends to the array it is given; hand it a copy, not the array held in state.
      status = await callAPI([...newMessages], { signal: controller.signal });
    } finally {
      currentJobRef.current = null;
      setFetchAbortSignal(null);
    }
    if (controller.signal.aborted) status = 'cancelled';
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: status || 'done', endedAt: Date.now() } : j));
    if (status === 'cancelled') addMessage({ text: `Cancelled: “${text}”.` });
  };

  const cancelJob = (job) => {
    if (currentJobRef.current?.id === job.id) currentJobRef.current.controller.abort();
  };

  const dismissJob = (job) => {
    setJobs(prev => prev.filter(j => j.id !== job.id));
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
      addMessage({ text: `Undid “${item.label}”. Your next edit applies to “${parent.label}”.` });
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
        addMessage({ text: 'Sample video not available. Please upload your own video.' });
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
      const uploadedMessage = { role: 'user', content: 'Selected sample video:', apiContent: 'A video file is available for editing.', videoUrl: url, videoType: 'original', mimeType: 'video/mp4', name: 'BigBuckBunny.mp4', id: messageIdCounterRef.current++ };
      mediaBytesRef.current.set(uploadedMessage.id, data);
      activateMedia(uploadedMessage.id);
      const userMessage = { role: 'user', content: 'Sample video loaded and ready for editing.', excludeFromAPI: true, id: messageIdCounterRef.current++ };

      setMessages(prev => [...prev, uploadedMessage, userMessage]);

    } catch (error) {
      addMessage({ text: 'Error loading sample video. Please upload your own video.' });
    }
  };

  // Landing page component
  if (showLanding) {
    return (
      <div className="fc landing">
        <div className="landing-main">
          <div className="landing-inner">
            <img className="landing-logo" src={logoUrl} alt="" />
            <h1>FinalCap</h1>
            <p className="tagline">AI Video Editor — chat to edit, caption, and export</p>

            {authError && <div className="auth-error">{authError}</div>}

            <h2>Available Tools</h2>
            <div className="tool-grid">
              {landingTools.map(([name, description]) => (
                <div className="tool" key={name}>
                  <h3>{name}</h3>
                  <p>{description}</p>
                </div>
              ))}
            </div>

            <div className="landing-cta">
              <button className="cta-primary" onClick={handleGetStarted}>Get Started</button>
              <button className="cta-secondary" onClick={loadSampleVideo}>Try with Sample Video</button>
            </div>
          </div>
        </div>
        <footer>
          <p>© 2026 FinalCap. All rights reserved.</p>
          <p>AI-powered video editing made simple</p>
        </footer>
      </div>
    );
  }

  const visibleMessages = messages.slice(1).filter(isVisibleMessage);
  const runningJobs = jobs.filter(job => job.status === 'running');
  const finishedJobs = jobs.filter(job => job.status !== 'running');
  const originals = media.filter(item => item.kind === 'original');
  const captionFiles = messages.filter(msg => msg.videoUrl && (msg.videoType === 'subtitle-srt' || msg.vttUrl));
  const showTyping = isCallingAPI && !processing && !messages[messages.length - 1]?.streaming;
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
        <div className="status-pill">
          <span className={`status-dot${health === null ? ' pending' : (health.ok ? '' : ' down')}`}></span> {statusText}
        </div>
        <button className="btn-export" onClick={handleExport} disabled={!activeMedia} title={activeMedia ? `Download “${activeMedia.label}”` : 'Add a file to export'}>Export</button>
      </header>

      <div className="layout">
        <aside className="rail">
          <h3>Project media</h3>
          {media.length === 0 && <p className="rail-empty">No media yet. Add a video or audio file to start editing.</p>}
          {media.map(item => (
            <ClipRow key={item.id} item={item} active={item.id === activeMediaId} disabled={isCallingAPI && item.id !== activeMediaId} onSelect={() => handleSelectMedia(item)} />
          ))}
          <button className="add-btn" onClick={openFilePicker} disabled={isCallingAPI}>+ Add media</button>
          <h3 className="spaced">Recent jobs</h3>
          {finishedJobs.length === 0 && <p className="rail-empty">Finished edits show up here.</p>}
          {finishedJobs.map(job => (
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
                <div className="sub">{JOB_STATUS_TEXT[job.status].toLowerCase()} · <TimeAgo at={job.endedAt} /></div>
              </div>
            </button>
          ))}
        </aside>

        <div className="main">
          {view === 'editor' && (
            <div className="chat" ref={chatWindowRef}>
              {visibleMessages.map((msg) => (
                <div key={msg.id} className={`msg ${msg.role === 'user' ? 'user' : 'assistant'}`} data-message-id={msg.id}>
                  {msg.content && <div className="bubble">{msg.content}</div>}
                  {msg.videoUrl && renderAttachment(msg)}
                </div>
              ))}
              {showTyping && (
                <div className="msg assistant">
                  <div className="bubble typing"><span></span><span></span><span></span></div>
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
            {/* Processing dock: one entry per sent prompt */}
            <div className={`dock${dockOpen ? '' : ' collapsed'}`}>
              <button type="button" className="dock-head" onClick={() => setDockOpen(open => !open)}>
                <span className={`dot-pulse${runningJobs.length > 0 ? '' : ' idle'}`}></span>
                <span className="title">Processing</span>
                <span className="count">
                  {runningJobs.length > 0 ? `${runningJobs.length} running` : (jobs.length > 0 ? `${jobs.length} done` : '0 running')}
                </span>
                <span className="chev">▲</span>
              </button>
              <div className="dock-body">
                {jobs.length === 0 && (
                  <div className="dock-empty">Nothing processing right now.<br />Send an edit and watch it run here.</div>
                )}
                {jobs.map(job => (
                  <div key={job.id} className={`job ${job.status}`}>
                    <div className="jthumb">🎬</div>
                    <div className="jmain">
                      <div className="jtitle" title={job.prompt}>{job.prompt}</div>
                      <div className="jstage">
                        {job.status === 'running'
                          ? (processing ? 'Processing with ffmpeg…' : 'Planning the edit…')
                          : JOB_STATUS_TEXT[job.status]}
                      </div>
                      <div className="pbar"><i></i></div>
                      <div className="jfoot">
                        <Elapsed job={job} />
                        {job.status === 'running' && <button className="jbtn" onClick={() => cancelJob(job)}>Cancel</button>}
                        {job.status !== 'running' && job.resultMessageId !== null && (
                          <button className="jbtn open" onClick={() => showMessage(job.resultMessageId)}>Open result</button>
                        )}
                        {job.status !== 'running' && <button className="jbtn" onClick={() => dismissJob(job)}>Dismiss</button>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="composer">
              <div className="prompt-chips">
                {sampleCommands.map((cmd) => (
                  <button key={cmd.text} className="pchip" onClick={() => handleSampleClick(cmd.text)}>{cmd.icon} {cmd.text}</button>
                ))}
              </div>
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
                  rows={2}
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
                <button className="send-btn" title={isCallingAPI ? 'Working…' : 'Send'} onClick={() => handleSend()} disabled={isCallingAPI || !chatInput.trim()}>
                  {isCallingAPI ? <span className="spin"></span> : '↑'}
                </button>
              </div>
              <div className="composer-foot">
                <span className="hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span>
                {media.length > 0 && (
                  <select
                    className="target-select"
                    title="Which clip this edit applies to"
                    value={activeMediaId ?? ''}
                    disabled={isCallingAPI}
                    onChange={(e) => handleSelectMedia(mediaById(Number(e.target.value)))}
                  >
                    {activeMedia === null && <option value="">Apply to: (choose a clip)</option>}
                    {media.map(item => (
                      <option key={item.id} value={item.id}>Apply to: {item.label} ({item.kind})</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
            <p className="copyright">© 2026 FinalCap. All rights reserved.</p>
          </div>
        </div>
      </div>

      <div className={`toast${toastText ? ' show' : ''}`} role="status">{toastText}</div>
    </div>
  );
}
