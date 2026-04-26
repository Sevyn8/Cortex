import { describe, expect, it } from 'vitest';
import {
  ComputePlacementConfigError,
  ComputePlacementError,
  ComputePlacementValidationError,
  toComputePlacementErrorEnvelope,
} from '../src/errors.js';

describe('ComputePlacementError (base)', () => {
  it('constructor sets code, message, name, and is an Error subclass', () => {
    const err = new ComputePlacementError('VALIDATION', 'oops');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ComputePlacementError);
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('oops');
    expect(err.name).toBe('ComputePlacementError');
  });
});

describe('ComputePlacementValidationError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('zod issue chain');
    const err = new ComputePlacementValidationError('bad params', { cause });
    expect(err.code).toBe('VALIDATION');
    expect(err.name).toBe('ComputePlacementValidationError');
    expect(err).toBeInstanceOf(ComputePlacementError);
    expect(err.cause).toBe(cause);
  });
});

describe('ComputePlacementConfigError', () => {
  it('sets code, name, instanceof chain, and preserves cause', () => {
    const cause = new Error('tenant lookup failed');
    const err = new ComputePlacementConfigError('config issue', { cause });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.name).toBe('ComputePlacementConfigError');
    expect(err).toBeInstanceOf(ComputePlacementError);
    expect(err.cause).toBe(cause);
  });
});

describe('toComputePlacementErrorEnvelope', () => {
  it('preserves err.code when err is a ComputePlacementError', () => {
    const err = new ComputePlacementValidationError('bad workload');
    const envelope = toComputePlacementErrorEnvelope(err, 'corr-123');
    expect(envelope.code).toBe('VALIDATION');
    expect(envelope.message).toBe('bad workload');
    expect(envelope.correlation_id).toBe('corr-123');
  });

  it("returns code='INTERNAL' for a generic Error; populates details when supplied", () => {
    const envelope = toComputePlacementErrorEnvelope(new Error('plain'), 'corr-456');
    expect(envelope.code).toBe('INTERNAL');
    expect(envelope.message).toBe('plain');
    expect(Object.hasOwn(envelope, 'details')).toBe(false);

    const withDetails = toComputePlacementErrorEnvelope(
      new ComputePlacementValidationError('over'),
      'corr-789',
      { workload: 'foo', env: 'dev' },
    );
    expect(withDetails.details).toEqual({ workload: 'foo', env: 'dev' });
  });
});
