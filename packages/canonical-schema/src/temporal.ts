import { z } from 'zod';

export interface TstzRange {
  readonly lower: Date;
  readonly upper: Date | null;
  readonly lowerInclusive: boolean; // always true for our convention
  readonly upperInclusive: boolean; // always false for our convention
}

export type BiTemporalRow<T> = T & {
  readonly valid_time: TstzRange;
  readonly txn_time: TstzRange;
};

const WIRE_RE = /^([[(])(.*?),(.*?)([\])])$/;

/**
 * Parse a Postgres tstzrange wire value, e.g. `["2026-04-22 10:00:00+00",)`.
 * Throws on malformed input.
 */
export function parseTstzRange(wire: string): TstzRange {
  const match = WIRE_RE.exec(wire.trim());
  if (match === null) {
    throw new Error(`Malformed tstzrange literal: ${wire}`);
  }
  const [, lBracket, rawLower, rawUpper, rBracket] = match;
  const lower = parseEndpoint(rawLower);
  if (lower === null) {
    throw new Error(`tstzrange lower bound must be non-null: ${wire}`);
  }
  return {
    lower,
    upper: parseEndpoint(rawUpper),
    lowerInclusive: lBracket === '[',
    upperInclusive: rBracket === ']',
  };
}

function parseEndpoint(raw: string | undefined): Date | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/^"|"$/g, '');
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`tstzrange endpoint is not a valid timestamp: ${raw}`);
  }
  return d;
}

/**
 * Serialize a TstzRange to a Postgres tstzrange literal.
 * Convention: lower is always `[` (inclusive), upper is always `)` (exclusive).
 * Upper-null serializes to empty upper bound.
 */
export function serializeTstzRange(range: TstzRange): string {
  const lo = range.lower.toISOString();
  const hi = range.upper === null ? '' : range.upper.toISOString();
  const l = range.lowerInclusive ? '[' : '(';
  const r = range.upperInclusive ? ']' : ')';
  return `${l}"${lo}","${hi}"${r}`;
}

export const TstzRangeSchema: z.ZodType<TstzRange> = z.object({
  lower: z.instanceof(Date),
  upper: z.instanceof(Date).nullable(),
  lowerInclusive: z.boolean(),
  upperInclusive: z.boolean(),
});
