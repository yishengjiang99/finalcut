import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { Environment } from '@apple/app-store-server-library';
import { APPLE_ROOT_CA_CERTS_BASE64 } from '../server/apple-root-cas.js';
import {
  verifyAppleTransaction,
  environmentForTransaction,
  resetAppleVerifierForTests,
} from '../server/apple-iap.js';

function fakeJws(payload) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'ES256', x5c: [] })}.${b64(payload)}.${'x'.repeat(120)}`;
}

afterEach(() => {
  delete process.env.APPLE_IAP_ENVIRONMENT;
  vi.resetModules();
  resetAppleVerifierForTests();
});

describe('bundled Apple Root CA certificates', () => {
  it('decodes to the real Apple Root CA - G3 and G2 certs', () => {
    const subjects = APPLE_ROOT_CA_CERTS_BASE64.map(
      (b64) => new crypto.X509Certificate(Buffer.from(b64, 'base64')).subject
    );
    expect(subjects.some((s) => s.includes('Apple Root CA - G3'))).toBe(true);
    expect(subjects.some((s) => s.includes('Apple Root CA - G2'))).toBe(true);
  });
});

describe('verifyAppleTransaction configuration', () => {
  it('never fails with the 503 "not configured" error when env vars are unset (2026-10-24 incident)', async () => {
    // A structurally plausible but unsigned JWS must fail as a verification
    // error — not because the verifier was never configured, which is what
    // production returned for every real purchase while
    // APPLE_IAP_ROOT_CERTS_BASE64 was unset.
    const jws = fakeJws({ environment: 'Production', bundleId: 'com.ragnus.w2' });
    const error = await verifyAppleTransaction(jws).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).not.toBe(503);
    expect(error.message).not.toContain('not configured');
    expect(error.message).not.toContain('appAppleId is required');
  });

  it('rejects a missing/short JWS with 400 before verification', async () => {
    const error = await verifyAppleTransaction('short').catch((e) => e);
    expect(error.statusCode).toBe(400);
  });
});

describe('environmentForTransaction', () => {
  it('selects Sandbox for a TestFlight (Sandbox) transaction', () => {
    expect(environmentForTransaction(fakeJws({ environment: 'Sandbox' }))).toBe(Environment.SANDBOX);
  });

  it('selects Production for an App Store transaction', () => {
    expect(environmentForTransaction(fakeJws({ environment: 'Production' }))).toBe(Environment.PRODUCTION);
  });

  it('falls back to the configured default when the claim is absent or unreadable', () => {
    expect(environmentForTransaction(fakeJws({}))).toBe(Environment.PRODUCTION);
    expect(environmentForTransaction('not-a-jws')).toBe(Environment.PRODUCTION);
  });

  it('an explicit APPLE_IAP_ENVIRONMENT pin wins over the claim', async () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'Sandbox';
    vi.resetModules();
    const pinned = await import('../server/apple-iap.js');
    expect(pinned.environmentForTransaction(fakeJws({ environment: 'Production' }))).toBe(Environment.SANDBOX);
  });
});

describe('config defaults', () => {
  it('APPLE_IAP_APPLE_ID defaults to FinalCap\'s app id so a Production verifier can be built', async () => {
    vi.resetModules();
    const { APPLE_IAP_APPLE_ID } = await import('../server/config.js');
    expect(APPLE_IAP_APPLE_ID).toBe(6815060815);
  });
});
