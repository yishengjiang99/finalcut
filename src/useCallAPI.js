import { useCallback } from 'react';
import { tools } from './tools.js';
import { noteDerivedVideo } from './captionLineage.js';
import { toolFunctions, getCurrentFileMimeType, ffmpegCliStringFallback } from './toolFunctions.js';
import { FFMPEG_CLI_TOOL_NAME } from './ffmpegFallback.js';
import { getEngineMode, ENGINE_CLIENT } from './engineMode.js';
import { runClientTurn } from './clientTurn.js';

export function assertToolCallApplied(result, functionName) {
  if (typeof result !== 'string' || !result.trim() || /^Failed\b/i.test(result.trim())) {
    throw new Error(`Tool call "${functionName}" was not applied: ${result || 'no result returned'}`);
  }
  return result;
}

export function filterMessagesForInference(messages) {
  const latestUserMessage = [...messages]
    .reverse()
    .find(message => message?.role === 'user' && !message?.excludeFromAPI && !message?.apiContent);

  return latestUserMessage
    ? [{ role: 'user', content: latestUserMessage.content }]
    : [];
}

// Without media there is nothing for the editing tools to act on, so send a
// plain chat request and tell the model why no tools are offered.
export const NO_MEDIA_NOTE = 'No video, photo, or audio file is attached yet. Chat normally and answer questions. If the user asks for an edit, ask them to upload a file first; never claim an edit was applied.';

// The latest request plus the tool calls and results that followed it, so the
// model can continue a multi-step tool exchange (ffmpeg_cli discover → plan → run).
export function messagesForCurrentTurn(messages) {
  const [latestUserMessage] = filterMessagesForInference(messages);
  if (!latestUserMessage) return [];

  const start = messages.findLastIndex(message =>
    message?.role === 'user' && !message?.excludeFromAPI && !message?.apiContent);
  const followUps = messages.slice(start + 1)
    .filter(message => !message?.excludeFromAPI)
    .flatMap(message => {
      if (message?.role === 'tool') {
        return [{ role: 'tool', tool_call_id: message.tool_call_id, name: message.name, content: message.content }];
      }
      if (message?.role === 'assistant' && message.tool_calls?.length) {
        return [{ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls }];
      }
      return [];
    });
  return [latestUserMessage, ...followUps];
}

// ffmpeg_cli discover/plan and get_video_dimensions only gather information: the model has
// to see the result to take the next step, so those rounds are sent back for a follow-up.
export const MAX_TOOL_FOLLOW_UPS = 6;
const INFO_ONLY_TOOL_NAMES = new Set(['get_video_dimensions']);

export function needsFollowUp(toolCalls) {
  // A lookup made alongside an edit needs no second round; a lookup on its own does
  // (for example reading the frame size before centering text).
  if (toolCalls.length > 0 && toolCalls.every(call => INFO_ONLY_TOOL_NAMES.has(call?.function?.name))) return true;
  return toolCalls.some(call => {
    if (call?.function?.name !== FFMPEG_CLI_TOOL_NAME) return false;
    try {
      return JSON.parse(call.function.arguments || '{}').action !== 'run';
    } catch {
      return false;
    }
  });
}

// A reply without tool calls means no tool matched. For a video or audio file the request
// is then put to inference as "what is the ffmpeg CLI string for …" (photos have no fallback).
export function cliStringFallbackRequest(messages, toolCalls, hasMedia, mimeType) {
  if (toolCalls.length || !hasMedia || (typeof mimeType === 'string' && mimeType.startsWith('image/'))) return null;
  const content = filterMessagesForInference(messages)[0]?.content;
  return typeof content === 'string' && content.trim() ? content.trim() : null;
}

// What the server tells the model about the attached file, so it does not have to guess
// whether it is editing a video, a photo or audio.
export function mediaForInference(mimeType) {
  if (typeof mimeType !== 'string' || !mimeType) return null;
  if (mimeType.startsWith('image/')) return { type: 'image' };
  if (mimeType.startsWith('audio/')) return { type: 'audio' };
  return { type: 'video' };
}

