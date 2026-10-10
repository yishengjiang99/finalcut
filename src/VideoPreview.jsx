import React, { useState, useRef, useEffect, useCallback } from 'react';

const FPS_STEPS = [24, 25, 30, 60];

export default function VideoPreview({ videoUrl, title = 'Video Preview', defaultCollapsed = false, mimeType = null, vttUrl = null, subtitleLang = 'en', subtitleLabel = 'English' }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fpsIdx, setFpsIdx] = useState(2); // index into FPS_STEPS; default 30
  const fps = FPS_STEPS[fpsIdx];
  const playAfterExpandRef = useRef(false);
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [showThumb, setShowThumb] = useState(true); // thumbnail first; tap to open the full player
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
  const rafRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const autoRecordStartedRef = useRef(false);
  const autoMutedRef = useRef(false);

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
      
      // Reset state when video URL changes
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
      
      // Force the video element to load the new source
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
  }, [videoUrl, mimeType, renderFrame]);

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
      // Best-effort audio
      try {
        const vStream = video.captureStream ? video.captureStream() : null;
        if (vStream) {
          const audioTracks = vStream.getAudioTracks();
          if (audioTracks.length > 0) outStream.addTrack(audioTracks[0]);
        }
      } catch (_) { /* audio capture not supported or CORS issue — proceed without audio */
        // eslint-disable-next-line no-console
        console.warn('Audio capture skipped:', _);
      }
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
          src={videoUrl}
          preload="metadata"
          muted
          playsInline
          onLoadedMetadata={(e) => { if (!duration) setDuration(e.currentTarget.duration || 0); }}
          style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', display: 'block', backgroundColor: '#000' }}
        />
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
      <div style={{
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
    <div style={{
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
              playsInline
              crossOrigin="anonymous"
              style={{ display: 'none' }}
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
