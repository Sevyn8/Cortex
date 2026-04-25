import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@cortex/observability';
import { createLogCapture, type LogCapture } from '@cortex/observability/test-utils';
import { __setClientFactoryForTesting, secrets } from '../src/secret-manager.js';
import { __resetForTesting, __setLoggerForTesting } from '../src/audit.js';
import {
  PermissionDeniedError,
  SecretNotFoundError,
  SecretsValidationError,
  KmsUnavailableError,
} from '../src/errors.js';

const VALID_SECRET = 'cortex-email-sendgrid-api-key';
const VALID_TENANT = '22222222-2222-2222-2222-222222222222';

let logCapture: LogCapture;

function gcpError(code: number | string, message: string): Error {
  const err = new Error(message) as Error & { code: number | string };
  err.code = code;
  return err;
}

describe('secrets.get', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['GCP_PROJECT_ID'];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.GCP_PROJECT_ID = 'sevyn8-cortex-dev';
    logCapture = createLogCapture();
    __setLoggerForTesting(createLogger({ moduleId: 'cortex-secrets', destination: logCapture }));
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __setClientFactoryForTesting(null);
    __resetForTesting();
    vi.restoreAllMocks();
  });

  it('happy path: returns decoded UTF-8 payload', async () => {
    const mockClient = {
      accessSecretVersion: vi
        .fn()
        .mockResolvedValue([{ payload: { data: Buffer.from('sk_test_hello', 'utf8') } }]),
      addSecretVersion: vi.fn(),
    };
    __setClientFactoryForTesting(() => mockClient);

    const value = await secrets.get(VALID_SECRET);
    expect(value).toBe('sk_test_hello');
    expect(mockClient.accessSecretVersion).toHaveBeenCalledWith({
      name: 'projects/sevyn8-cortex-dev/secrets/cortex-email-sendgrid-api-key/versions/latest',
    });
  });

  it('passes tenantId through for audit context', async () => {
    const mockClient = {
      accessSecretVersion: vi
        .fn()
        .mockResolvedValue([{ payload: { data: Buffer.from('v', 'utf8') } }]),
      addSecretVersion: vi.fn(),
    };
    __setClientFactoryForTesting(() => mockClient);

    await secrets.get(VALID_SECRET, { tenantId: VALID_TENANT });
    await logCapture.flush();
    expect(logCapture.logs[0]).toMatchObject({ tenant_id: VALID_TENANT });
  });

  it('maps GCP NOT_FOUND (code=5) to SecretNotFoundError', async () => {
    const mockClient = {
      accessSecretVersion: vi.fn().mockRejectedValue(gcpError(5, 'secret not found')),
      addSecretVersion: vi.fn(),
    };
    __setClientFactoryForTesting(() => mockClient);

    await expect(secrets.get(VALID_SECRET)).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('maps GCP PERMISSION_DENIED (code=7) to PermissionDeniedError', async () => {
    const mockClient = {
      accessSecretVersion: vi.fn().mockRejectedValue(gcpError(7, 'permission denied')),
      addSecretVersion: vi.fn(),
    };
    __setClientFactoryForTesting(() => mockClient);

    await expect(secrets.get(VALID_SECRET)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('maps unknown GCP codes to KmsUnavailableError', async () => {
    const mockClient = {
      accessSecretVersion: vi.fn().mockRejectedValue(gcpError(13, 'internal')),
      addSecretVersion: vi.fn(),
    };
    __setClientFactoryForTesting(() => mockClient);

    await expect(secrets.get(VALID_SECRET)).rejects.toBeInstanceOf(KmsUnavailableError);
  });

  it('rejects invalid secretId pattern', async () => {
    await expect(secrets.get('not-cortex-prefixed')).rejects.toBeInstanceOf(SecretsValidationError);
  });

  it('rejects invalid category in secretId', async () => {
    await expect(secrets.get('cortex-badcategory-x')).rejects.toBeInstanceOf(
      SecretsValidationError,
    );
  });

  it('rejects invalid tenantId (non-UUID)', async () => {
    await expect(secrets.get(VALID_SECRET, { tenantId: 'not-a-uuid' })).rejects.toBeInstanceOf(
      SecretsValidationError,
    );
  });

  it('throws SecretNotFoundError when payload is empty', async () => {
    const mockClient = {
      accessSecretVersion: vi.fn().mockResolvedValue([{ payload: {} }]),
      addSecretVersion: vi.fn(),
    };
    __setClientFactoryForTesting(() => mockClient);

    await expect(secrets.get(VALID_SECRET)).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('emits an audit on success', async () => {
    const mockClient = {
      accessSecretVersion: vi
        .fn()
        .mockResolvedValue([{ payload: { data: Buffer.from('v', 'utf8') } }]),
      addSecretVersion: vi.fn(),
    };
    __setClientFactoryForTesting(() => mockClient);

    await secrets.get(VALID_SECRET);
    await logCapture.flush();
    expect(logCapture.logs).toHaveLength(1);
    expect(logCapture.logs[0]).toMatchObject({
      namespace: 'secrets-audit',
      operation: 'get',
      outcome: 'ok',
      secret_id: VALID_SECRET,
    });
  });

  it('emits an audit on error with error_code', async () => {
    const mockClient = {
      accessSecretVersion: vi.fn().mockRejectedValue(gcpError(5, 'nf')),
      addSecretVersion: vi.fn(),
    };
    __setClientFactoryForTesting(() => mockClient);

    await expect(secrets.get(VALID_SECRET)).rejects.toBeDefined();
    await logCapture.flush();
    expect(logCapture.logs[0]).toMatchObject({
      outcome: 'error',
      error_code: 'NOT_FOUND',
    });
  });
});

describe('secrets.put', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['GCP_PROJECT_ID'];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.GCP_PROJECT_ID = 'sevyn8-cortex-dev';
    logCapture = createLogCapture();
    __setLoggerForTesting(createLogger({ moduleId: 'cortex-secrets', destination: logCapture }));
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __setClientFactoryForTesting(null);
    __resetForTesting();
    vi.restoreAllMocks();
  });

  it('happy path: returns version name + versionId', async () => {
    const mockClient = {
      accessSecretVersion: vi.fn(),
      addSecretVersion: vi.fn().mockResolvedValue([
        {
          name: 'projects/p/secrets/cortex-email-sendgrid-api-key/versions/3',
        },
      ]),
    };
    __setClientFactoryForTesting(() => mockClient);

    const result = await secrets.put(VALID_SECRET, 'new-value');
    expect(result.versionId).toBe('3');
    expect(result.name).toBe('projects/p/secrets/cortex-email-sendgrid-api-key/versions/3');
    expect(mockClient.addSecretVersion).toHaveBeenCalledWith({
      parent: 'projects/sevyn8-cortex-dev/secrets/cortex-email-sendgrid-api-key',
      payload: { data: Buffer.from('new-value', 'utf8') },
    });
  });

  it('maps GCP NOT_FOUND to SecretNotFoundError', async () => {
    const mockClient = {
      accessSecretVersion: vi.fn(),
      addSecretVersion: vi.fn().mockRejectedValue(gcpError(5, 'secret missing')),
    };
    __setClientFactoryForTesting(() => mockClient);

    await expect(secrets.put(VALID_SECRET, 'v')).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('maps GCP PERMISSION_DENIED to PermissionDeniedError', async () => {
    const mockClient = {
      accessSecretVersion: vi.fn(),
      addSecretVersion: vi.fn().mockRejectedValue(gcpError(7, 'denied')),
    };
    __setClientFactoryForTesting(() => mockClient);

    await expect(secrets.put(VALID_SECRET, 'v')).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('rejects invalid secretId', async () => {
    await expect(secrets.put('bad', 'v')).rejects.toBeInstanceOf(SecretsValidationError);
  });

  it('emits an audit on success', async () => {
    const mockClient = {
      accessSecretVersion: vi.fn(),
      addSecretVersion: vi.fn().mockResolvedValue([{ name: 'projects/p/secrets/s/versions/1' }]),
    };
    __setClientFactoryForTesting(() => mockClient);

    await secrets.put(VALID_SECRET, 'v');
    await logCapture.flush();
    expect(logCapture.logs[0]).toMatchObject({
      operation: 'put',
      outcome: 'ok',
    });
  });
});