export function buildChatRequestBody(messages, hasMedia, media = null) {
  const inferenceMessages = messagesForCurrentTurn(messages);
  if (!hasMedia) {
    return {
      messages: [{ role: 'system', content: NO_MEDIA_NOTE }, ...inferenceMessages]
    };
  }
  return {
    messages: inferenceMessages,
    tools: tools,
    tool_choice: 'auto',
    ...(media ? { media } : {})
  };
}

// A failed /api/chat response. The 401s raised by our own auth layer are told apart from
// errors the server relays from xAI (those carry source: 'xai').
export class ChatRequestError extends Error {
  constructor(status, body = {}, statusText = '') {
    const detail = (typeof body?.error === 'string' && body.error) || statusText || 'no details';
    const fromXai = body?.source === 'xai';
    const authExpired = status === 401 && !fromXai;
    super(authExpired
      ? 'Your session has expired. Sign in again to continue.'
      : `${fromXai ? 'xAI API error' : 'Request failed'} (${status}): ${detail}`);
    this.name = 'ChatRequestError';
    this.status = status;
    this.authExpired = authExpired;
  }
}

async function chatRequestError(response) {
  let body = {};
  try {
    body = await response.json();
  } catch {
    // Not JSON (a proxy error page, say): the status line is all there is.
  }
  return new ChatRequestError(response.status, body, response.statusText);
}

async function reportChatError(error, { authHeaders, messageCount, context } = {}) {
  try {
    await fetch('/api/chat-error', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeaders || {})
      },
      body: JSON.stringify({
        message: error?.message || String(error),
        name: error?.name || null,
        stack: error?.stack || null,
        messageCount,
        context
      })
    });
  } catch (reportError) {
    console.error('Failed to report chat error:', reportError);
  }
}

