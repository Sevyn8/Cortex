import { describe, it, expect } from 'vitest';
import { moduleId } from '../src/types.js';
import { ObservabilityValidationError } from '../src/errors.js';

describe('moduleId — valid inputs', () => {
  it('accepts canonical slugs and boundary lengths', () => {
    expect(moduleId('cortex-foundation')).toBe('cortex-foundation');
    expect(moduleId('a-b')).toBe('a-b');
    expect(moduleId('cortex')).toBe('cortex');
    const max = 'a'.repeat(64);
    expect(moduleId(max)).toBe(max);
  });
});

describe('moduleId — invalid format', () => {
  it('rejects underscores', () => {
    expect(() => moduleId('cortex_foundation')).toThrow(ObservabilityValidationError);
    try {
      moduleId('cortex_foundation');
    } catch (err) {
      expect(err).toBeInstanceOf(ObservabilityValidationError);
      expect((err as ObservabilityValidationError).code).toBe('VALIDATION');
      expect((err as Error).message).toMatch(/lowercase slug/);
    }
  });

  it('rejects all-uppercase', () => {
    expect(() => moduleId('CORTEX-FOUNDATION')).toThrow(ObservabilityValidationError);
    try {
      moduleId('CORTEX-FOUNDATION');
    } catch (err) {
      expect((err as Error).message).toMatch(/lowercase slug/);
    }
  });

  it('rejects mixed case', () => {
    expect(() => moduleId('Cortex-Foundation')).toThrow(ObservabilityValidationError);
    try {
      moduleId('Cortex-Foundation');
    } catch (err) {
      expect((err as Error).message).toMatch(/lowercase slug/);
    }
  });

  it('rejects whitespace', () => {
    expect(() => moduleId('cortex foundation')).toThrow(ObservabilityValidationError);
    try {
      moduleId('cortex foundation');
    } catch (err) {
      expect((err as Error).message).toMatch(/lowercase slug/);
    }
  });
});

describe('moduleId — invalid length', () => {
  it('rejects below the 2-char minimum', () => {
    expect(() => moduleId('a')).toThrow(ObservabilityValidationError);
    try {
      moduleId('a');
    } catch (err) {
      expect(err).toBeInstanceOf(ObservabilityValidationError);
      expect((err as ObservabilityValidationError).code).toBe('VALIDATION');
      expect((err as Error).message).toMatch(/characters/);
      expect((err as Error).message).toMatch(/length/);
    }
  });

  it('rejects above the 64-char maximum', () => {
    const tooLong = 'a'.repeat(65);
    expect(() => moduleId(tooLong)).toThrow(ObservabilityValidationError);
    try {
      moduleId(tooLong);
    } catch (err) {
      expect((err as Error).message).toMatch(/characters/);
      expect((err as Error).message).toMatch(/length/);
    }
  });
});

describe('moduleId — invalid boundary characters', () => {
  it('rejects leading hyphen', () => {
    expect(() => moduleId('-cortex')).toThrow(ObservabilityValidationError);
    try {
      moduleId('-cortex');
    } catch (err) {
      expect((err as Error).message).toMatch(/lowercase slug/);
    }
  });

  it('rejects trailing hyphen', () => {
    expect(() => moduleId('cortex-')).toThrow(ObservabilityValidationError);
    try {
      moduleId('cortex-');
    } catch (err) {
      expect((err as Error).message).toMatch(/lowercase slug/);
    }
  });
});
