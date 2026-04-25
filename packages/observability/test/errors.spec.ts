import { describe, it, expect } from 'vitest';
import {
  ObservabilityError,
  ObservabilityConfigError,
  ObservabilityContextError,
  ObservabilityExportError,
  ObservabilityValidationError,
  toErrorEnvelope,
} from '../src/errors.js';

describe('ObservabilityError (base)', () => {
  it('is an Error subclass', () => {
    const err = new ObservabilityError('VALIDATION', 'oops');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ObservabilityError);
  });

  it('constructor sets code, message, and name', () => {
    const err = new ObservabilityError('CONFIG_INVALID', 'bad config');
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toBe('bad config');
    expect(err.name).toBe('ObservabilityError');
  });
});

describe('ObservabilityConfigError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('underlying');
    const err = new ObservabilityConfigError('invalid moduleId', { cause });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.name).toBe('ObservabilityConfigError');
    expect(err).toBeInstanceOf(ObservabilityError);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});

describe('ObservabilityExportError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('OTLP timeout');
    const err = new ObservabilityExportError('export failed', { cause });
    expect(err.code).toBe('EXPORT_FAILED');
    expect(err.name).toBe('ObservabilityExportError');
    expect(err).toBeInstanceOf(ObservabilityError);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});

describe('ObservabilityContextError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('bad context payload');
    const err = new ObservabilityContextError('context invalid', { cause });
    expect(err.code).toBe('CONTEXT_INVALID');
    expect(err.name).toBe('ObservabilityContextError');
    expect(err).toBeInstanceOf(ObservabilityError);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});

describe('ObservabilityValidationError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('regex mismatch');
    const err = new ObservabilityValidationError('bad input', { cause });
    expect(err.code).toBe('VALIDATION');
    expect(err.name).toBe('ObservabilityValidationError');
    expect(err).toBeInstanceOf(ObservabilityError);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
  });
});

describe('toErrorEnvelope', () => {
  it('preserves err.code when err is an ObservabilityError', () => {
    const err = new ObservabilityValidationError('bad input');
    const envelope = toErrorEnvelope(err, 'corr-123');
    expect(envelope.code).toBe('VALIDATION');
    expect(envelope.message).toBe('bad input');
    expect(envelope.correlation_id).toBe('corr-123');
  });

  it("returns code='INTERNAL' for a generic Error without .code", () => {
    const err = new Error('plain error');
    const envelope = toErrorEnvelope(err, 'corr-456');
    expect(envelope.code).toBe('INTERNAL');
    expect(envelope.message).toBe('plain error');
  });

  it('puts only the .message on the envelope — no stack trace', () => {
    const err = new Error('boom');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('boom');
    const envelope = toErrorEnvelope(err, 'corr-789');
    expect(envelope.message).toBe('boom');
    expect(envelope.message).not.toContain('at ');
    expect(envelope.message).not.toContain(err.stack ?? '');
  });

  it('populates correlation_id and details when supplied', () => {
    const err = new ObservabilityConfigError('cfg');
    const envelope = toErrorEnvelope(err, 'corr-abc', { field: 'email' });
    expect(envelope.correlation_id).toBe('corr-abc');
    expect(envelope.details).toEqual({ field: 'email' });
  });

  it('omits details key entirely when not supplied', () => {
    const err = new ObservabilityConfigError('cfg');
    const envelope = toErrorEnvelope(err, 'corr-no-details');
    expect(Object.hasOwn(envelope, 'details')).toBe(false);
  });
});
