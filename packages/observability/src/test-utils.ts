/**
 * Test-only helper: a Writable stream that captures pino's JSON output
 * as parsed records. Use as the `destination` option to `createLogger`,
 * then assert against `capture.logs` after operations complete.
 *
 * Pino calls `destination.write(line)` synchronously per emission. With
 * a Writable stream, the underlying `_write` callback fires on the same
 * tick when there's no backpressure (the case for small test writes).
 * If a test ever needs guaranteed flush — multiple log lines in tight
 * sequence under load — call `await capture.flush()` before asserting.
 *
 * Non-JSON lines (pino-pretty output, accidental writes) are skipped
 * silently so the capture stays clean.
 */

import { Writable } from 'node:stream';

export type CapturedLog = Record<string, unknown>;

export class LogCapture extends Writable {
  public readonly logs: CapturedLog[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        this.logs.push(JSON.parse(line) as CapturedLog);
      } catch {
        // Non-JSON line — ignore.
      }
    }
    callback();
  }

  /**
   * Wait for any queued chunks to drain through `_write`. Resolves on
   * the next macrotask, after pino's writes have propagated.
   */
  async flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  reset(): void {
    this.logs.length = 0;
  }
}

export function createLogCapture(): LogCapture {
  return new LogCapture();
}
