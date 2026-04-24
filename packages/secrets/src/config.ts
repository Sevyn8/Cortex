import { ConfigError } from './errors.js';

export function getProjectId(): string {
  const id = process.env.GCP_PROJECT_ID;
  if (id === undefined || id.length === 0) {
    throw new ConfigError('GCP_PROJECT_ID environment variable is required');
  }
  return id;
}

export function getKmsLocation(): string {
  return process.env.CORTEX_KMS_LOCATION ?? 'asia-south1';
}

export function getKmsKeyring(): string {
  return process.env.CORTEX_KMS_KEYRING ?? 'cortex-keyring';
}

export function buildKeyResourceName(keyId: string): string {
  return `projects/${getProjectId()}/locations/${getKmsLocation()}/keyRings/${getKmsKeyring()}/cryptoKeys/${keyId}`;
}
