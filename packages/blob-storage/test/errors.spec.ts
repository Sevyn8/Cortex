import { describe, expect, it } from 'vitest';
import {
  BlobStorageError,
  BlobStorageConfigError,
  BlobStorageValidationError,
  toBlobStorageErrorEnvelope,
} from '../src/errors.js';

describe('BlobStorageError (base)', () => {
  it('constructor sets code, message, name, and is an Error subclass', () => {
    const err = new BlobStorageError('VALIDATION', 'oops');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BlobStorageError);
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('oops');
    expect(err.name).toBe('BlobStorageError');
  });
});

describe('BlobStorageValidationError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('zod issue chain');
    const err = new BlobStorageValidationError('bad params', { cause });
    expect(err.code).toBe('VALIDATION');
    expect(err.name).toBe('BlobStorageValidationError');
    expect(err).toBeInstanceOf(BlobStorageError);
    expect(err.cause).toBe(cause);
  });
});

describe('BlobStorageConfigError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('storage missing bucket method');
    const err = new BlobStorageConfigError('factory misconfig', { cause });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.name).toBe('BlobStorageConfigError');
    expect(err).toBeInstanceOf(BlobStorageError);
    expect(err.cause).toBe(cause);
  });
});

describe('toBlobStorageErrorEnvelope', () => {
  it('preserves err.code when err is a BlobStorageError', () => {
    const err = new BlobStorageValidationError('bad path');
    const envelope = toBlobStorageErrorEnvelope(err, 'corr-123');
    expect(envelope.code).toBe('VALIDATION');
    expect(envelope.message).toBe('bad path');
    expect(envelope.correlation_id).toBe('corr-123');
  });

  it("returns code='INTERNAL' for a generic Error without .code", () => {
    const envelope = toBlobStorageErrorEnvelope(new Error('plain'), 'corr-456');
    expect(envelope.code).toBe('INTERNAL');
    expect(envelope.message).toBe('plain');
  });

  it('populates details when supplied; omits details when not', () => {
    const err = new BlobStorageValidationError('cross-tenant attempt');
    const withDetails = toBlobStorageErrorEnvelope(err, 'corr-with', {
      tenant_id: 'abc',
      object_path: 'tenants/other/foo',
    });
    expect(withDetails.details).toEqual({
      tenant_id: 'abc',
      object_path: 'tenants/other/foo',
    });

    const without = toBlobStorageErrorEnvelope(err, 'corr-without');
    expect(Object.hasOwn(without, 'details')).toBe(false);
  });
});