export function useCallAPI({
  isSampleMode,
  sampleAccessToken,
  setIsCallingAPI,
  setProcessing,
  setMessages,
  messageIdCounterRef,
  videoFileData,
  setVideoFileData,
  addMessage,
  uploadedVideos,
  refreshSampleAccessToken,
  onAuthExpired,
  onToolStart,
}) {
  const callAPI = useCallback(async function runTurn(currentMessages, options = {}) {
    const followUpRound = options.followUpRound || 0;
    const currentVideoFileData = options.videoFileData ?? videoFileData;
    const forcedSampleToken = options.sampleAccessToken || null;
    const shouldUseSampleAuth = Boolean(forcedSampleToken || (isSampleMode && sampleAccessToken));
    let authHeaders = shouldUseSampleAuth
      ? { 'sample-access-token': forcedSampleToken || sampleAccessToken }
      : {};
    const postChat = () => fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify(buildChatRequestBody(currentMessages, Boolean(currentVideoFileData), mediaForInference(getCurrentFileMimeType()))),
      ...(options.signal ? { signal: options.signal } : {})
    });

    // In-browser editing: the model's tool calls run in ffmpeg.wasm and nothing is uploaded.
    // Without a file there is nothing to edit, so that stays an ordinary streamed chat.
    const postClientChat = async (body) => {
      const send = () => fetch('/api/v2/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {})
      });
      let response = await send();
      let failure = response.ok ? null : await chatRequestError(response);
      if (failure?.authExpired && shouldUseSampleAuth && refreshSampleAccessToken) {
        authHeaders = { 'sample-access-token': await refreshSampleAccessToken() };
        response = await send();
        failure = response.ok ? null : await chatRequestError(response);
      }
      if (failure) throw failure;
      return response.json();
    };

    setIsCallingAPI(true); // Set loading state before API call
    try {
      if (getEngineMode() === ENGINE_CLIENT && currentVideoFileData) {
        return await runClientTurn({
          messages: currentMessages,
          videoFileData: currentVideoFileData,
          post: postClientChat,
          signal: options.signal,
          ui: {
            setProcessing,
            setVideoFileData,
            addMessage,
            uploadedVideos,
            onToolStart,
            onStatus: options.onStatus,
            nextId: () => messageIdCounterRef.current++,
            addAssistantMessage: (content) => {
              const id = messageIdCounterRef.current++;
              setMessages(prev => [...prev, { role: 'assistant', content, id }]);
              return id;
            },
          },
        });
      }

      let response = await postChat();
      let failure = response.ok ? null : await chatRequestError(response);

      // Sample tokens are short-lived and do not survive a server restart: get a new one and retry once.
      if (failure?.authExpired && shouldUseSampleAuth && refreshSampleAccessToken) {
        const freshToken = await refreshSampleAccessToken();
        authHeaders = { 'sample-access-token': freshToken };
        options = { ...options, sampleAccessToken: freshToken };
        response = await postChat();
        failure = response.ok ? null : await chatRequestError(response);
      }

      if (failure) throw failure;

      // Handle streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamedContent = '';
      let streamedToolCalls = {}; // Use object instead of array to handle non-sequential indices
      let currentMessageId = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep the last incomplete line in the buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;

              if (!delta) continue;

              // Handle content streaming
              if (delta.content) {
                streamedContent += delta.content;

                // Update or create the streaming message in UI
                if (currentMessageId === null) {
                  currentMessageId = messageIdCounterRef.current++;
                  setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: streamedContent,
                    id: currentMessageId,
                    streaming: true
                  }]);
                } else {
                  setMessages(prev => prev.map(msg =>
                    msg.id === currentMessageId
                      ? { ...msg, content: streamedContent }
                      : msg
                  ));
                }
              }

              // Handle tool calls streaming
              if (delta.tool_calls) {
                for (const toolCall of delta.tool_calls) {
                  const index = toolCall.index;

                  if (!streamedToolCalls[index]) {
                    streamedToolCalls[index] = {
                      id: toolCall.id || '',
                      type: 'function',
                      function: {
                        name: toolCall.function?.name || '',
                        arguments: toolCall.function?.arguments || ''
                      }
                    };
                  } else {
                    if (toolCall.id) {
                      streamedToolCalls[index].id = toolCall.id;
                    }
                    if (toolCall.function?.name) {
                      streamedToolCalls[index].function.name = toolCall.function.name;
                    }
                    if (toolCall.function?.arguments) {
                      streamedToolCalls[index].function.arguments += toolCall.function.arguments;
                    }
                  }
                }
              }
            } catch (parseError) {
              console.error('Error parsing SSE data:', parseError);
            }
          }
        }
      }

      // Convert tool calls object to array
      const toolCallsArray = Object.values(streamedToolCalls);

      // Mark the streaming message as complete
      if (currentMessageId !== null) {
        setMessages(prev => prev.map(msg =>
          msg.id === currentMessageId
            ? { ...msg, streaming: false }
            : msg
        ));
      }

      // Only prepare final message if we have content or tool calls
      if (streamedContent || toolCallsArray.length > 0) {
        const finalMessage = {
          role: 'assistant',
          content: streamedContent || null,
          id: currentMessageId !== null ? currentMessageId : messageIdCounterRef.current++
        };

        if (toolCallsArray.length > 0) {
          finalMessage.tool_calls = toolCallsArray;
        }

        // Add assistant message to history
        currentMessages.push(finalMessage);
      }

      // Process tool calls if any
      if (toolCallsArray.length > 0) {
        // Server-side processing - show spinner during ffmpeg processing
        setProcessing(true);

        let workingVideoFileData = currentVideoFileData;
        try {
          // React state updates are asynchronous. Keep a local working value so
          // each tool receives the bytes produced by the previous tool in this
          // same response (for example: volume, then brightness).
          const updateWorkingVideoFileData = data => {
            noteDerivedVideo(workingVideoFileData, data);
            workingVideoFileData = data;
            setVideoFileData(data);
          };

          for (const call of toolCallsArray) {
            // A cancelled job must not start its remaining tool calls.
            if (options.signal?.aborted) throw new Error('Job cancelled');
            const funcName = call.function.name;
            const toolFunction = toolFunctions[funcName];
            if (typeof toolFunction !== 'function') {
              throw new Error(`Unsupported tool call from xAI: ${funcName || '(missing tool name)'}`);
            }

            let args;
            try {
              args = JSON.parse(call.function.arguments || '{}');
            } catch (parseError) {
              throw new Error(`Invalid arguments for xAI tool call "${funcName}": ${parseError.message}`);
            }

            onToolStart?.(funcName, args);

            // Pass uploadedVideos only to functions that need it
            let result;
            if (funcName === 'add_video_transition') {
              result = await toolFunction(args, workingVideoFileData, updateWorkingVideoFileData, addMessage, uploadedVideos);
            } else {
              result = await toolFunction(args, workingVideoFileData, updateWorkingVideoFileData, addMessage);
            }

            // Tool functions report processing failures as result strings. Do
            // not let a later tool run against media that was never updated.
            result = assertToolCallApplied(result, funcName);

            currentMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: funcName,
              content: result,
              id: messageIdCounterRef.current++
            });
          }
        } finally {
          // Hide spinner as soon as all tool calls in this response are done.
          setProcessing(false);
        }

        if (needsFollowUp(toolCallsArray)) {
          if (followUpRound >= MAX_TOOL_FOLLOW_UPS) {
            throw new Error('The FFmpeg fallback did not finish within the allowed number of steps');
          }
          return await runTurn(currentMessages, { ...options, followUpRound: followUpRound + 1, videoFileData: workingVideoFileData });
        }
      }

      const fallbackRequest = followUpRound === 0
        ? cliStringFallbackRequest(currentMessages, toolCallsArray, Boolean(currentVideoFileData), getCurrentFileMimeType())
        : null;
      if (fallbackRequest) {
        try {
          const updateVideoFileData = data => {
            noteDerivedVideo(currentVideoFileData, data);
            setVideoFileData(data);
          };
          // The spinner only starts once inference has returned a command to run.
          const result = await ffmpegCliStringFallback(fallbackRequest, currentVideoFileData, updateVideoFileData, addMessage, {
            signal: options.signal,
            onRun: () => setProcessing(true)
          });
          if (result !== null) assertToolCallApplied(result, 'ffmpeg');
        } finally {
          setProcessing(false);
        }
      }
      return 'done';
    } catch (error) {
      // Cancelling aborts the in-flight request; that is not an error to report.
      if (options.signal?.aborted) return 'cancelled';
      if (error instanceof ChatRequestError) {
        // An expired session cannot report itself: /api/chat-error needs the same auth.
        if (error.authExpired) {
          onAuthExpired?.();
          addMessage({ text: error.message });
          return 'error';
        }
      }
      await reportChatError(error, {
        authHeaders,
        messageCount: currentMessages.length,
        context: {
          toolCallNames: currentMessages
            .flatMap(message => message?.tool_calls || [])
            .map(toolCall => toolCall?.function?.name)
            .filter(Boolean)
        }
      });
      addMessage({ text: error instanceof ChatRequestError ? error.message : 'Error communicating with xAI API: ' + error.message });
      return 'error';
    } finally {
      setIsCallingAPI(false); // Clear loading state after API call completes
    }
  }, [isSampleMode, sampleAccessToken, setIsCallingAPI, setProcessing, setMessages, messageIdCounterRef, videoFileData, setVideoFileData, addMessage, uploadedVideos, refreshSampleAccessToken, onAuthExpired, onToolStart]);

  return callAPI;
}
