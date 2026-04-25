import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import {
  getTenantId,
  getTenantOrThrow,
  withTenantContext,
  withoutTenantContext,
} from '../src/context.js';
import { TenantContextMissingError, TenantValidationError } from '../src/errors.js';
import { ZodError } from 'zod';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

describe('getTenantId', () => {
  it('returns undefined outside any context', () => {
    expect(getTenantId()).toBeUndefined();
  });

  it('returns the bound tenantId inside withTenantContext', async () => {
    await withTenantContext(ID_A, () => {
      expect(getTenantId()).toBe(ID_A);
    });
  });
});

describe('getTenantOrThrow', () => {
  it('throws TenantContextMissingError outside any context', () => {
    expect(() => getTenantOrThrow()).toThrowError(TenantContextMissingError);
  });

  it('returns the bound tenantId inside withTenantContext', async () => {
    await withTenantContext(ID_A, () => {
      expect(getTenantOrThrow()).toBe(ID_A);
    });
  });
});

describe('withTenantContext input validation', () => {
  it('rejects non-UUID tenantId with TenantValidationError + ZodError cause', () => {
    let captured: unknown;
    try {
      void withTenantContext('not-a-uuid', () => 0);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(TenantValidationError);
    expect((captured as TenantValidationError).cause).toBeInstanceOf(ZodError);
  });

  it('rejects empty-string tenantId', () => {
    expect(() => withTenantContext('', () => 0)).toThrowError(TenantValidationError);
  });
});

describe('withoutTenantContext', () => {
  it('yields undefined for getTenantId inside its callback', async () => {
    await withTenantContext(ID_A, async () => {
      expect(getTenantId()).toBe(ID_A);
      await withoutTenantContext(() => {
        expect(getTenantId()).toBeUndefined();
      });
      expect(getTenantId()).toBe(ID_A);
    });
  });
});

describe('nested withTenantContext', () => {
  it('inner overrides outer; outer restored after inner returns', async () => {
    const observations: { where: string; id: string | undefined }[] = [];

    await withTenantContext(ID_A, async () => {
      observations.push({ where: 'outer-before-inner', id: getTenantId() });

      await withTenantContext(ID_B, () => {
        observations.push({ where: 'inner', id: getTenantId() });
      });

      observations.push({ where: 'outer-after-inner', id: getTenantId() });
    });

    expect(observations).toEqual([
      { where: 'outer-before-inner', id: ID_A },
      { where: 'inner', id: ID_B },
      { where: 'outer-after-inner', id: ID_A },
    ]);
  });
});

describe('AsyncLocalStorage isolation', () => {
  it('two concurrent contexts see independent tenantIds', async () => {
    const observe = (id: string, delayMs: number) =>
      withTenantContext(id, async () => {
        await sleep(delayMs);
        return getTenantId();
      });

    const [seenA, seenB] = await Promise.all([observe(ID_A, 10), observe(ID_B, 5)]);

    expect(seenA).toBe(ID_A);
    expect(seenB).toBe(ID_B);
  });

  it('Promise.race with nested contexts: no cross-leakage between racing chains', async () => {
    const fast = withTenantContext(ID_A, async () => {
      await sleep(2);
      return getTenantId();
    });
    const slow = withTenantContext(ID_B, async () => {
      await sleep(20);
      return getTenantId();
    });
    const winner = await Promise.race([fast, slow]);
    expect(winner).toBe(ID_A);

    // The slow chain still resolves with its own id, even though the race
    // returned the other; no leakage.
    const slowResult = await slow;
    expect(slowResult).toBe(ID_B);

    // After both chains settle, no ambient context.
    expect(getTenantId()).toBeUndefined();

    // Use ID_C so test counts include all three IDs touched in the file
    // and to ensure context restoration after the race fully unwinds.
    await withTenantContext(ID_C, () => {
      expect(getTenantId()).toBe(ID_C);
    });
  });
});
