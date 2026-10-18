// The earlier turns of the conversation, as text, for the model. Each request used to carry only the
// latest user message, so a follow-up like "Default" (the answer to the caption style question) reached
// the model without the request it answered ("Caption in Chinese") and the target language was lost.
//
// Only the words go: user messages and the assistant's final replies (including a question it asked).
// Never media, previews, tool calls or tool results of earlier turns (the final reply already says what
// they did), so the history cannot break the tool-call loop or count an edit twice. It starts after the
// latest file upload, bounded by message count and characters, oldest dropped first.
export const HISTORY_MAX_MESSAGES = 12; // six exchanges
export const HISTORY_MAX_CHARS = 6000;
export const HISTORY_MAX_MESSAGE_CHARS = 1500;

const isRealUser = (m) => m?.role === 'user' && !m?.excludeFromAPI && !m?.apiContent;

const textOf = (content) => {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map(p => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('\n').trim();
  return '';
};

/** `messages` is the chat state (UI messages included). Returns [{ role, content }] before the latest user message. */
export function priorHistory(messages, { maxMessages = HISTORY_MAX_MESSAGES, maxChars = HISTORY_MAX_CHARS, maxMessageChars = HISTORY_MAX_MESSAGE_CHARS } = {}) {
  if (!Array.isArray(messages)) return [];
  const latest = messages.findLastIndex(isRealUser);
  if (latest <= 0) return [];
  // A new upload starts a new conversation about a new file.
  const upload = messages.slice(0, latest).findLastIndex(m => m?.apiContent);
  const turns = [];
  for (const m of messages.slice(upload + 1, latest)) {
    if (m?.excludeFromAPI || m?.apiContent) continue;
    if (m?.role === 'user') {
      const content = textOf(m.content);
      if (content) turns.push({ role: 'user', content: content.slice(0, maxMessageChars) });
    } else if (m?.role === 'assistant' && !m.tool_calls?.length) {
      const content = textOf(m.content);
      if (content) turns.push({ role: 'assistant', content: content.slice(0, maxMessageChars) });
    }
  }
  let kept = turns.slice(-maxMessages);
  let total = 0;
  const bounded = [];
  for (let i = kept.length - 1; i >= 0; i--) {
    total += kept[i].content.length;
    if (total > maxChars) break;
    bounded.unshift(kept[i]);
  }
  kept = bounded;
  while (kept.length && kept[0].role !== 'user') kept.shift(); // start on a user message
  return kept;
}
