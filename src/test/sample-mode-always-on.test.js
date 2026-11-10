// @vitest-environment node
// Sample mode has no off switch: ALLOW_UNAUTH_SAMPLE_MODE is ignored; a valid short-lived sample token is still
// required (no token or a made-up token is rejected).
import { describe, it, expect, beforeAll } from 'vitest';

let mw;
beforeAll(async () => {
  process.env.ALLOW_UNAUTH_SAMPLE_MODE = 'false';
  mw = await import('../server/middleware.js');
});

describe('sample mode (always on, token-gated)', () => {
  it('accepts an issued token even with ALLOW_UNAUTH_SAMPLE_MODE=false', () => {
    const token = mw.issueSampleAccessToken();
    expect(mw.isValidSampleModeRequest({ headers: { 'sample-access-token': token } })).toBe(true);
  });
  it('rejects a missing or unknown token', () => {
    expect(mw.isValidSampleModeRequest({ headers: {} })).toBe(false);
    expect(mw.isValidSampleModeRequest({ headers: { 'sample-access-token': 'not-issued' } })).toBe(false);
  });
});
