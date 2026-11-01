// "Add soundtrack" composer button: the prompt it pre-fills (never sent automatically).
export function soundtrackPrompt(durationSeconds) {
  const secs = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds) : null;
  return `Add a music soundtrack to this video. Generate an original track that fits it, ${secs ? `about ${secs} seconds long` : 'about as long as the video'}, and add it as the music track.`;
}
