// One-time: create the FinalCut chat voice agent (ElevenLabs Conversational AI) with the client tool
// edit_video(instruction). Prints the agent id -> put it in .env as FINALCUT_VOICE_AGENT_ID.
// Usage: ELEVENLABS_API_KEY=... node scripts/create-finalcut-voice-agent.mjs   (key needs convai_write)
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error('ELEVENLABS_API_KEY missing'); process.exit(1); }
const body = {
  name: 'FinalCut voice editor',
  conversation_config: {
    agent: {
      first_message: 'Hi! What should I do with your video?',
      language: 'en',
      prompt: {
        prompt: 'You are the voice assistant for FinalCut (grepawk.com), a chat-based video editor: the user attaches a ' +
          'video or audio file and asks for edits (trim, captions, speed, filters, convert, etc.) or questions about it. ' +
          'For every request about their media or the editor, call edit_video with the request in plain words (keep times, ' +
          'formats and wording they gave). It runs the same chat as typing and returns the assistant reply; summarize it ' +
          'in one or two short sentences. If no file is attached yet, tell them to tap the paperclip to attach one. Keep replies brief.',
        tools: [{
          type: 'client', name: 'edit_video', expects_response: true, response_timeout_secs: 60,
          description: 'Send the request to the FinalCut chat editor (same as typing it); returns the assistant reply.',
          parameters: { type: 'object', required: ['instruction'],
            properties: { instruction: { type: 'string', description: 'The edit to perform, e.g. "split the first clip at 5 seconds".' } } },
        }],
      },
    },
  },
};
const r = await fetch('https://api.elevenlabs.io/v1/convai/agents/create', {
  method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const d = await r.json();
if (!r.ok) { console.error(r.status, JSON.stringify(d)); process.exit(1); }
console.log(`FINALCUT_VOICE_AGENT_ID=${d.agent_id}`);
