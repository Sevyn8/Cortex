import { describe, it, expect } from 'vitest';
import {
  buildRedactionConfig,
  DEFAULT_REDACTION_PATHS,
  REDACTION_CENSOR,
} from '../src/redaction.js';
import { createLogger } from '../src/logger.js';
import { createLogCapture } from '../src/test-utils.js';

describe('DEFAULT_REDACTION_PATHS contents', () => {
  it('covers all four canonical categories with representative paths', () => {
    expect(DEFAULT_REDACTION_PATHS).toContain('*.password');
    expect(DEFAULT_REDACTION_PATHS).toContain('*.email');
    expect(DEFAULT_REDACTION_PATHS).toContain('*.credit_card');
    expect(DEFAULT_REDACTION_PATHS).toContain('req.headers.authorization');
    expect(DEFAULT_REDACTION_PATHS).toContain('*.aadhaar');
    expect(DEFAULT_REDACTION_PATHS).toContain('*.pan');
    expect(DEFAULT_REDACTION_PATHS.length).toBe(33);
  });
});

describe('buildRedactionConfig', () => {
  it('returns { paths, censor: "[REDACTED]" } with no args', () => {
    const config = buildRedactionConfig();
    expect(config.censor).toBe(REDACTION_CENSOR);
    expect(config.censor).toBe('[REDACTED]');
    expect(Array.isArray(config.paths)).toBe(true);
  });

  it('returns paths matching DEFAULT_REDACTION_PATHS when no extras supplied', () => {
    const config = buildRedactionConfig();
    expect(config.paths).toEqual([...DEFAULT_REDACTION_PATHS]);
  });

  it('concatenates extras with the canonical defaults', () => {
    const extras = ['*.custom_secret', '*.session'];
    const config = buildRedactionConfig(extras);
    expect(config.paths.length).toBe(DEFAULT_REDACTION_PATHS.length + extras.length);
    expect(config.paths).toContain('*.custom_secret');
    expect(config.paths).toContain('*.session');
    expect(config.paths.slice(0, DEFAULT_REDACTION_PATHS.length)).toEqual([
      ...DEFAULT_REDACTION_PATHS,
    ]);
  });
});

describe('pino redaction integration', () => {
  it('redacts a one-level-nested credential field via *.password and preserves the message', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-test', destination: capture });
    logger.info({ user: { password: 'secret123' } }, 'login attempt');
    await capture.flush();

    expect(capture.logs.length).toBe(1);
    const entry = capture.logs[0];
    expect(entry).toBeDefined();
    expect((entry?.user as Record<string, unknown>).password).toBe('[REDACTED]');
    expect(entry?.message).toBe('login attempt');
  });

  it('redacts personal-identifier fields via *.email wildcard', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-test', destination: capture });
    logger.info({ user: { email: 'a@b.com' } }, 'msg');
    await capture.flush();

    const entry = capture.logs[0];
    expect((entry?.user as Record<string, unknown>).email).toBe('[REDACTED]');
  });

  it('redacts request authorization header via the explicit req.headers.authorization path', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-test', destination: capture });
    logger.info({ req: { headers: { authorization: 'Bearer xyz' } } }, 'req');
    await capture.flush();

    const entry = capture.logs[0];
    const headers = (entry?.req as Record<string, unknown>).headers as Record<string, unknown>;
    expect(headers.authorization).toBe('[REDACTED]');
  });

  it('redacts Indian PII fields aadhaar and pan via wildcards', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ moduleId: 'cortex-test', destination: capture });
    logger.info({ user: { aadhaar: '123456789012', pan: 'ABCDE1234F' } }, 'kyc');
    await capture.flush();

    const user = capture.logs[0]?.user as Record<string, unknown>;
    expect(user.aadhaar).toBe('[REDACTED]');
    expect(user.pan).toBe('[REDACTED]');
  });

  it('honors extraRedactionPaths supplied at logger construction', async () => {
    const capture = createLogCapture();
    const logger = createLogger({
      moduleId: 'cortex-test',
      destination: capture,
      extraRedactionPaths: ['*.custom_secret'],
    });
    logger.info({ user: { custom_secret: 'should-be-hidden' } }, 'msg');
    await capture.flush();

    const user = capture.logs[0]?.user as Record<string, unknown>;
    expect(user.custom_secret).toBe('[REDACTED]');
  });
});
