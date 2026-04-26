import { describe, expect, it } from 'vitest';
import {
  SOFT_PAYLOAD_LIMIT_BYTES,
  canonicalizeJsonValue,
  checkPayloadSize,
  isoMicrosecondString,
  type JsonObject,
  type JsonValue,
} from '../src/index.js';

// Decomposed 'café' = 'c' + 'a' + 'f' + 'e' + combining-acute (5 code units, NFD).
// Composed   'café' = 'c' + 'a' + 'f' + 'é' (4 code units, NFC).
//
// Use explicit ́ / é escapes so the source file's byte
// representation is unambiguous regardless of editor / formatter NFC
// normalization. Bare 'café' literals in source can be silently
// composed by tooling, defeating the test.
const DECOMPOSED = 'cafe\u0301';
const COMPOSED = 'caf\u00e9';

// ─────────────────────────────────────────────────────────────────────
// canonicalizeJsonValue
// ─────────────────────────────────────────────────────────────────────

describe('canonicalizeJsonValue', () => {
  it('normalizes a top-level string from NFD to NFC', () => {
    expect(DECOMPOSED.length).toBe(5);
    expect(COMPOSED.length).toBe(4);
    const out = canonicalizeJsonValue(DECOMPOSED);
    expect(out).toBe(COMPOSED);
  });

  it('normalizes strings in nested objects (recursive at depth)', () => {
    const input: JsonValue = {
      level1: {
        level2: {
          tagline: DECOMPOSED,
          deeper: { name: DECOMPOSED },
        },
      },
    };
    const out = canonicalizeJsonValue(input) as JsonObject;
    const l1 = out.level1 as JsonObject;
    const l2 = l1.level2 as JsonObject;
    expect(l2.tagline).toBe(COMPOSED);
    const deeper = l2.deeper as JsonObject;
    expect(deeper.name).toBe(COMPOSED);
  });

  it('normalizes string elements inside arrays', () => {
    const input: JsonValue = [DECOMPOSED, 'plain', { key: DECOMPOSED }];
    const out = canonicalizeJsonValue(input) as JsonValue[];
    expect(out[0]).toBe(COMPOSED);
    expect(out[1]).toBe('plain');
    expect((out[2] as JsonObject).key).toBe(COMPOSED);
  });

  it('normalizes object keys with combining-acute', () => {
    const input: JsonValue = { [DECOMPOSED]: 'value' };
    const out = canonicalizeJsonValue(input) as JsonObject;
    expect(Object.keys(out)).toEqual([COMPOSED]);
    expect(out[COMPOSED]).toBe('value');
  });

  it('is idempotent — applying twice produces the same result as applying once', () => {
    const input: JsonValue = {
      [DECOMPOSED]: DECOMPOSED,
      nested: {
        list: [DECOMPOSED, { [DECOMPOSED]: DECOMPOSED }],
      },
    };
    const once = canonicalizeJsonValue(input);
    const twice = canonicalizeJsonValue(once);
    expect(twice).toEqual(once);
  });
});

// ─────────────────────────────────────────────────────────────────────
// checkPayloadSize
// ─────────────────────────────────────────────────────────────────────

describe('checkPayloadSize', () => {
  it('reports below-threshold sizes accurately and flags exceedsSoftLimit=false', () => {
    const payload: JsonObject = { foo: 'bar', n: 42 };
    const expected = JSON.stringify(payload).length;
    const report = checkPayloadSize(payload);
    expect(report.sizeBytes).toBe(expected);
    expect(report.exceedsSoftLimit).toBe(false);
    expect(report.sizeBytes).toBeLessThan(SOFT_PAYLOAD_LIMIT_BYTES);
  });

  it('flags exceedsSoftLimit=true for payloads above 64 KB', () => {
    const payload: JsonObject = { large: 'x'.repeat(70_000) };
    const expected = JSON.stringify(payload).length;
    const report = checkPayloadSize(payload);
    expect(report.sizeBytes).toBe(expected);
    expect(report.sizeBytes).toBeGreaterThan(SOFT_PAYLOAD_LIMIT_BYTES);
    expect(report.exceedsSoftLimit).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// isoMicrosecondString
// ─────────────────────────────────────────────────────────────────────

describe('isoMicrosecondString', () => {
  it('returns a microsecond-precision ISO-8601 UTC string unchanged', () => {
    const v = '2026-04-26T12:34:56.123456Z';
    expect(isoMicrosecondString(v)).toBe(v);
  });

  it('returns a second-precision ISO-8601 UTC string (microseconds optional)', () => {
    const v = '2026-04-26T12:34:56Z';
    expect(isoMicrosecondString(v)).toBe(v);
  });

  it('returns null for non-conforming inputs', () => {
    const invalid: unknown[] = [
      '2026-04-26T12:34:56', // missing trailing Z
      '2026/04/26 12:34:56', // slashes + space
      '2026-04-26T12:34:56.123Z', // millisecond precision (3 digits, not 6)
      '2026-04-26T12:34:56+05:30', // explicit offset, not Z
      'not-a-date',
      '',
      new Date(),
      42,
      undefined,
      null,
    ];
    for (const v of invalid) {
      expect(isoMicrosecondString(v)).toBeNull();
    }
  });
});
