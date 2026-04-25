import { describe, expect, it } from 'vitest';
import {
  generateCorrelationId,
  getCorrelationId,
  withCorrelationContext,
} from '../src/correlation-context.js';
import { ObservabilityValidationError } from '../src/errors.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('getCorrelationId', () => {
  it('returns undefined outside any correlation context', () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it('returns the bound id inside withCorrelationContext', async () => {
    const id = 'corr-bound-test';
    await withCorrelationContext(id, () => {
      expect(getCorrelationId()).toBe(id);
    });
  });
});

describe('withCorrelationContext — validation', () => {
  it('throws ObservabilityValidationError on empty string', () => {
    expect(() => withCorrelationContext('', () => undefined)).toThrow(ObservabilityValidationError);
    try {
      void withCorrelationContext('', () => undefined);
    } catch (err) {
      expect(err).toBeInstanceOf(ObservabilityValidationError);
      expect((err as ObservabilityValidationError).code).toBe('VALIDATION');
      expect((err as Error).message).toMatch(/non-empty/);
    }
  });

  it('throws ObservabilityValidationError on string exceeding 256 chars', () => {
    const tooLong = 'x'.repeat(257);
    expect(() => withCorrelationContext(tooLong, () => undefined)).toThrow(
      ObservabilityValidationError,
    );
    try {
      void withCorrelationContext(tooLong, () => undefined);
    } catch (err) {
      expect(err).toBeInstanceOf(ObservabilityValidationError);
      expect((err as ObservabilityValidationError).code).toBe('VALIDATION');
      expect((err as Error).message).toMatch(/256/);
    }
  });

  it('uses manual length checks; thrown errors carry no cause (validation is not zod-routed)', () => {
    try {
      void withCorrelationContext('', () => undefined);
    } catch (err) {
      expect((err as Error).cause).toBeUndefined();
    }
    try {
      void withCorrelationContext('y'.repeat(257), () => undefined);
    } catch (err) {
      expect((err as Error).cause).toBeUndefined();
    }
  });
});

describe('generateCorrelationId', () => {
  it('returns a valid UUIDv4 string', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(UUID_V4_REGEX);
  });

  it('returns different ids on consecutive calls', () => {
    const a = generateCorrelationId();
    const b = generateCorrelationId();
    expect(a).not.toBe(b);
  });
});

describe('AsyncLocalStorage isolation', () => {
  it('concurrent contexts each see their own bound id across awaited boundaries', async () => {
    const idA = `corr-a-${String(Math.random())}`;
    const idB = `corr-b-${String(Math.random())}`;

    const [resultA, resultB] = await Promise.all([
      withCorrelationContext(idA, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getCorrelationId();
      }),
      withCorrelationContext(idB, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getCorrelationId();
      }),
    ]);

    expect(resultA).toBe(idA);
    expect(resultB).toBe(idB);
  });
});
