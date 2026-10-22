// Mic button: ElevenLabs Conversational AI session whose client tool `edit_video(instruction)` feeds the
// spoken request into the normal chat/edit flow (the same handleSend as typing) and returns a short result
// for the voice to speak. Token from GET /api/voice/token (key stays on the server; 503 when off).
import { useRef, useState } from 'react';

export const TOKEN_URL = '/api/voice/token';

/** Short spoken summary of what the chat turn produced (last assistant text after the turn). */
export function summarize(status, reply) {
  if (status === 'busy') return 'An edit is already running. Please wait for it to finish.';
  if (status === 'cancelled') return 'The edit was cancelled.';
  const text = String(reply || '').replace(/[*_`#>\[\]()]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return status === 'error' ? 'Something went wrong with that edit.' : 'Done.';
  return text.length > 400 ? text.slice(0, 397) + '…' : text;
}

export default function VoiceButton({ runPrompt, disabled, onNotice }) {
  const [state, setState] = useState('off'); // off | connecting | on
  const convoRef = useRef(null);
  const runRef = useRef(runPrompt);
  runRef.current = runPrompt;

  const stop = async () => {
    const c = convoRef.current; convoRef.current = null; setState('off');
    if (c) await c.endSession().catch(() => {});
  };
  const start = async () => {
    setState('connecting');
    try {
      const r = await fetch(TOKEN_URL, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 503 ? 'Voice is not available right now.' : `Voice failed to start (${r.status}).`);
      const { signedUrl } = await r.json();
      const { Conversation } = await import('@elevenlabs/client');
      convoRef.current = await Conversation.startSession({
        signedUrl, connectionType: 'websocket',
        clientTools: {
          edit_video: async ({ instruction }) => {
            try { return await runRef.current(String(instruction || '')); }
            catch (e) { return 'That failed: ' + (e?.message || 'unknown error'); }
          },
        },
        onConnect: () => setState('on'),
        onDisconnect: () => { convoRef.current = null; setState('off'); },
        onError: (m) => onNotice?.('Voice: ' + m),
      });
    } catch (e) {
      convoRef.current = null; setState('off');
      onNotice?.(e?.message || 'Voice failed to start.');
    }
  };
  return (
    <button type="button" className={`icon-btn voice-btn${state !== 'off' ? ' on' : ''}`}
      title={state === 'off' ? 'Talk to edit (voice)' : 'Stop voice'} aria-label={state === 'off' ? 'Start voice' : 'Stop voice'}
      aria-pressed={state !== 'off'} disabled={disabled && state === 'off'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); state === 'off' ? start() : stop(); }}>
      {state === 'connecting' ? '…' : '🎤'}
    </button>
  );
}
