import { describe, expect, it } from 'vitest';
import {
  AuditEventError,
  AuditEventConfigError,
  AuditEventEmissionError,
  AuditEventValidationError,
  toAuditEventErrorEnvelope,
} from '../src/errors.js';

describe('AuditEventError (base)', () => {
  it('constructor sets code, message, name, and is an Error subclass', () => {
    const err = new AuditEventError('VALIDATION', 'oops');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AuditEventError);
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('oops');
    expect(err.name).toBe('AuditEventError');
  });
});

describe('AuditEventValidationError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('zod issue chain');
    const err = new AuditEventValidationError('bad params', { cause });
    expect(err.code).toBe('VALIDATION');
    expect(err.name).toBe('AuditEventValidationError');
    expect(err).toBeInstanceOf(AuditEventError);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});

describe('AuditEventEmissionError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('pg driver: SQLSTATE 42501');
    const err = new AuditEventEmissionError('RLS denied', { cause });
    expect(err.code).toBe('EMISSION_FAILED');
    expect(err.name).toBe('AuditEventEmissionError');
    expect(err).toBeInstanceOf(AuditEventError);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});

describe('AuditEventConfigError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('bad logger options');
    const err = new AuditEventConfigError('factory misconfig', { cause });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.name).toBe('AuditEventConfigError');
    expect(err).toBeInstanceOf(AuditEventError);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});

describe('toAuditEventErrorEnvelope', () => {
  it('preserves err.code when err is an AuditEventError', () => {
    const err = new AuditEventValidationError('bad name');
    const envelope = toAuditEventErrorEnvelope(err, 'corr-123');
    expect(envelope.code).toBe('VALIDATION');
    expect(envelope.message).toBe('bad name');
    expect(envelope.correlation_id).toBe('corr-123');
  });

  it("returns code='INTERNAL' for a generic Error without .code", () => {
    const err = new Error('plain error');
    const envelope = toAuditEventErrorEnvelope(err, 'corr-456');
    expect(envelope.code).toBe('INTERNAL');
    expect(envelope.message).toBe('plain error');
  });

  it('puts only the .message on the envelope — no stack trace', () => {
    const err = new Error('boom');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('boom');
    const envelope = toAuditEventErrorEnvelope(err, 'corr-789');
    expect(envelope.message).toBe('boom');
    expect(envelope.message).not.toContain('at ');
    expect(envelope.message).not.toContain(err.stack ?? '');
  });

  it('populates correlation_id and details when supplied; omits details when not', () => {
    const err = new AuditEventEmissionError('cfg');
    const withDetails = toAuditEventErrorEnvelope(err, 'corr-with', { field: 'tenantId' });
    expect(withDetails.details).toEqual({ field: 'tenantId' });

    const without = toAuditEventErrorEnvelope(err, 'corr-without');
    expect(Object.hasOwn(without, 'details')).toBe(false);
  });
});
