import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildKeyResourceName,
  getKmsKeyring,
  getKmsLocation,
  getProjectId,
} from '../src/config.js';
import { ConfigError } from '../src/errors.js';

describe('config', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['GCP_PROJECT_ID', 'CORTEX_KMS_LOCATION', 'CORTEX_KMS_KEYRING'];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('getProjectId', () => {
    it('returns the value when set', () => {
      process.env.GCP_PROJECT_ID = 'sevyn8-cortex-dev';
      expect(getProjectId()).toBe('sevyn8-cortex-dev');
    });

    it('throws ConfigError when unset', () => {
      delete process.env.GCP_PROJECT_ID;
      expect(() => getProjectId()).toThrow(ConfigError);
    });

    it('throws ConfigError when empty string', () => {
      process.env.GCP_PROJECT_ID = '';
      expect(() => getProjectId()).toThrow(ConfigError);
    });
  });

  describe('getKmsLocation', () => {
    it('defaults to asia-south1 when unset', () => {
      delete process.env.CORTEX_KMS_LOCATION;
      expect(getKmsLocation()).toBe('asia-south1');
    });

    it('returns override when set', () => {
      process.env.CORTEX_KMS_LOCATION = 'us-central1';
      expect(getKmsLocation()).toBe('us-central1');
    });
  });

  describe('getKmsKeyring', () => {
    it('defaults to cortex-keyring when unset', () => {
      delete process.env.CORTEX_KMS_KEYRING;
      expect(getKmsKeyring()).toBe('cortex-keyring');
    });

    it('returns override when set', () => {
      process.env.CORTEX_KMS_KEYRING = 'alt-keyring';
      expect(getKmsKeyring()).toBe('alt-keyring');
    });
  });

  describe('buildKeyResourceName', () => {
    it('composes the fully-qualified resource name', () => {
      process.env.GCP_PROJECT_ID = 'sevyn8-cortex-dev';
      delete process.env.CORTEX_KMS_LOCATION;
      delete process.env.CORTEX_KMS_KEYRING;
      expect(buildKeyResourceName('cortex-general-key')).toBe(
        'projects/sevyn8-cortex-dev/locations/asia-south1/keyRings/cortex-keyring/cryptoKeys/cortex-general-key',
      );
    });

    it('honors env var overrides', () => {
      process.env.GCP_PROJECT_ID = 'p';
      process.env.CORTEX_KMS_LOCATION = 'l';
      process.env.CORTEX_KMS_KEYRING = 'r';
      expect(buildKeyResourceName('k')).toBe('projects/p/locations/l/keyRings/r/cryptoKeys/k');
    });

    it('throws ConfigError when GCP_PROJECT_ID unset', () => {
      delete process.env.GCP_PROJECT_ID;
      expect(() => buildKeyResourceName('k')).toThrow(ConfigError);
    });
  });
});
