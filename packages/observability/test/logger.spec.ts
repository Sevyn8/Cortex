import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import type { ContextProvider } from '../src/context-provider.js';
import { ObservabilityConfigError, ObservabilityValidationError } from '../src/errors.js';
import { withCorrelationContext } from '../src/correlation-context.js';
import { createLogCapture } from '../src/test-utils.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CORRELATION_ID = 'corr-fixed-test-value';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createLogger — basic', () => {
  it('returns a Logger with the expected pino-shaped methods', () => {
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-test', destination: capture });
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  it('throws ObservabilityConfigError with ObservabilityValidationError as cause when moduleId is invalid', () => {
    expect(() => createLogger({ moduleId: 'INVALID_ID' })).toThrow(ObservabilityConfigError);
    try {
      createLogger({ moduleId: 'INVALID_ID' });
    } catch (err) {
      expect(err).toBeInstanceOf(ObservabilityConfigError);
      expect((err as ObservabilityConfigError).code).toBe('CONFIG_INVALID');
      expect((err as ObservabilityConfigError).cause).toBeInstanceOf(ObservabilityValidationError);
    }
  });

  it("defaults level to 'info' when NODE_ENV='production', 'debug' otherwise", () => {
    const capture = createLogCapture();

    vi.stubEnv('NODE_ENV', 'production');
    const prodLogger = createLogger({ moduleId: 'cortex-test', destination: capture });
    expect(prodLogger.level).toBe('info');

    vi.stubEnv('NODE_ENV', 'development');
    const devLogger = createLogger({ moduleId: 'cortex-test', destination: capture });
    expect(devLogger.level).toBe('debug');
  });
});

describe('createLogger — Cloud Logging output format', () => {
  it('emits JSON with severity (uppercase), timestamp (ISO Z), message, module_id; no pid or hostname', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-test', destination: capture, level: 'debug' });
    logger.info('hello');
    await capture.flush();

    const entry = capture.logs[0];
    expect(entry?.severity).toBe('INFO');
    expect(entry?.module_id).toBe('cortex-test');
    expect(entry?.message).toBe('hello');
    expect(typeof entry?.timestamp).toBe('string');
    expect(entry?.timestamp as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect('pid' in (entry ?? {})).toBe(false);
    expect('hostname' in (entry ?? {})).toBe(false);
    expect('msg' in (entry ?? {})).toBe(false);
  });

  it('maps pino levels to Cloud Logging severities (DEBUG / INFO / WARNING / ERROR)', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-test', destination: capture, level: 'debug' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    await capture.flush();

    expect(capture.logs[0]?.severity).toBe('DEBUG');
    expect(capture.logs[1]?.severity).toBe('INFO');
    expect(capture.logs[2]?.severity).toBe('WARNING');
    expect(capture.logs[3]?.severity).toBe('ERROR');
  });
});

describe('createLogger — ContextProvider integration', () => {
  it('injects all five context fields from a custom provider into every log line', async () => {
    const capture = createLogCapture();
    const provider: ContextProvider = {
      getTenantId: () => TENANT_ID,
      getUserId: () => 'user-42',
      getCorrelationId: () => CORRELATION_ID,
      getTraceId: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      getSpanId: () => 'bbbbbbbbbbbbbbbb',
    };
    const logger = createLogger({
      moduleId: 'cortex-test',
      destination: capture,
      contextProvider: provider,
    });
    logger.info('with-context');
    await capture.flush();

    const entry = capture.logs[0];
    expect(entry?.tenant_id).toBe(TENANT_ID);
    expect(entry?.user_id).toBe('user-42');
    expect(entry?.correlation_id).toBe(CORRELATION_ID);
    expect(entry?.trace_id).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(entry?.span_id).toBe('bbbbbbbbbbbbbbbb');
  });

  it('defaultContextProvider picks up bound correlation_id from its async-local store; tenant_id is absent (per §4.13)', async () => {
    // Per roadmap §4.13 (resolved): observability's default provider does
    // NOT auto-resolve tenant_id — that responsibility moved to
    // `@cortex/tenant-context`'s `tenantContextProvider`. The
    // tenant_id-via-async-local integration test lives at
    // `packages/tenant-context/test/compose-with-observability.spec.ts`.
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-test', destination: capture });
    await withCorrelationContext(CORRELATION_ID, () => {
      logger.info('in-context');
    });
    await capture.flush();

    const entry = capture.logs[0];
    expect(entry?.correlation_id).toBe(CORRELATION_ID);
    expect(entry?.tenant_id).toBeUndefined();
  });
});

describe('createLogger — redaction', () => {
  it('applies the canonical redaction config to logged structured fields', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-test', destination: capture });
    logger.info({ user: { password: 'plaintext' } }, 'login');
    await capture.flush();

    const user = capture.logs[0]?.user as Record<string, unknown>;
    expect(user.password).toBe('[REDACTED]');
  });

  it('honors extraRedactionPaths supplied at construction', async () => {
    const capture = createLogCapture();
    const logger = createLogger({
      moduleId: 'cortex-test',
      destination: capture,
      extraRedactionPaths: ['*.custom_secret'],
    });
    logger.info({ user: { custom_secret: 'hide-me' } }, 'msg');
    await capture.flush();

    const user = capture.logs[0]?.user as Record<string, unknown>;
    expect(user.custom_secret).toBe('[REDACTED]');
  });
});

describe('createLogger — level option', () => {
  it("level: 'warn' suppresses info-level emissions and admits warn", async () => {
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-test', destination: capture, level: 'warn' });
    logger.info('not-emitted');
    logger.warn('emitted');
    await capture.flush();

    expect(capture.logs.length).toBe(1);
    expect(capture.logs[0]?.severity).toBe('WARNING');
    expect(capture.logs[0]?.message).toBe('emitted');
  });
});

describe('createLogger — destination', () => {
  it('writes to a caller-supplied destination and accepts construction with no destination', async () => {
    const capture = createLogCapture();
    const customDestLogger = createLogger({
      moduleId: 'cortex-test',
      destination: capture,
    });
    customDestLogger.info('to-capture');
    await capture.flush();
    expect(capture.logs.length).toBe(1);
    expect(capture.logs[0]?.message).toBe('to-capture');

    expect(() => createLogger({ moduleId: 'cortex-test' })).not.toThrow();
  });
});
