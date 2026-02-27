import React, { useState, useRef, useEffect, useCallback } from 'react';

export default function VideoPreview({ videoUrl, title = 'Video Preview', defaultCollapsed = false, mimeType = null, vttUrl = null, subtitleLang = 'en', subtitleLabel = 'English' }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fps, setFps] = useState(30);
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
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
      const fontSize = Math.max(16, Math.floor(canvas.height * 0.045));
      ctx.font = `bold ${fontSize}px Arial, sans-serif`;
      ctx.textAlign = 'center';
      for (let i = 0; i < track.activeCues.length; i++) {
        const cue = track.activeCues[i];
        const rawLines = (() => {
          try {
            const div = document.createElement('div');
            div.innerHTML = cue.text || '';
            return (div.textContent || '').split('\n');
          } catch (_) { return (cue.text || '').split('\n'); }
        })();
        const lines = rawLines;
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
    if (!video || isAudio || !vttUrl || isCollapsed || autoRecordStartedRef.current || isRecording || downloadUrl) return;

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
  }, [vttUrl, isAudio, isCollapsed, isRecording, downloadUrl, handleStartRecording]);

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const handleDownload = () => {
    if (!isAudio && vttUrl) {
      if (!downloadUrl) return;
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = 'burned_subs.webm';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }
    const extMap = {
      'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
      'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv', 'video/ogg': '.ogv',
      'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/aac': '.aac',
      'audio/ogg': '.ogg', 'audio/flac': '.flac', 'audio/mp4': '.m4a'
    };
    const ext = (mimeType && extMap[mimeType]) || (isAudio ? '.mp3' : '.mp4');
    const a = document.createElement('a');
    a.href = videoUrl;
    a.download = (isAudio ? 'processed-audio' : 'processed-video') + ext;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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

  return (
    <div style={{ 
      backgroundColor: '#21262d', 
      padding: '12px', 
      borderRadius: '8px',
      boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
      maxWidth: '100%',
      boxSizing: 'border-box'
    }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: isCollapsed ? '0' : '8px'
      }}>
        <p style={{ margin: '0', fontSize: '14px', fontWeight: 'bold', color: '#c9d1d9' }}>{title}</p>
        <button 
          onClick={() => setIsCollapsed(!isCollapsed)}
          style={{
            padding: '4px 12px',
            fontSize: '12px',
            backgroundColor: '#2a2f3a',
            color: '#d8dee9',
            border: '1px solid #3a4250',
            borderRadius: '4px',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent'
          }}
        >
          {isCollapsed ? '▼ Expand' : '▲ Collapse'}
        </button>
      </div>
      
      {!isCollapsed && (
        <>
      {isAudio ? (
        <audio 
          ref={videoRef}
          src={videoUrl} 
          style={{ 
            width: '100%', 
            maxWidth: '400px', 
            marginBottom: '12px'
          }} 
          controls
        />
      ) : (
        <>
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
              maxWidth: '400px',
              borderRadius: '4px',
              display: 'block',
              marginBottom: '12px',
              backgroundColor: '#000'
            }}
          />

          {corsError && (
            <p style={{ color: '#f85149', fontSize: '12px', marginBottom: '8px' }}>
              ⚠ CORS error: canvas export/recording may fail for cross-origin videos.
            </p>
          )}
        </>
      )}
      
      {/* Meter/Slider control */}
      <div style={{ marginBottom: '12px' }}>
        <input 
          type="range"
          min="0"
          max={duration || 0}
          step={getFrameTime()}
          value={currentTime}
          onChange={handleSliderChange}
          style={{
            width: '100%',
            cursor: 'pointer',
            accentColor: '#8b949e'
          }}
        />
      </div>
      
      {/* Time and Frame info */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        fontSize: '12px', 
        marginBottom: '12px',
        color: '#8b949e'
      }}>
        <span>Time: {formatTime(currentTime)}</span>
        {!isAudio && <span>Frame: {getCurrentFrame()} / {getTotalFrames()}</span>}
      </div>
      
      {/* FPS selector - only for video */}
      {!isAudio && (
        <div style={{ marginBottom: '12px', fontSize: '12px', color: '#c9d1d9' }}>
          <label style={{ marginRight: '8px' }}>FPS:</label>
          <select 
            value={fps} 
            onChange={(e) => setFps(Number(e.target.value))}
            style={{
              padding: '4px 8px',
              borderRadius: '4px',
              border: '1px solid #30363d',
              fontSize: '12px',
              backgroundColor: '#0d1117',
              color: '#c9d1d9'
            }}
          >
            <option value={24}>24</option>
            <option value={25}>25</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </div>
      )}
      
      {/* Control buttons */}
      <div style={{ 
        display: 'flex', 
        gap: '8px', 
        flexWrap: 'wrap',
        justifyContent: 'center'
      }}>
        {!isAudio && (
          <button 
            onClick={handleFrameBackward}
            disabled={currentTime <= 0}
            style={{
              padding: '8px 12px',
              fontSize: '14px',
              backgroundColor: currentTime <= 0 ? '#21262d' : '#2f3644',
              color: currentTime <= 0 ? '#6e7681' : '#e6edf3',
              border: '1px solid #424a59',
              borderRadius: '4px',
              cursor: currentTime <= 0 ? 'not-allowed' : 'pointer',
              WebkitTapHighlightColor: 'transparent'
            }}
          >
            ◀ Frame
          </button>
        )}
        
        <button 
          onClick={handlePlayPause}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            backgroundColor: '#2a2f3a',
            color: '#e6edf3',
            border: '1px solid #3a4250',
            borderRadius: '4px',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent'
          }}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        
        <button
          onClick={handleDownload}
          disabled={!isAudio && !!vttUrl && !downloadUrl}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            backgroundColor: (!isAudio && !!vttUrl && !downloadUrl) ? '#21262d' : '#2a2f3a',
            color: (!isAudio && !!vttUrl && !downloadUrl) ? '#6e7681' : '#e6edf3',
            border: '1px solid #3a4250',
            borderRadius: '4px',
            cursor: (!isAudio && !!vttUrl && !downloadUrl) ? 'not-allowed' : 'pointer',
            WebkitTapHighlightColor: 'transparent'
          }}
        >
          {!isAudio && !!vttUrl ? (downloadUrl ? '⬇ Download Burned WebM' : (isRecording ? '⏺ Rendering Burned WebM...' : '⏺ Preparing Burned WebM...')) : '⬇ Download'}
        </button>

        {!isAudio && !vttUrl && !isRecording && (
          <button
            onClick={handleStartRecording}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              backgroundColor: '#2a2f3a',
              color: '#e6edf3',
              border: '1px solid #3a4250',
              borderRadius: '4px',
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent'
            }}
          >
            ⏺ Start Recording
          </button>
        )}

        {!isAudio && !vttUrl && isRecording && (
          <button
            onClick={handleStopRecording}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              backgroundColor: '#6e1a1a',
              color: '#e6edf3',
              border: '1px solid #a03030',
              borderRadius: '4px',
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent'
            }}
          >
            ⏹ Stop Recording
          </button>
        )}
        
        {!isAudio && (
          <button 
            onClick={handleFrameForward}
            disabled={currentTime >= duration}
            style={{
              padding: '8px 12px',
              fontSize: '14px',
              backgroundColor: currentTime >= duration ? '#21262d' : '#2f3644',
              color: currentTime >= duration ? '#6e7681' : '#e6edf3',
              border: '1px solid #424a59',
              borderRadius: '4px',
              cursor: currentTime >= duration ? 'not-allowed' : 'pointer',
              WebkitTapHighlightColor: 'transparent'
            }}
          >
            Frame ▶
          </button>
        )}
      </div>
        </>
      )}
    </div>
  );
}
