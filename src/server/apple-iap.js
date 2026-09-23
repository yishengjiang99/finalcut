import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import {
  APPLE_IAP_APPLE_ID,
  APPLE_IAP_BUNDLE_ID,
  APPLE_IAP_ENVIRONMENT,
  APPLE_IAP_ROOT_CERTS_BASE64,
} from './config.js';

let verifier;

function getEnvironment() {
  const environment = Object.values(Environment).find((value) => value === APPLE_IAP_ENVIRONMENT);
  if (!environment) {
    throw new Error(`Unsupported APPLE_IAP_ENVIRONMENT: ${APPLE_IAP_ENVIRONMENT}`);
  }
  return environment;
}

function getVerifier() {
  if (verifier) return verifier;
  const encodedCertificates = APPLE_IAP_ROOT_CERTS_BASE64.split(',').map((value) => value.trim()).filter(Boolean);
  if (encodedCertificates.length === 0) {
    const error = new Error('Apple IAP verification is not configured');
    error.statusCode = 503;
    throw error;
  }
  verifier = new SignedDataVerifier(
    encodedCertificates.map((value) => Buffer.from(value, 'base64')),
    true,
    getEnvironment(),
    APPLE_IAP_BUNDLE_ID,
    APPLE_IAP_APPLE_ID
  );
  return verifier;
}

export async function verifyAppleTransaction(signedTransactionJws) {
  if (typeof signedTransactionJws !== 'string' || signedTransactionJws.length < 100) {
    const error = new Error('signedTransactionJws is required');
    error.statusCode = 400;
    throw error;
  }

  const transaction = await getVerifier().verifyAndDecodeTransaction(signedTransactionJws);
  if (transaction.bundleId !== APPLE_IAP_BUNDLE_ID) {
    const error = new Error('Apple transaction belongs to a different app');
    error.statusCode = 400;
    throw error;
  }
  return transaction;
}

export function resetAppleVerifierForTests() {
  verifier = undefined;
}
