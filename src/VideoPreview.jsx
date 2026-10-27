import React, { useState, useRef, useEffect, useCallback } from 'react';
import { activeLine, overlayFontPx, overlayPlacement, overlayFontFamily } from './captionTrack.js';

const FPS_STEPS = [24, 25, 30, 60];

export default function VideoPreview({ captionTrack = null, videoUrl, title = 'Video Preview', defaultCollapsed = false, mimeType = null, vttUrl = null, subtitleLang = 'en', subtitleLabel = 'English', onVideoMount = null }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [viewH, setViewH] = useState(0); // rendered picture height, to size the caption overlay
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fpsIdx, setFpsIdx] = useState(2); // index into FPS_STEPS; default 30
  const fps = FPS_STEPS[fpsIdx];
  const playAfterExpandRef = useRef(false);
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [showThumb, setShowThumb] = useState(true); // thumbnail first; tap to open the full player
  const [poster, setPoster] = useState(null); // first-frame JPEG data URL for the thumbnail card
  // Audio files skip the video thumbnail (isAudio state is only known after the player mounts).
  const looksLikeAudio = mimeType
    ? mimeType.startsWith('audio/')
    : ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a', 'audio/'].some((s) => (videoUrl || '').includes(s));
  const [isAudio, setIsAudio] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [corsError, setCorsError] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  // Optional: hand the live <video> element to the parent (the timeline strip
  // follows it and scrubs it). Read through a ref so a changing callback
  // identity never re-runs these effects; the element only exists once the
  // thumbnail is opened, which the showThumb/isCollapsed deps track.
  const mountCbRef = useRef(null);
  mountCbRef.current = onVideoMount;
  useEffect(() => {
    mountCbRef.current?.(videoRef.current);
  }, [showThumb, isCollapsed]);
  useEffect(() => () => { mountCbRef.current?.(null); }, []);
  const rafRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const autoRecordStartedRef = useRef(false);
  const autoMutedRef = useRef(false);

  // The live caption overlay is sized from the rendered picture height.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !captionTrack) return undefined;
    const measure = () => setViewH(el.clientHeight || el.getBoundingClientRect().height || 0);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [captionTrack, isCollapsed, showThumb]);

  const renderFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext('2d');
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      if (e.name === 'SecurityError') {
        setCorsError(true);
        return;
      }
    }
    // Render active subtitle cues onto canvas (no native overlay)
    const track = video.textTracks && video.textTracks[0];
    if (track && track.activeCues && track.activeCues.length > 0) {
      // Keep captions readable without letting them cover most of a vertical clip.
      const fontSize = Math.max(14, Math.min(30, Math.floor(canvas.height * 0.032)));
      ctx.font = `bold ${fontSize}px Arial, sans-serif`;
      ctx.textAlign = 'center';
      const seenTexts = new Set();
      for (let i = 0; i < track.activeCues.length; i++) {
        const cue = track.activeCues[i];
        const cueKey = String(cue.text || '').replace(/\s+/g, ' ').trim();
        // Browsers can expose the same cue more than once while a VTT track is
        // loading. Never composite duplicate text into the same frame.
        if (!cueKey || seenTexts.has(cueKey)) continue;
        seenTexts.add(cueKey);
        const rawLines = (() => {
          try {
            const div = document.createElement('div');
            div.innerHTML = cue.text || '';
            return (div.textContent || '').split('\n');
          } catch (_) { return (cue.text || '').split('\n'); }
        })();
        const maxTextWidth = canvas.width * 0.82;
        const wrappedLines = [];
        rawLines.forEach((rawLine) => {
          const words = String(rawLine).trim().split(/\s+/).filter(Boolean);
          let line = '';
          words.forEach((word) => {
            const next = line ? `${line} ${word}` : word;
            if (line && ctx.measureText(next).width > maxTextWidth) {
              wrappedLines.push(line);
              line = word;
            } else {
              line = next;
            }
          });
          if (line) wrappedLines.push(line);
        });
        const lines = wrappedLines.length > 2
          ? [wrappedLines[0], `${wrappedLines.slice(1).join(' ')}…`]
          : wrappedLines;
        const lineHeight = fontSize * 1.4;
        const totalHeight = lines.length * lineHeight;
        const baseY = canvas.height * 0.88 - totalHeight / 2;
        const x = canvas.width / 2;
        let maxWidth = 0;
        lines.forEach(line => {
          const w = ctx.measureText(line).width;
          if (w > maxWidth) maxWidth = w;
        });
        const padX = 14, padY = 8;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x - maxWidth / 2 - padX, baseY - fontSize - padY, maxWidth + padX * 2, totalHeight + padY * 2);
        lines.forEach((line, idx) => {
          const y = baseY + idx * lineHeight;
          ctx.strokeStyle = 'rgba(0,0,0,0.9)';
          ctx.lineWidth = 3;
          ctx.strokeText(line, x, y);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(line, x, y);
        });
      }
    }
    rafRef.current = requestAnimationFrame(renderFrame);
  }, []);

  useEffect(() => {
    if (videoRef.current) {
      const video = videoRef.current;
      
      // Detect if it's an audio file - use MIME type if provided, otherwise fall back to URL detection
      let isAudioFile = false;
      if (mimeType) {
        isAudioFile = mimeType.startsWith('audio/');
      } else if (videoUrl) {
        // Fallback to URL detection if MIME type not provided
        isAudioFile = videoUrl.includes('.mp3') || 
          videoUrl.includes('.wav') || 
          videoUrl.includes('.ogg') || 
          videoUrl.includes('.aac') ||
          videoUrl.includes('.flac') ||
          videoUrl.includes('.m4a') ||
          videoUrl.includes('audio/');
      }
      setIsAudio(isAudioFile);
      
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setCorsError(false);
      autoRecordStartedRef.current = false;
      cancelAnimationFrame(rafRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setDownloadUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      
      video.load();
      
      const handleLoadedMetadata = () => {
        setDuration(video.duration);
        if (!isAudioFile && canvasRef.current) {
          canvasRef.current.width = video.videoWidth || 640;
          canvasRef.current.height = video.videoHeight || 360;
        }
        // Always keep native captions hidden — we render them ourselves on canvas
        if (video.textTracks) {
          for (let i = 0; i < video.textTracks.length; i++) {
            video.textTracks[i].mode = 'hidden';
          }
        }
        if (!isAudioFile) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(renderFrame);
        }
      };
      
      const handleTimeUpdate = () => {
        setCurrentTime(video.currentTime);
      };

      // Also hide track mode when tracks change (e.g. after track loads)
      const handleTrackChange = () => {
        if (video.textTracks) {
          for (let i = 0; i < video.textTracks.length; i++) {
            video.textTracks[i].mode = 'hidden';
          }
        }
      };
      
      video.addEventListener('loadedmetadata', handleLoadedMetadata);
      video.addEventListener('timeupdate', handleTimeUpdate);
      if (video.textTracks && typeof video.textTracks.addEventListener === 'function') {
        video.textTracks.addEventListener('change', handleTrackChange);
      }
      
      return () => {
        video.removeEventListener('loadedmetadata', handleLoadedMetadata);
        video.removeEventListener('timeupdate', handleTimeUpdate);
        if (video.textTracks && typeof video.textTracks.removeEventListener === 'function') {
          video.textTracks.removeEventListener('change', handleTrackChange);
        }
        cancelAnimationFrame(rafRef.current);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      };
    }
    // showThumb/isCollapsed: the player's <video> only mounts after the thumbnail is tapped (and
    // remounts after collapse), so attach the listeners to that element when it appears. Without
    // this the canvas was never sized or drawn: a black 300x150 player.
  }, [videoUrl, mimeType, renderFrame, showThumb, isCollapsed]);

  useEffect(() => {
    return () => {
      setDownloadUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  const handleStartRecording = useCallback(async ({ auto = false } = {}) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') return true;
    chunksRef.current = [];
    setDownloadUrl(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    try {
      const outStream = canvas.captureStream(30);
      try {
        const vStream = video.captureStream ? video.captureStream() : null;
        if (vStream) {
          const audioTracks = vStream.getAudioTracks();
          if (audioTracks.length > 0) outStream.addTrack(audioTracks[0]);
        }
      } catch { /* audio capture not supported or CORS issue — proceed without audio */ }
      const mimeTypes = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      const recMimeType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
      const recorder = new MediaRecorder(outStream, { mimeType: recMimeType });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      const handleVideoEnded = () => {
        if (recorder.state !== 'inactive') recorder.stop();
      };
      recorder.onstop = () => {
        video.removeEventListener('ended', handleVideoEnded);
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const nextUrl = URL.createObjectURL(blob);
        setDownloadUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return nextUrl;
        });
        setIsRecording(false);
        if (autoMutedRef.current) {
          video.muted = false;
          autoMutedRef.current = false;
        }
      };
      video.addEventListener('ended', handleVideoEnded);
      recorder.start(100);
      setIsRecording(true);
      if (auto) {
        video.pause();
        video.currentTime = 0;
        if (!video.muted) {
          video.muted = true;
          autoMutedRef.current = true;
        }
        await video.play();
      }
      return true;
    } catch (e) {
      setCorsError(true);
      setIsRecording(false);
      if (autoMutedRef.current && videoRef.current) {
        videoRef.current.muted = false;
        autoMutedRef.current = false;
      }
      return false;
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || isAudio || !vttUrl || isCollapsed || showThumb || autoRecordStartedRef.current || isRecording || downloadUrl) return;

    const startAutoRecording = () => {
      if (autoRecordStartedRef.current) return;
      autoRecordStartedRef.current = true;
      void handleStartRecording({ auto: true });
    };

    if (video.readyState >= 1) {
      startAutoRecording();
      return undefined;
    }
    video.addEventListener('loadedmetadata', startAutoRecording, { once: true });
    return () => video.removeEventListener('loadedmetadata', startAutoRecording);
  }, [vttUrl, isAudio, isCollapsed, showThumb, isRecording, downloadUrl, handleStartRecording]);

  const fallbackAnchorDownload = (url, filename) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const shareVideoFile = async (url, filename, fileType) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch media: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    const file = new File([blob], filename, { type: fileType });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Download Video' });
    } else {
      fallbackAnchorDownload(url, filename);
    }
  };

  const handleDownload = async () => {
    if (!isAudio && vttUrl) {
      if (!downloadUrl) return;
      const filename = 'burned_subs.webm';
      try {
        await shareVideoFile(downloadUrl, filename, 'video/webm');
      } catch {
        fallbackAnchorDownload(downloadUrl, filename);
      }
      return;
    }
    const extMap = {
      'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
      'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv', 'video/ogg': '.ogv',
      'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/aac': '.aac',
      'audio/ogg': '.ogg', 'audio/flac': '.flac', 'audio/mp4': '.m4a'
    };
    const ext = (mimeType && extMap[mimeType]) || (isAudio ? '.mp3' : '.mp4');
    const filename = (isAudio ? 'processed-audio' : 'processed-video') + ext;
    try {
      await shareVideoFile(videoUrl, filename, mimeType || (isAudio ? 'audio/mpeg' : 'video/mp4'));
    } catch {
      fallbackAnchorDownload(videoUrl, filename);
    }
  };

  const handlePlayPause = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const getFrameTime = () => 1 / fps;

  const handleFrameForward = () => {
    if (videoRef.current && duration > 0) {
      const frameTime = getFrameTime();
      const newTime = Math.min(currentTime + frameTime, duration);
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleFrameBackward = () => {
    if (videoRef.current) {
      const frameTime = getFrameTime();
      const newTime = Math.max(currentTime - frameTime, 0);
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleSliderChange = (e) => {
    const newTime = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const getCurrentFrame = () => {
    return Math.floor(currentTime * fps);
  };

  const getTotalFrames = () => {
    return Math.floor(duration * fps);
  };

  const formatTime = (time) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    const frames = Math.floor((time % 1) * fps);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${frames.toString().padStart(2, '0')}`;
  };

  const formatShort = (time) => {
    if (!isFinite(time) || time < 0) time = 0;
    const m = Math.floor(time / 60);
    const s = Math.floor(time % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Mini-bar play / thumbnail tap: expand first, then start playback once the video element mounts.
  useEffect(() => {
    if (!isCollapsed && !showThumb && playAfterExpandRef.current && videoRef.current && !isAudio) {
      playAfterExpandRef.current = false;
      try {
        const p = videoRef.current.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) { /* ignore */ }
      setIsPlaying(true);
    }
  }, [isCollapsed, showThumb, isAudio]);

  const togglePlayFromSurface = () => handlePlayPause();

  // First frame as the card's cover image. iOS Safari shows a black box for a paused video, so
  // decode a frame in a detached muted video and draw it to a canvas (data-URL JPEG poster).
  useEffect(() => {
    setPoster(null);
    if (!videoUrl || looksLikeAudio || typeof document === 'undefined') return undefined;
    let done = false;
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    const finish = (url) => { if (!done && url) { done = true; setPoster(url); } };
    const grab = () => {
      try {
        if (!v.videoWidth) return;
        const w = Math.min(480, v.videoWidth); const h = Math.round(w * v.videoHeight / v.videoWidth);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.drawImage(v, 0, 0, w, h);
        const px = g.getImageData(0, 0, w, h).data; let sum = 0;
        for (let i = 0; i < px.length; i += 4 * 97) sum += px[i] + px[i + 1] + px[i + 2];
        if (sum === 0) return; // a black canvas means the frame was not decoded yet
        finish(c.toDataURL('image/jpeg', 0.8));
      } catch (_) { /* tainted or not ready */ }
    };
    v.addEventListener('loadeddata', () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch (_) { grab(); } });
    v.addEventListener('seeked', grab);
    v.src = videoUrl;
    try { v.load(); } catch (_) { /* ignore */ }
    // iOS may not decode a frame for a paused detached video: briefly play it muted (allowed
    // inline without a gesture), grab a frame, then stop.
    v.addEventListener('playing', () => { grab(); setTimeout(() => { grab(); try { v.pause(); } catch (_) { /* ignore */ } }, 150); });
    const fallback = setTimeout(() => { if (!done) { const p = v.play?.(); if (p && p.catch) p.catch(() => {}); } }, 800);
    return () => { done = true; clearTimeout(fallback); v.removeAttribute('src'); try { v.load(); } catch (_) { /* ignore */ } };
  }, [videoUrl, mimeType, looksLikeAudio]);

  // Shared control styles (compact chrome)
  const overlayBtn = {
    width: '30px', height: '30px', borderRadius: '50%',
    border: '1px solid rgba(255,255,255,.28)', backgroundColor: 'rgba(10,12,16,.55)',
    color: '#fff', fontSize: '14px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    WebkitTapHighlightColor: 'transparent', flex: 'none'
  };
  const centerPlayBtn = {
    position: 'absolute', inset: 0, margin: 'auto', width: '64px', height: '64px',
    borderRadius: '50%', backgroundColor: 'rgba(255,255,255,.94)', border: 'none',
    color: '#0b0e13', fontSize: '24px', cursor: 'pointer', zIndex: 2,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 4px 18px rgba(0,0,0,.5)', WebkitTapHighlightColor: 'transparent'
  };
  const scrimTime = {
    fontSize: '10px', color: '#fff', textShadow: '0 1px 3px #000',
    fontVariantNumeric: 'tabular-nums', flex: 'none'
  };
  const chipBtn = {
    fontSize: '12px', color: '#e8edf4', backgroundColor: '#10141b',
    border: '1px solid #232c3a', borderRadius: '999px', padding: '7px 11px',
    cursor: 'pointer', fontVariantNumeric: 'tabular-nums', flex: 'none',
    WebkitTapHighlightColor: 'transparent'
  };
  const tbtnBase = {
    minWidth: '40px', height: '36px', padding: '0 8px', borderRadius: '9px',
    border: '1px solid #232c3a', backgroundColor: '#1a2230', color: '#e8edf4',
    fontSize: '15px', cursor: 'pointer', display: 'flex', alignItems: 'center',
    justifyContent: 'center', flex: 'none', WebkitTapHighlightColor: 'transparent'
  };
  const tbtn = (disabled) => disabled
    ? { ...tbtnBase, opacity: 0.4, cursor: 'not-allowed' }
    : tbtnBase;

  const dlPending = !isAudio && !!vttUrl && !downloadUrl;
  const downloadLabel = (!isAudio && vttUrl)
    ? (downloadUrl ? 'Download Burned WebM' : (isRecording ? 'Rendering Burned WebM...' : 'Preparing Burned WebM...'))
    : 'Download';


  // ---- Thumbnail (default): a small thumb; tap to open the full player ----
  if (showThumb && !looksLikeAudio) {
    return (
      <button
        type="button"
        className="vp"
        onClick={() => { playAfterExpandRef.current = true; setShowThumb(false); }}
        aria-label={`Open video: ${title}`}
        title="Open video"
        style={{
          position: 'relative', display: 'block', width: '100%', maxWidth: '200px',
          padding: 0, border: 'none', borderRadius: '10px', overflow: 'hidden',
          backgroundColor: '#000', cursor: 'pointer', WebkitTapHighlightColor: 'transparent'
        }}
      >
        <video
          // iOS Safari never paints a frame for preload="metadata" (black box with only the
          // duration). A media fragment makes it decode and show the frame at 0.1 s.
          src={videoUrl && !videoUrl.includes('#') ? `${videoUrl}#t=0.1` : videoUrl}
          preload="metadata"
          poster={poster || undefined}
          muted
          playsInline
          onLoadedMetadata={(e) => { if (!duration) setDuration(e.currentTarget.duration || 0); }}
          style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', display: 'block', backgroundColor: '#000' }}
        />
        {poster && (
          <img src={poster} alt="" aria-hidden="true" data-testid="video-poster" style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none'
          }} />
        )}
        <span style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center', pointerEvents: 'none'
        }}>
          <span style={{
            width: '44px', height: '44px', borderRadius: '50%',
            backgroundColor: 'rgba(10,14,20,.62)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '17px', paddingLeft: '3px'
          }}>▶</span>
        </span>
        {duration > 0 && (
          <span style={{
            position: 'absolute', right: '6px', bottom: '6px', pointerEvents: 'none',
            fontSize: '10px', fontWeight: '600', color: '#fff',
            backgroundColor: 'rgba(10,14,20,.72)', borderRadius: '5px', padding: '2px 6px',
            fontVariantNumeric: 'tabular-nums'
          }}>
            {formatShort(duration)}
          </span>
        )}
      </button>
    );
  }

  // ---- Collapsed: 64px mini bar ----
  if (isCollapsed) {
    return (
      <div className="vp" style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        backgroundColor: '#151b25',
        borderRadius: '10px',
        padding: '7px 10px',
        minHeight: '64px',
        boxSizing: 'border-box',
        overflow: 'hidden',
        maxWidth: '100%'
      }}>
        <div style={{
          width: '88px', height: '50px', borderRadius: '6px', flex: 'none',
          backgroundColor: '#000', display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: '18px', color: '#9aa7bb'
        }}>{isAudio ? '♪' : '▶'}</div>
        <div style={{ minWidth: 0, marginRight: 'auto' }}>
          <div style={{
            fontSize: '12px', fontWeight: '600', color: '#e8edf4',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>{title}</div>
          {duration > 0 && (
            <div style={{ fontSize: '10px', color: '#9aa7bb', marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>
              {formatShort(currentTime)} / {formatShort(duration)}
            </div>
          )}
        </div>
        <button aria-label="Play" title="Play" onClick={() => { playAfterExpandRef.current = true; setIsCollapsed(false); }} style={tbtn(false)}>
          ▶
        </button>
        <button aria-label="Expand preview" title="Expand" onClick={() => setIsCollapsed(false)} style={tbtn(false)}>
          ⌃
        </button>
        <div style={{
          position: 'absolute', left: 0, bottom: 0, height: '3px',
          backgroundColor: '#7c6cf6',
          width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`
        }} />
      </div>
    );
  }

  return (
    <div className="vp" style={{
      backgroundColor: '#0b0e13',
      borderRadius: '8px',
      overflow: 'hidden',
      maxWidth: '100%',
      boxSizing: 'border-box'
    }}>
      {isAudio ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px' }}>
            <span style={{ fontSize: '13px', fontWeight: '700', color: '#e8edf4' }}>{title}</span>
            <button aria-label="Collapse preview" title="Collapse" onClick={() => setIsCollapsed(true)} style={chipBtn}>
              ⌄
            </button>
          </div>
          <audio
            ref={videoRef}
            src={videoUrl}
            style={{ width: '100%', display: 'block' }}
            controls
          />
        </>
      ) : (
        <>
          <div style={{ position: 'relative', backgroundColor: '#000' }} onClick={togglePlayFromSurface}>
            {/* Hidden video element — decode/source only; canvas is the visible player */}
            <video
              ref={videoRef}
              src={videoUrl}
              poster={poster || undefined}
              playsInline
              crossOrigin="anonymous"
              // Not display:none: WebKit (iOS Safari) does not decode frames for a display:none
              // video, so drawImage() painted a black canvas. Keep it rendered but invisible.
              style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none', left: 0, top: 0 }}
            >
              {/* track.mode is set to "hidden" in JS so native captions never show;
                  we read activeCues and burn them into the canvas ourselves. */}
              {vttUrl && (
                <track
                  kind="subtitles"
                  src={vttUrl}
                  srcLang={subtitleLang}
                  label={subtitleLabel}
                  default
                />
              )}
            </video>

            {/* Canvas — the visible "player" with subtitles always burned in */}
            <canvas
              ref={canvasRef}
              style={{
                width: '100%',
                height: 'auto',
                display: 'block',
                backgroundColor: '#000'
              }}
            />

            {/* Live captions (not burned in): the active line, timed from the track, styled with its style */}
            {captionTrack && (() => {
              const line = activeLine(captionTrack, currentTime);
              if (!line) return null;
              const fontPx = overlayFontPx(captionTrack, viewH || 360);
              return (
                <div className="cap-overlay" data-testid="caption-overlay" aria-live="off" style={{ ...overlayPlacement(captionTrack.style), fontSize: `${fontPx}px`, fontFamily: overlayFontFamily(captionTrack.style) }}>
                  {line.text && <div className="cap-line">{line.text}</div>}
                  {line.translation && <div className="cap-line cap-tr">{line.translation}</div>}
                </div>
              );
            })()}

            {/* Top overlay: collapse + title */}
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0,
              display: 'flex', alignItems: 'center', padding: '8px 10px',
              pointerEvents: 'none'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', pointerEvents: 'auto' }}>
                <button
                  aria-label="Collapse preview"
                  title="Collapse"
                  onClick={(e) => { e.stopPropagation(); setIsCollapsed(true); }}
                  style={overlayBtn}
                >
                  ⌄
                </button>
                <span style={{
                  fontSize: '11px', color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,.85)',
                  maxWidth: '170px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}>{title}</span>
              </div>
            </div>

            {/* Center play button (when paused) */}
            {!isPlaying && (
              <button
                aria-label="Play"
                title="Play"
                onClick={(e) => { e.stopPropagation(); handlePlayPause(); }}
                style={centerPlayBtn}
              >
                ▶
              </button>
            )}

            {/* Bottom scrim: time + scrubber + total */}
            <div style={{
              position: 'absolute', left: 0, right: 0, bottom: 0,
              padding: '26px 10px 6px',
              background: 'linear-gradient(transparent, rgba(0,0,0,.72))'
            }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={scrimTime}>{formatShort(currentTime)}</span>
                <input
                  type="range"
                  min="0"
                  max={duration || 0}
                  step={getFrameTime()}
                  value={currentTime}
                  onChange={handleSliderChange}
                  aria-label="Seek"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: '22px',
                    margin: 0,
                    cursor: 'pointer',
                    accentColor: '#7c6cf6'
                  }}
                />
                <span style={scrimTime}>{formatShort(duration)}</span>
              </div>
            </div>
          </div>

          {/* Slim control strip: time/frame · fps chip · frame step · download */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 8px',
            backgroundColor: '#151b25'
          }}>
            <span style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '12px',
              color: '#9aa7bb',
              marginRight: 'auto',
              paddingLeft: '4px',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap'
            }}>
              {formatTime(currentTime)} · F {getCurrentFrame()} / {getTotalFrames()}
            </span>
            <button
              aria-label={`Frame rate ${fps} frames per second. Activate to change.`}
              title="Frame rate (tap to cycle)"
              onClick={() => setFpsIdx((fpsIdx + 1) % FPS_STEPS.length)}
              style={chipBtn}
            >
              {fps} fps
            </button>
            <button
              aria-label="Step back one frame"
              title="Previous frame"
              onClick={handleFrameBackward}
              disabled={currentTime <= 0}
              style={tbtn(currentTime <= 0)}
            >
              ⏮
            </button>
            <button
              aria-label="Step forward one frame"
              title="Next frame"
              onClick={handleFrameForward}
              disabled={duration > 0 && currentTime >= duration}
              style={tbtn(duration > 0 && currentTime >= duration)}
            >
              ⏭
            </button>
            <button
              aria-label={downloadLabel}
              title={downloadLabel}
              onClick={handleDownload}
              disabled={dlPending}
              style={tbtn(dlPending)}
            >
              {dlPending ? '⏺' : '⬇'}
            </button>
          </div>

          {corsError && (
            <p style={{ color: '#f85149', fontSize: '11px', margin: 0, padding: '6px 10px', backgroundColor: '#151b25' }}>
              ⚠ CORS error: canvas export/recording may fail for cross-origin videos.
            </p>
          )}
        </>
      )}
    </div>
  );
}
