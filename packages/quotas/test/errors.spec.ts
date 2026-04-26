import { describe, expect, it } from 'vitest';
import {
  QuotaConfigError,
  QuotaError,
  QuotaExceededError,
  QuotaExecutionError,
  QuotaValidationError,
  toQuotaErrorEnvelope,
} from '../src/errors.js';

describe('QuotaError (base)', () => {
  it('constructor sets code, message, name, and is an Error subclass', () => {
    const err = new QuotaError('VALIDATION', 'oops');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('oops');
    expect(err.name).toBe('QuotaError');
  });
});

describe('QuotaValidationError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('zod issue chain');
    const err = new QuotaValidationError('bad params', { cause });
    expect(err.code).toBe('VALIDATION');
    expect(err.name).toBe('QuotaValidationError');
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.cause).toBe(cause);
  });
});

describe('QuotaExceededError', () => {
  it('carries bigint currentValue + quotaLimit + numeric retryAfterSeconds', () => {
    const err = new QuotaExceededError('exceeded', {
      currentValue: 601n,
      quotaLimit: 600n,
      retryAfterSeconds: 30,
    });
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.name).toBe('QuotaExceededError');
    expect(err).toBeInstanceOf(QuotaError);

    expect(typeof err.currentValue).toBe('bigint');
    expect(err.currentValue).toBe(601n);
    expect(typeof err.quotaLimit).toBe('bigint');
    expect(err.quotaLimit).toBe(600n);
    expect(typeof err.retryAfterSeconds).toBe('number');
    expect(err.retryAfterSeconds).toBe(30);
  });
});

describe('QuotaExecutionError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('pg driver: SQLSTATE 42501');
    const err = new QuotaExecutionError('upsert denied', { cause });
    expect(err.code).toBe('EXECUTION_FAILED');
    expect(err.name).toBe('QuotaExecutionError');
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.cause).toBe(cause);
  });
});

describe('QuotaConfigError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('logger missing warn method');
    const err = new QuotaConfigError('factory misconfig', { cause });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.name).toBe('QuotaConfigError');
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.cause).toBe(cause);
  });
});

describe('toQuotaErrorEnvelope', () => {
  it('preserves err.code when err is a QuotaError; bundles correlation_id', () => {
    const err = new QuotaValidationError('bad params');
    const envelope = toQuotaErrorEnvelope(err, 'corr-123');
    expect(envelope.code).toBe('VALIDATION');
    expect(envelope.message).toBe('bad params');
    expect(envelope.correlation_id).toBe('corr-123');
  });

  it("returns code='INTERNAL' for a generic Error; omits details when not supplied", () => {
    const envelope = toQuotaErrorEnvelope(new Error('plain'), 'corr-456');
    expect(envelope.code).toBe('INTERNAL');
    expect(envelope.message).toBe('plain');
    expect(Object.hasOwn(envelope, 'details')).toBe(false);

    // With details supplied
    const withDetails = toQuotaErrorEnvelope(
      new QuotaExceededError('over', {
        currentValue: 700n,
        quotaLimit: 600n,
        retryAfterSeconds: 15,
      }),
      'corr-789',
      { tenant_id: 'abc', resource_class: 'api_calls_per_minute' },
    );
    expect(withDetails.code).toBe('QUOTA_EXCEEDED');
    expect(withDetails.details).toEqual({
      tenant_id: 'abc',
      resource_class: 'api_calls_per_minute',
    });
  });
});
