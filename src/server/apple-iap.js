import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import {
  APPLE_IAP_APPLE_ID,
  APPLE_IAP_BUNDLE_ID,
  APPLE_IAP_ENVIRONMENT,
  APPLE_IAP_ENVIRONMENT_IS_PINNED,
  APPLE_IAP_ROOT_CERTS_BASE64,
} from './config.js';
import { APPLE_ROOT_CA_CERTS_BASE64 } from './apple-root-cas.js';

const verifiers = new Map();

function resolveEnvironment(value) {
  return Object.values(Environment).find((env) => env === value) || null;
}

function configuredCertificates() {
  const fromEnv = APPLE_IAP_ROOT_CERTS_BASE64.split(',').map((value) => value.trim()).filter(Boolean);
  // The env var is an override. The bundled Apple Root CAs are the default so
  // verification cannot silently 503 forever just because a deployment env
  // var was never set (the 2026-10-24 production failure).
  return fromEnv.length > 0 ? fromEnv : APPLE_ROOT_CA_CERTS_BASE64;
}

/**
 * Which environment's verifier should check this transaction. An explicit
 * APPLE_IAP_ENVIRONMENT pin wins. Otherwise the JWS payload's own
 * `environment` claim selects the verifier (Production for App Store builds,
 * Sandbox for TestFlight) — the claim only chooses which verifier runs; a
 * transaction that lies about its environment still fails signature checks.
 * Falls back to the configured default when the claim is missing/unreadable.
 */
export function environmentForTransaction(signedTransactionJws) {
  if (!APPLE_IAP_ENVIRONMENT_IS_PINNED && typeof signedTransactionJws === 'string') {
    try {
      const segment = signedTransactionJws.split('.')[1];
      const payload = JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      const fromClaim = resolveEnvironment(payload?.environment);
      if (fromClaim) return fromClaim;
    } catch {
      // Not a decodable JWS — verification below will reject it.
    }
  }
  const configured = resolveEnvironment(APPLE_IAP_ENVIRONMENT);
  if (!configured) {
    throw new Error(`Unsupported APPLE_IAP_ENVIRONMENT: ${APPLE_IAP_ENVIRONMENT}`);
  }
  return configured;
}

function getVerifier(environment) {
  if (verifiers.has(environment)) return verifiers.get(environment);
  const encodedCertificates = configuredCertificates();
  if (encodedCertificates.length === 0) {
    const error = new Error('Apple IAP verification is not configured');
    error.statusCode = 503;
    throw error;
  }
  const verifier = new SignedDataVerifier(
    encodedCertificates.map((value) => Buffer.from(value, 'base64')),
    true,
    environment,
    APPLE_IAP_BUNDLE_ID,
    APPLE_IAP_APPLE_ID
  );
  verifiers.set(environment, verifier);
  return verifier;
}

export async function verifyAppleTransaction(signedTransactionJws) {
  if (typeof signedTransactionJws !== 'string' || signedTransactionJws.length < 100) {
    const error = new Error('signedTransactionJws is required');
    error.statusCode = 400;
    throw error;
  }

  const transaction = await getVerifier(environmentForTransaction(signedTransactionJws)).verifyAndDecodeTransaction(signedTransactionJws);
  if (transaction.bundleId !== APPLE_IAP_BUNDLE_ID) {
    const error = new Error('Apple transaction belongs to a different app');
    error.statusCode = 400;
    throw error;
  }
  return transaction;
}

export function resetAppleVerifierForTests() {
  verifiers.clear();
}
