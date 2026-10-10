// One chat turn of the in-browser editor. Grok plans on the server (POST /api/v2/chat); every
// tool call comes back here and runs in ffmpeg.wasm; only small results (ok/error, duration,
// frame size) go back for the next round. The media is not part of any request.
import { toolFunctions, getCurrentFileMimeType, resetLastExecution, getLastExecution, setToolStatusListener } from './toolFunctions.js';
import { noteDerivedVideo } from './captionLineage.js';
import { probeMedia, summarizeProbe, subscribeEngine } from './wasm/ffmpegEngine.js';

export const MAX_CLIENT_ROUNDS = 8;
const MAX_RESULT_TEXT = 600;

const toolLabel = name => String(name || 'edit').replace(/_/g, ' ');

/** Status line for tool `index` (0-based) of `total`. `progress` is 0 to 1 when FFmpeg reports it. */
export function toolRunStatus(name, index, total, { progress = null, etaSeconds = null } = {}) {
  const step = total > 1 ? ` (${index + 1} of ${total})` : '';
  const known = Number.isFinite(progress) && progress >= 0 && progress <= 1;
  return {
    text: `Running ${toolLabel(name)}${step}…`,
    ...(known ? { progress } : {}),
    ...(known && Number.isFinite(etaSeconds) ? { etaSeconds } : {}),
  };
}

export function mediaTypeOf(mimeType) {
  if (typeof mimeType !== 'string') return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'video';
}

/** The small description of a file that the model is given: never the file itself. */
export function mediaSummary(metadata, mimeType, sizeBytes) {
  const probe = summarizeProbe(metadata);
  const type = mediaTypeOf(mimeType);
  const summary = { type };
  // A photo is one frame: no duration, frame rate or soundtrack to report.
  if (type !== 'image' && Number.isFinite(probe.duration)) summary.duration = Math.round(probe.duration * 1000) / 1000;
  if (probe.width) summary.width = probe.width;
  if (probe.height) summary.height = probe.height;
  if (type !== 'image' && probe.fps) summary.fps = probe.fps;
  if (type !== 'image') summary.hasAudio = probe.hasAudio;
  if (Number.isFinite(sizeBytes)) summary.sizeBytes = sizeBytes;
  return summary;
}

async function describeMedia(bytes, mimeType) {
  try {
    return mediaSummary(await probeMedia(bytes, mimeType), mimeType, bytes.length);
  } catch (error) {
    if (error?.code === 'cancelled') throw error;
    // The model can still plan from the type alone.
    return { type: mediaTypeOf(mimeType) };
  }
}

// `media` as POST /api/v2/chat accepts it (sizeBytes is for the tool result only).
const mediaForRequest = ({ sizeBytes, ...media }) => media;

/**
 * The tool result the model reads. Tool functions return a sentence; anything starting with
 * "Failed" is a failure.
 */
export function toolResultFor(text, execution, output) {
  const message = String(text || '').trim().slice(0, MAX_RESULT_TEXT);
  const failed = !message || /^Failed\b/i.test(message);
  const executedOn = execution?.executedOn || 'browser';
  if (!failed) return { ok: true, executedOn, message, ...(output ? { output } : {}) };
  if (execution?.errorCode === 'skipped_by_user') return { ok: false, error: 'skipped_by_user', executedOn, message };
  return { ok: false, error: execution?.errorCode || 'failed', executedOn, message: message || 'The tool returned no result.' };
}

/**
 * @param {object} turn
 * @param {object[]} turn.messages     chat history; this turn's exchange is appended to it
 * @param {Uint8Array} turn.videoFileData
 * @param {(body: object) => Promise<object>} turn.post   POST /api/v2/chat, returns the parsed reply
 * @param {AbortSignal} [turn.signal]
 * @param {object} turn.ui  { setProcessing, setVideoFileData, addMessage, addAssistantMessage, nextId, onStatus, onToolStart, uploadedVideos }
 * @returns {Promise<'done'>}
 */
