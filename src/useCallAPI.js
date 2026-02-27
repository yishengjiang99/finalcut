import { useCallback, useRef } from 'react';
import { tools } from './tools.js';
import { toolFunctions } from './toolFunctions.js';

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
}) {
  const callAPIRef = useRef(null);

  const callAPI = useCallback(async (currentMessages, options = {}) => {
    const forcedSampleToken = options.sampleAccessToken || null;
    const shouldUseSampleAuth = Boolean(forcedSampleToken || (isSampleMode && sampleAccessToken));
    const authHeaders = shouldUseSampleAuth
      ? { 'sample-access-token': forcedSampleToken || sampleAccessToken }
      : {};

    setIsCallingAPI(true); // Set loading state before API call
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
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

        try {
          for (const call of toolCallsArray) {
            const funcName = call.function.name;
            const args = JSON.parse(call.function.arguments);

            // Pass uploadedVideos only to functions that need it
            let result;
            if (funcName === 'add_video_transition') {
              result = await toolFunctions[funcName](args, videoFileData, setVideoFileData, addMessage, uploadedVideos);
            } else {
              result = await toolFunctions[funcName](args, videoFileData, setVideoFileData, addMessage);
            }

            currentMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: funcName,
              content: result,
              id: messageIdCounterRef.current++
            });
          }
          await callAPIRef.current(currentMessages);
        } finally {
          setProcessing(false);
        }
      }
    } catch (error) {
      addMessage('Error communicating with xAI API: ' + error.message, false);
    } finally {
      setIsCallingAPI(false); // Clear loading state after API call completes
    }
  }, [isSampleMode, sampleAccessToken, setIsCallingAPI, setProcessing, setMessages, messageIdCounterRef, videoFileData, setVideoFileData, addMessage, uploadedVideos]);

  callAPIRef.current = callAPI;

  return callAPI;
}

