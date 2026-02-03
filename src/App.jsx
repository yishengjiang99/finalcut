import React, { useState, useRef, useEffect } from 'react';
import { tools, systemPrompt } from './tools.js';
import { toolFunctions } from './toolFunctions.js';
import VideoPreview from './VideoPreview.jsx';

export default function App() {
  const [showLanding, setShowLanding] = useState(true); // Show landing page initially
  const [loaded, setLoaded] = useState(true); // Server-side processing doesn't require loading
  const [processing, setProcessing] = useState(false); // Track ffmpeg processing state
  const [authError, setAuthError] = useState(null); // Track authentication errors
  const [isCallingAPI, setIsCallingAPI] = useState(false); // Track API call state
  const videoRef = useRef(null);
  const messageRef = useRef(null);
  const [messages, setMessages] = useState([{ role: 'system', content: systemPrompt, id: 0 }]);
  const [chatInput, setChatInput] = useState('');
  const [videoFileData, setVideoFileData] = useState(null);
  const [uploadedVideos, setUploadedVideos] = useState([]); // Array of {data: Uint8Array, url: string, name: string, mimeType: string}
  const [fileType, setFileType] = useState('video'); // 'video' or 'audio'
  const [fileMimeType, setFileMimeType] = useState(''); // Store MIME type for proper detection
  const messageIdCounterRef = useRef(1); // Counter for unique message IDs
  const chatWindowRef = useRef(null);

  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [messages]);

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
        
        const response = await fetch('/api/auth/status');
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
              'Content-Type': 'application/json'
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

  const addMessage = (text, isUser = false, videoUrl = null, videoType = 'processed', mimeType = null) => {
    const id = messageIdCounterRef.current++;
    setMessages(prev => [...prev, { role: isUser ? 'user' : 'assistant', content: text, videoUrl, videoType, mimeType, id }]);
  };

  const getVideoTitle = (videoType) => {
    return videoType === 'original' ? 'Original Video' : 'Processed Video';
  };

  const callAPI = async (currentMessages) => {
    setIsCallingAPI(true); // Set loading state before API call
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'grok-beta',
          messages: currentMessages,
          tools: tools,
          tool_choice: 'auto'
        })
      });

      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.choices || !data.choices[0]) {
        throw new Error('Invalid response format from API');
      }

      const msg = data.choices[0].message;

      // Add content to UI if it exists
      if (msg.content) {
        addMessage(msg.content, false);
      }

      // Add assistant message to history (with both content and tool_calls if present)
      if (msg.content || msg.tool_calls) {
        const assistantMessage = {
          role: 'assistant',
          content: msg.content || null,
          id: messageIdCounterRef.current++
        };
        
        if (msg.tool_calls) {
          assistantMessage.tool_calls = msg.tool_calls;
        }
        
        currentMessages.push(assistantMessage);
      }

      if (msg.tool_calls) {
        // Server-side processing - show spinner during ffmpeg processing
        setProcessing(true);
        
        try {
          for (const call of msg.tool_calls) {
            const funcName = call.function.name;
            const args = JSON.parse(call.function.arguments);
            const result = await toolFunctions[funcName](args, videoFileData, setVideoFileData, addMessage, uploadedVideos);
            currentMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: funcName,
              content: result,
              id: messageIdCounterRef.current++
            });
          }
          await callAPI(currentMessages);
        } finally {
          setProcessing(false);
        }
      }
    } catch (error) {
      addMessage('Error communicating with xAI API: ' + error.message, false);
    } finally {
      setIsCallingAPI(false); // Clear loading state after API call completes
    }
  };

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
          addMessage(`Error: File "${file.name}" is not a valid audio or video file.`, false);
          hasError = true;
          continue;
        }

        // Read file as array buffer for server-side processing
        const arrayBuffer = await file.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const url = URL.createObjectURL(file);

        // Store the file data
        newVideos.push({
          data: data,
          url: url,
          name: file.name,
          mimeType: file.type,
          isAudio: isAudio
        });

        // For the first file, set it as the main video for backward compatibility
        if (i === 0) {
          setVideoFileData(data);
          setFileType(isAudio ? 'audio' : 'video');
          setFileMimeType(file.type);
        }
      }

      if (newVideos.length === 0) {
        addMessage('Error: No valid files were uploaded.', false);
        return;
      }

      // Update the uploaded videos list
      setUploadedVideos(prev => [...prev, ...newVideos]);

      // Show all uploaded files in the chat
      const uploadedMessages = newVideos.map((video, index) => ({
        role: 'user',
        content: `${index === 0 ? 'Selected' : 'Also selected'} ${video.isAudio ? 'audio' : 'video'}: ${video.name}`,
        videoUrl: video.url,
        videoType: 'original',
        mimeType: video.mimeType,
        id: messageIdCounterRef.current++
      }));

      const summaryMessage = { 
        role: 'user', 
        content: `${newVideos.length} file${newVideos.length > 1 ? 's' : ''} uploaded and ready for editing${newVideos.length > 1 ? ' or transitions' : ''}.`, 
        id: messageIdCounterRef.current++ 
      };

      // Build complete message history for API call
      const messagesForAPI = [...messages, uploadingMessage, ...uploadedMessages, summaryMessage];

      // Update UI state with uploaded messages
      setMessages(prev => [...prev, ...uploadedMessages, summaryMessage]);

      await callAPI(messagesForAPI);
    } catch (error) {
      addMessage('Error uploading files: ' + error.message, false);
    }

    // Clear the input so the same files can be uploaded again if needed
    e.target.value = '';
  };

  const handleSend = async () => {
    const text = chatInput.trim();
    if (!text || !videoFileData) {
      if (!videoFileData) alert('Please upload a video or audio file first.');
      return;
    }
    setChatInput('');
    const newMessage = { role: 'user', content: text, id: messageIdCounterRef.current++ };
    const newMessages = [...messages, newMessage];
    setMessages(newMessages);
    await callAPI(newMessages);
  };

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
      // Fetch the sample video
      const response = await fetch(sampleVideoUrl);
      if (!response.ok) {
        // If sample video doesn't exist, just show a message
        addMessage('Sample video not available. Please upload your own video.', false);
        return;
      }
      
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      setVideoFileData(data);
      const url = URL.createObjectURL(blob);
      
      setFileType('video');
      setFileMimeType('video/mp4');
      
      // Show selected video
      const uploadedMessage = { role: 'user', content: 'Selected sample video:', videoUrl: url, videoType: 'original', mimeType: 'video/mp4', id: messageIdCounterRef.current++ };
      const userMessage = { role: 'user', content: 'Sample video loaded and ready for editing.', id: messageIdCounterRef.current++ };
      
      const messagesForAPI = [...messages, uploadedMessage, userMessage];
      setMessages(prev => [...prev, uploadedMessage, userMessage]);
      
      await callAPI(messagesForAPI);
    } catch (error) {
      addMessage('Error loading sample video. Please upload your own video.', false);
    }
  };

  // Landing page component
  if (showLanding) {
    const primaryButtonStyle = {
      padding: '15px 40px',
      fontSize: '18px',
      fontWeight: 'bold',
      backgroundColor: '#1f6feb',
      color: '#ffffff',
      border: 'none',
      borderRadius: '8px',
      cursor: 'pointer',
      width: '300px',
      transition: 'background-color 0.2s'
    };

    const secondaryButtonStyle = {
      padding: '12px 40px',
      fontSize: '16px',
      backgroundColor: '#21262d',
      color: '#c9d1d9',
      border: '1px solid #30363d',
      borderRadius: '8px',
      cursor: 'pointer',
      width: '300px',
      transition: 'background-color 0.2s'
    };

    return (
      <div style={{ fontFamily: 'Arial, sans-serif', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', minHeight: '100vh', backgroundColor: '#0d1117' }}>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
          <div style={{ maxWidth: '800px', width: '100%', color: '#c9d1d9', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <h1 style={{ fontSize: '36px', fontWeight: 'bold', marginBottom: '10px', color: '#ffffff', textAlign: 'center' }}>
              FinalCut Video Editor
            </h1>
            <p style={{ fontSize: '16px', marginBottom: '20px', textAlign: 'center', color: '#8b949e' }}>
              AI-powered video and audio editing at your fingertips
            </p>
            
            {authError && (
              <div style={{ 
                padding: '15px', 
                marginBottom: '20px', 
                backgroundColor: '#3c1e1e', 
                border: '1px solid #f85149', 
                borderRadius: '6px',
                color: '#f85149',
                textAlign: 'center'
              }}>
                {authError}
              </div>
            )}

            <div style={{ marginBottom: '15px' }}>
              <h2 style={{ fontSize: '20px', marginBottom: '10px', color: '#ffffff' }}>Available Tools</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px' }}>
                <div style={{ padding: '10px', backgroundColor: '#161b22', borderRadius: '6px', border: '1px solid #30363d' }}>
                  <h3 style={{ fontSize: '14px', marginBottom: '4px', color: '#58a6ff' }}>✂️ Video Editing</h3>
                  <p style={{ fontSize: '11px', color: '#8b949e', margin: 0 }}>Trim, crop, resize, and rotate</p>
                </div>
                <div style={{ padding: '10px', backgroundColor: '#161b22', borderRadius: '6px', border: '1px solid #30363d' }}>
                  <h3 style={{ fontSize: '14px', marginBottom: '4px', color: '#58a6ff' }}>🎨 Visual Effects</h3>
                  <p style={{ fontSize: '11px', color: '#8b949e', margin: 0 }}>Brightness, hue, saturation, text</p>
                </div>
                <div style={{ padding: '10px', backgroundColor: '#161b22', borderRadius: '6px', border: '1px solid #30363d' }}>
                  <h3 style={{ fontSize: '14px', marginBottom: '4px', color: '#58a6ff' }}>🎵 Audio Tools</h3>
                  <p style={{ fontSize: '11px', color: '#8b949e', margin: 0 }}>Volume, fade, equalizer, filters</p>
                </div>
                <div style={{ padding: '10px', backgroundColor: '#161b22', borderRadius: '6px', border: '1px solid #30363d' }}>
                  <h3 style={{ fontSize: '14px', marginBottom: '4px', color: '#58a6ff' }}>⚡ Speed Control</h3>
                  <p style={{ fontSize: '11px', color: '#8b949e', margin: 0 }}>Speed up or slow down media</p>
                </div>
                <div style={{ padding: '10px', backgroundColor: '#161b22', borderRadius: '6px', border: '1px solid #30363d' }}>
                  <h3 style={{ fontSize: '14px', marginBottom: '4px', color: '#58a6ff' }}>📱 Social Media</h3>
                  <p style={{ fontSize: '11px', color: '#8b949e', margin: 0 }}>Instagram, TikTok, YouTube presets</p>
                </div>
                <div style={{ padding: '10px', backgroundColor: '#161b22', borderRadius: '6px', border: '1px solid #30363d' }}>
                  <h3 style={{ fontSize: '14px', marginBottom: '4px', color: '#58a6ff' }}>🔄 Format Conversion</h3>
                  <p style={{ fontSize: '11px', color: '#8b949e', margin: 0 }}>Convert MP4, WebM, MOV formats</p>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center', marginTop: '15px' }}>
              <button 
                onClick={handleGetStarted}
                style={primaryButtonStyle}
              >
                Get Started
              </button>
              <button 
                onClick={loadSampleVideo}
                style={secondaryButtonStyle}
              >
                Try with Sample Video
              </button>
            </div>
          </div>
        </div>
        <footer style={{ 
          padding: '20px', 
          textAlign: 'center', 
          borderTop: '1px solid #30363d', 
          backgroundColor: '#161b22',
          color: '#8b949e',
          fontSize: '14px'
        }}>
          <p style={{ margin: '0 0 8px 0' }}>© 2026 FinalCut Video Editor. All rights reserved.</p>
          <p style={{ margin: 0, fontSize: '12px' }}>AI-powered video editing made simple</p>
        </footer>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', margin: 0, padding: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: '#0d1117' }}>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
      <main style={{ width: '100%', maxWidth: '100vw', minHeight: '100vh', backgroundColor: '#0d1117', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/* Processing Spinner Overlay */}
        {processing && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(13, 17, 23, 0.8)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000
          }}>
            <div style={{
              width: '50px',
              height: '50px',
              border: '4px solid #30363d',
              borderTop: '4px solid #1f6feb',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }}></div>
            <p style={{ color: '#c9d1d9', marginTop: '20px', fontSize: '16px' }}>Processing video with ffmpeg...</p>
          </div>
        )}
        <div ref={chatWindowRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '16px', paddingTop: '50px', WebkitOverflowScrolling: 'touch' }}>
          {messages.slice(1).map((msg) => (
            <div key={msg.id} style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '8px', maxWidth: '80%', alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', marginLeft: msg.role === 'user' ? 'auto' : 0, marginRight: msg.role === 'user' ? 0 : 'auto', backgroundColor: msg.role === 'user' ? '#d0d0d0' : '#21262d', color: msg.role === 'user' ? '#000000' : '#c9d1d9', wordWrap: 'break-word' }}>
              <p style={{ margin: 0 }}>{msg.content}</p>
              {msg.videoUrl && (
                <div style={{ marginTop: '8px' }}>
                  {msg.videoUrl}
                  <VideoPreview
                    key={`preview-${msg.id}`}
                    videoUrl={msg.videoUrl}
                    title={getVideoTitle(msg.videoType)}
                    mimeType={msg.mimeType}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', padding: '12px', gap: '8px', borderTop: '1px solid #30363d', backgroundColor: '#161b22' }}>
          <input type="file" onChange={handleUpload} accept="video/*,audio/*,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp3,audio/ogg,audio/aac" capture="environment" multiple style={{ width: '100%', padding: '8px', fontSize: '16px', backgroundColor: '#0d1117', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: '4px' }} />
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input 
              type="text" 
              value={chatInput} 
              onChange={(e) => setChatInput(e.target.value)} 
              onKeyPress={(e) => e.key === 'Enter' && handleSend()} 
              placeholder="Describe the video edit..." 
              disabled={isCallingAPI}
              style={{ 
                width: '100%', 
                padding: '16px', 
                paddingRight: isCallingAPI ? '50px' : '16px',
                border: '2px solid #1f6feb', 
                borderRadius: '8px', 
                fontSize: '18px', 
                fontWeight: '500',
                backgroundColor: '#0d1117', 
                color: '#c9d1d9',
                outline: 'none',
                transition: 'border-color 0.2s, box-shadow 0.2s',
                boxShadow: '0 0 0 3px rgba(31, 111, 235, 0.1)'
              }} 
            />
            {isCallingAPI && (
              <div style={{
                position: 'absolute',
                right: '16px',
                width: '24px',
                height: '24px',
                border: '3px solid #30363d',
                borderTop: '3px solid #1f6feb',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite'
              }}></div>
            )}
          </div>
          <button onClick={handleSend} disabled={!videoFileData || isCallingAPI} style={{ padding: '12px 16px', backgroundColor: (videoFileData && !isCallingAPI) ? '#1f6feb' : '#21262d', color: (videoFileData && !isCallingAPI) ? '#ffffff' : '#6e7681', border: 'none', borderRadius: '4px', cursor: (videoFileData && !isCallingAPI) ? 'pointer' : 'not-allowed', fontSize: '16px', fontWeight: '500', WebkitTapHighlightColor: 'transparent' }}>
            {isCallingAPI ? 'Sending...' : 'Send'}
          </button>
        </div>
        <footer style={{ 
          padding: '12px', 
          textAlign: 'center', 
          borderTop: '1px solid #30363d', 
          backgroundColor: '#161b22',
          color: '#8b949e',
          fontSize: '12px'
        }}>
          <p style={{ margin: 0 }}>© 2026 FinalCut Video Editor. All rights reserved.</p>
        </footer>
      </main>
    </div>
  );
}