export async function runClientTurn({ messages, videoFileData, post, signal, ui }) {
  const { setProcessing, setVideoFileData, addMessage, addAssistantMessage, nextId, onStatus, onToolStart, uploadedVideos } = ui;
  const report = status => { if (status) onStatus?.(status); };
  const latestUser = [...messages].reverse().find(m => m?.role === 'user' && !m?.excludeFromAPI && !m?.apiContent);
  if (!latestUser) return 'done';

  let working = videoFileData;
  const setWorking = data => {
    noteDerivedVideo(working, data);
    working = data;
    setVideoFileData(data);
  };

  // Engine and tool progress for whichever tool is running.
  let running = null; // { name, index, total }
  const unsubscribe = subscribeEngine(state => {
    if (state.phase === 'loading') report({ text: 'Downloading the video engine (first edit only)…' });
    else if (state.phase === 'running' && running) report(toolRunStatus(running.name, running.index, running.total, state));
  });
  setToolStatusListener(status => report(status));

  try {
    report({ text: 'Reading the file…' });
    let media = await describeMedia(working, getCurrentFileMimeType());
    let conversation = [{ role: 'user', content: latestUser.content }];
    let turnToken;

    for (let round = 0; round < MAX_CLIENT_ROUNDS; round += 1) {
      if (signal?.aborted) throw new Error('Job cancelled');
      report({ text: round === 0 ? 'Planning the edit…' : 'Checking the result…' });
      const reply = await post({ messages: conversation, media: mediaForRequest(media), ...(turnToken ? { turnToken } : {}) });

      if (reply.status !== 'tool_calls' || !reply.toolCalls?.length) {
        const text = typeof reply.message === 'string' && reply.message.trim() ? reply.message.trim() : 'Done.';
        messages.push({ role: 'assistant', content: text, id: addAssistantMessage(text) });
        return 'done';
      }

      conversation = reply.messages;
      turnToken = reply.turnToken;
      const assistant = conversation.at(-1);
      messages.push({ role: 'assistant', content: assistant?.content ?? null, tool_calls: assistant?.tool_calls || [], id: nextId() });

      setProcessing(true);
      try {
        let blocked = null; // the tool whose failure stops the rest of this round
        for (const [index, call] of reply.toolCalls.entries()) {
          if (signal?.aborted) throw new Error('Job cancelled');
          let result;
          if (blocked) {
            // Later calls were planned for the output of the one that failed.
            result = { ok: false, error: 'not_run', executedOn: 'browser', message: `Not run because ${blocked} failed.` };
          } else {
            const toolFunction = Object.hasOwn(toolFunctions, call.name) ? toolFunctions[call.name] : null;
            if (call.argumentsError || typeof toolFunction !== 'function') {
              result = { ok: false, error: call.argumentsError || 'unknown_tool', executedOn: 'browser', message: `"${call.name}" could not be run.` };
            } else {
              running = { name: call.name, index, total: reply.toolCalls.length };
              report(toolRunStatus(call.name, index, reply.toolCalls.length));
              onToolStart?.(call.name, call.arguments);
              resetLastExecution();
              const before = working;
              const text = call.name === 'add_video_transition'
                ? await toolFunction(call.arguments, working, setWorking, addMessage, uploadedVideos)
                : await toolFunction(call.arguments, working, setWorking, addMessage);
              running = null;
              if (signal?.aborted) throw new Error('Job cancelled');
              const changed = working !== before;
              if (changed) media = await describeMedia(working, getCurrentFileMimeType());
              result = toolResultFor(text, getLastExecution(), changed ? media : undefined);
            }
            if (!result.ok) blocked = call.name;
          }
          const content = JSON.stringify(result);
          conversation.push({ role: 'tool', tool_call_id: call.id, content });
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content, id: nextId() });
        }
      } finally {
        running = null;
        setProcessing(false);
      }
    }
    throw new Error('The edit did not finish within the allowed number of steps');
  } finally {
    unsubscribe();
    setToolStatusListener(null);
  }
}
