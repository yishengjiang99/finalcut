// The xAI key. XAI_API_TOKEN is the standard name; XAI_API_KEY is still accepted. No side effects.
export function xaiToken(env = process.env) {
  return String(env.XAI_API_TOKEN || env.XAI_API_KEY || '').trim();
}
