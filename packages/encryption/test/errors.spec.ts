import { describe, expect, it } from 'vitest';
import {
  EncryptionError,
  EncryptionConfigError,
  EncryptionExecutionError,
  EncryptionValidationError,
  toEncryptionErrorEnvelope,
} from '../src/errors.js';

describe('EncryptionError (base)', () => {
  it('constructor sets code, message, name, and is an Error subclass', () => {
    const err = new EncryptionError('VALIDATION', 'oops');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EncryptionError);
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('oops');
    expect(err.name).toBe('EncryptionError');
  });
});

describe('EncryptionValidationError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('zod issue chain');
    const err = new EncryptionValidationError('bad params', { cause });
    expect(err.code).toBe('VALIDATION');
    expect(err.name).toBe('EncryptionValidationError');
    expect(err).toBeInstanceOf(EncryptionError);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});

describe('EncryptionExecutionError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('KMS API: rate limit exceeded');
    const err = new EncryptionExecutionError('encrypt failed', { cause });
    expect(err.code).toBe('EXECUTION_FAILED');
    expect(err.name).toBe('EncryptionExecutionError');
    expect(err).toBeInstanceOf(EncryptionError);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});

describe('EncryptionConfigError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('logger missing warn method');
    const err = new EncryptionConfigError('factory misconfig', { cause });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.name).toBe('EncryptionConfigError');
    expect(err).toBeInstanceOf(EncryptionError);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});

describe('toEncryptionErrorEnvelope', () => {
  it('preserves err.code when err is an EncryptionError', () => {
    const err = new EncryptionValidationError('bad params');
    const envelope = toEncryptionErrorEnvelope(err, 'corr-123');
    expect(envelope.code).toBe('VALIDATION');
    expect(envelope.message).toBe('bad params');
    expect(envelope.correlation_id).toBe('corr-123');
  });

  it("returns code='INTERNAL' for a generic Error without .code", () => {
    const err = new Error('plain error');
    const envelope = toEncryptionErrorEnvelope(err, 'corr-456');
    expect(envelope.code).toBe('INTERNAL');
    expect(envelope.message).toBe('plain error');
  });

  it('puts only the .message on the envelope — no stack trace', () => {
    const err = new Error('boom');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('boom');
    const envelope = toEncryptionErrorEnvelope(err, 'corr-789');
    expect(envelope.message).toBe('boom');
    expect(envelope.message).not.toContain('at ');
    expect(envelope.message).not.toContain(err.stack ?? '');
  });

  it('populates correlation_id and details when supplied; omits details when not', () => {
    const err = new EncryptionExecutionError('kms unwrap');
    const withDetails = toEncryptionErrorEnvelope(err, 'corr-with', {
      tenant_id: 'abc',
      key_resource_name: 'projects/x/.../cryptoKeys/y',
    });
    expect(withDetails.details).toEqual({
      tenant_id: 'abc',
      key_resource_name: 'projects/x/.../cryptoKeys/y',
    });

    const without = toEncryptionErrorEnvelope(err, 'corr-without');
    expect(Object.hasOwn(without, 'details')).toBe(false);
  });
});
