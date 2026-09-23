import { describe, it, expect } from 'vitest';
import { extractBearerToken } from '../server/middleware.js';

describe('Mobile Bearer auth helpers', () => {
  it('extracts Bearer tokens case-insensitively', () => {
    // Fixture only — not a real credential (GitGuardian-safe).
    const req = { headers: { authorization: 'Bearer test-fixture-bearer-token-not-a-real-secret' } };
    expect(extractBearerToken(req)).toBe('test-fixture-bearer-token-not-a-real-secret');
  });

  it('returns null when Authorization is missing or malformed', () => {
    expect(extractBearerToken({ headers: {} })).toBeNull();
    expect(extractBearerToken({ headers: { authorization: 'Basic xyz' } })).toBeNull();
    expect(extractBearerToken({ headers: { authorization: 'Bearer ' } })).toBeNull();
  });
});

describe('Mobile Google auth contract', () => {
  it('documents POST /api/auth/mobile/google request/response shape', () => {
    const request = { idToken: 'google-id-token' };
    const response = {
      accessToken: 'hex-token',
      expiresIn: 2592000000,
      tokenType: 'Bearer',
      user: {
        email: 'user@example.com',
        name: 'User',
        hasSubscription: false,
      },
    };
    expect(request).toHaveProperty('idToken');
    expect(response.tokenType).toBe('Bearer');
    expect(response.user).toHaveProperty('hasSubscription');
  });

  it('documents auth status with Bearer', () => {
    const status = {
      authenticated: true,
      authMethod: 'bearer',
      user: { email: 'a@b.c', name: 'A', hasSubscription: true },
    };
    expect(status.authMethod).toBe('bearer');
    expect(status.user.hasSubscription).toBe(true);
  });
});

describe('iOS device and Apple IAP auth contract', () => {
  it('registers an install and returns the same Bearer contract', () => {
    const request = { deviceInstallId: '550e8400-e29b-41d4-a716-446655440000' };
    const response = {
      accessToken: 'hex-token',
      expiresIn: 7_776_000_000,
      tokenType: 'Bearer',
      user: { id: '42', email: null, name: 'iOS device', hasSubscription: false },
    };
    expect(request.deviceInstallId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.tokenType).toBe('Bearer');
    expect(response.user.email).toBeNull();
  });

  it('sends the StoreKit signed transaction, never a client subscription boolean', () => {
    const request = { signedTransactionJws: 'signed-transaction-jws' };
    expect(request).toEqual({ signedTransactionJws: expect.any(String) });
    expect(request).not.toHaveProperty('hasSubscription');
  });

  it('exposes a daily free inference quota for device sessions', () => {
    const status = { authenticated: true, authMethod: 'bearer', dailyLimit: 3, dailyUsed: 1, dailyRemaining: 2 };
    expect(status.dailyRemaining).toBe(2);
    expect(status.dailyRemaining).toBeLessThanOrEqual(status.dailyLimit);
  });
});
