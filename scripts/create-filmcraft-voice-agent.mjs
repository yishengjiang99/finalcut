// One-time: create the FilmCraft voice agent (ElevenLabs Conversational AI) with the client tool
// edit_video(instruction). Prints the agent id -> put it in .env as FILMCRAFT_VOICE_AGENT_ID.
// Usage: ELEVENLABS_API_KEY=... node scripts/create-filmcraft-voice-agent.mjs   (key needs convai_write)
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error('ELEVENLABS_API_KEY missing'); process.exit(1); }
const body = {
  name: 'FilmCraft voice editor',
  conversation_config: {
    agent: {
      first_message: 'Hi! Tell me how to edit your video.',
      language: 'en',
      prompt: {
        prompt: 'You are the voice assistant for FilmCraft, a browser video editor. When the user asks for any edit, ' +
          'playback or project action, call the edit_video tool with their instruction in plain words (include times, clip ' +
          'names, track names). Then briefly say what was done using the tool result. Keep replies short. Ask a short question if the request is unclear.',
        tools: [{
          type: 'client', name: 'edit_video', expects_response: true, response_timeout_secs: 60,
          description: 'Apply an editing instruction to the open FilmCraft project; returns what was done or an error.',
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
console.log(`FILMCRAFT_VOICE_AGENT_ID=${d.agent_id}`);
