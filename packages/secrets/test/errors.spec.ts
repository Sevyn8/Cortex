import { describe, expect, it } from 'vitest';
import {
  SecretsError,
  SecretsValidationError,
  ConfigError,
  SecretNotFoundError,
  PermissionDeniedError,
  EnvelopeEncryptError,
  EnvelopeDecryptError,
  KmsUnavailableError,
} from '../src/errors.js';

describe('error hierarchy', () => {
  const cases = [
    {
      Cls: SecretsValidationError,
      code: 'VALIDATION',
      name: 'SecretsValidationError',
    },
    { Cls: ConfigError, code: 'CONFIG', name: 'ConfigError' },
    { Cls: SecretNotFoundError, code: 'NOT_FOUND', name: 'SecretNotFoundError' },
    {
      Cls: PermissionDeniedError,
      code: 'PERMISSION_DENIED',
      name: 'PermissionDeniedError',
    },
    {
      Cls: EnvelopeEncryptError,
      code: 'ENVELOPE_ENCRYPT_FAILED',
      name: 'EnvelopeEncryptError',
    },
    {
      Cls: EnvelopeDecryptError,
      code: 'ENVELOPE_DECRYPT_FAILED',
      name: 'EnvelopeDecryptError',
    },
    {
      Cls: KmsUnavailableError,
      code: 'KMS_UNAVAILABLE',
      name: 'KmsUnavailableError',
    },
  ] as const;

  for (const { Cls, code, name } of cases) {
    it(`${name}: instanceof + code + name`, () => {
      const e = new Cls('test message');
      expect(e).toBeInstanceOf(Cls);
      expect(e).toBeInstanceOf(SecretsError);
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toBe(code);
      expect(e.name).toBe(name);
      expect(e.message).toBe('test message');
    });

    it(`${name}: cause chaining preserves original`, () => {
      const original = new Error('original');
      const wrapped = new Cls('wrapped', { cause: original });
      expect(wrapped.cause).toBe(original);
    });
  }
});
