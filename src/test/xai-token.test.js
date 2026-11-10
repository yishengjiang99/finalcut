// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { xaiToken } from '../server/xaiToken.js';
import { generateCopy, setCopyFetchForTests, memoryCopyCache } from '../server/push/copy.js';

describe('xaiToken', () => {
  it('prefers XAI_API_TOKEN', () => expect(xaiToken({ XAI_API_TOKEN: ' t ', XAI_API_KEY: 'k' })).toBe('t'));
  it('still accepts XAI_API_KEY', () => expect(xaiToken({ XAI_API_KEY: 'k' })).toBe('k'));
  it('is empty when neither is set', () => expect(xaiToken({})).toBe(''));
});

describe('push copy uses the xAI key under either name', () => {
  const saved = { t: process.env.XAI_API_TOKEN, k: process.env.XAI_API_KEY };
  afterEach(() => {
    setCopyFetchForTests(null);
    for (const [n, v] of [['XAI_API_TOKEN', saved.t], ['XAI_API_KEY', saved.k]]) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  });
  it('sends XAI_API_KEY as the bearer when XAI_API_TOKEN is unset', async () => {
    delete process.env.XAI_API_TOKEN; process.env.XAI_API_KEY = 'legacy-key';
    const auths = [];
    setCopyFetchForTests(async (_u, init) => { auths.push(init.headers.authorization); return { ok: false, status: 500 }; });
    await generateCopy('new_no_edit', 'first edit', {}, { useGrok: true, cache: memoryCopyCache, bypassCache: true });
    expect(auths.length).toBeGreaterThan(0);
    expect(auths.every((a) => a === 'Bearer legacy-key')).toBe(true);
  });
});
