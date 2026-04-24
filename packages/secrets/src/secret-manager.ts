import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { z } from 'zod';
import { auditLog } from './audit.js';
import { getProjectId } from './config.js';
import {
  SecretsError,
  SecretsValidationError,
  SecretNotFoundError,
  PermissionDeniedError,
  KmsUnavailableError,
} from './errors.js';

const SECRET_ID_REGEX =
  /^cortex-(auth|ai|email|db|webhook|integration|tenant-[a-z0-9-]+|app)-[a-z0-9-]+$/;

const secretIdSchema = z
  .string()
  .regex(SECRET_ID_REGEX, 'secret_id must match cortex-<category>-<name> pattern');
const tenantIdSchema = z.string().uuid().optional();

export interface GetOptions {
  tenantId?: string;
}

export interface PutResult {
  name: string;
  versionId: string;
}

type SecretClient = Pick<SecretManagerServiceClient, 'accessSecretVersion' | 'addSecretVersion'>;
type SecretClientFactory = () => SecretClient;

let clientFactory: SecretClientFactory = () => new SecretManagerServiceClient() as SecretClient;
let clientSingleton: SecretClient | undefined;

function getClient(): SecretClient {
  clientSingleton ??= clientFactory();
  return clientSingleton;
}

/** Test-only: override the client factory. Resets the memoized singleton. */
export function __setClientFactoryForTesting(factory: SecretClientFactory | null): void {
  if (factory === null) {
    clientFactory = () => new SecretManagerServiceClient() as SecretClient;
  } else {
    clientFactory = factory;
  }
  clientSingleton = undefined;
}

function mapGcpError(err: unknown): SecretsError {
  const e = err as { code?: number | string; message?: string } | undefined;
  const code = e?.code;
  const message = e?.message ?? 'GCP Secret Manager error';
  if (code === 5 || code === 'NOT_FOUND' || code === 404) {
    return new SecretNotFoundError(message, { cause: err as Error });
  }
  if (code === 7 || code === 'PERMISSION_DENIED' || code === 403) {
    return new PermissionDeniedError(message, { cause: err as Error });
  }
  return new KmsUnavailableError(message, { cause: err as Error });
}

/**
 * Fetch the latest version of a secret by full name.
 *
 * @param secretId Full name matching `cortex-<category>-<specific-name>`.
 *                 Regex-validated; identical to `infra/terraform/modules/secret/`.
 * @param options.tenantId Optional UUID for audit context. Does NOT scope access.
 * @returns UTF-8 decoded payload. Binary payloads are not supported in Phase 1;
 *          `getBytes` is deferred until a binary consumer appears.
 * @throws SecretsValidationError invalid secretId or tenantId
 * @throws SecretNotFoundError    secret does not exist in project
 * @throws PermissionDeniedError  caller SA lacks secretmanager.secretAccessor
 * @throws KmsUnavailableError    transient / other GCP failure
 */
async function get(secretId: string, options: GetOptions = {}): Promise<string> {
  const start = Date.now();

  const secretParsed = secretIdSchema.safeParse(secretId);
  const tenantParsed = tenantIdSchema.safeParse(options.tenantId);

  if (!secretParsed.success || !tenantParsed.success) {
    auditLog({
      operation: 'get',
      tenant_id: null,
      secret_id: null,
      key_id: null,
      outcome: 'error',
      error_code: 'VALIDATION',
      duration_ms: Date.now() - start,
    });
    const msg = !secretParsed.success
      ? `invalid secretId: ${secretParsed.error.message}`
      : `invalid tenantId: ${tenantParsed.error?.message ?? 'not a UUID'}`;
    throw new SecretsValidationError(msg);
  }

  const projectId = getProjectId();
  const name = `projects/${projectId}/secrets/${secretParsed.data}/versions/latest`;

  try {
    const [response] = await getClient().accessSecretVersion({ name });
    const payload = response.payload?.data;
    if (payload === null || payload === undefined) {
      throw new SecretNotFoundError(`secret version returned empty payload: ${name}`);
    }
    const value = Buffer.from(payload).toString('utf8');
    auditLog({
      operation: 'get',
      tenant_id: tenantParsed.data ?? null,
      secret_id: secretParsed.data,
      key_id: null,
      outcome: 'ok',
      error_code: null,
      duration_ms: Date.now() - start,
    });
    return value;
  } catch (err) {
    const mapped = err instanceof SecretsError ? err : mapGcpError(err);
    auditLog({
      operation: 'get',
      tenant_id: tenantParsed.data ?? null,
      secret_id: secretParsed.data,
      key_id: null,
      outcome: 'error',
      error_code: mapped.code,
      duration_ms: Date.now() - start,
    });
    throw mapped;
  }
}

/**
 * Add a new version to an existing secret. Secret metadata is Terraform-owned
 * (see `infra/terraform/modules/secret/`); this function only creates versions.
 *
 * @param secretId Full secret name
 * @param payload  UTF-8 string payload
 * @param options.tenantId Optional UUID for audit context
 * @returns fully-qualified version name + versionId (just the number)
 * @throws SecretsValidationError invalid input
 * @throws SecretNotFoundError    secret metadata missing (Terraform must create first)
 * @throws PermissionDeniedError  caller SA lacks secretmanager.secretVersionAdder
 * @throws KmsUnavailableError    transient / other GCP failure
 */
async function put(
  secretId: string,
  payload: string,
  options: GetOptions = {},
): Promise<PutResult> {
  const start = Date.now();

  const secretParsed = secretIdSchema.safeParse(secretId);
  const tenantParsed = tenantIdSchema.safeParse(options.tenantId);

  if (!secretParsed.success || !tenantParsed.success) {
    auditLog({
      operation: 'put',
      tenant_id: null,
      secret_id: null,
      key_id: null,
      outcome: 'error',
      error_code: 'VALIDATION',
      duration_ms: Date.now() - start,
    });
    const msg = !secretParsed.success
      ? `invalid secretId: ${secretParsed.error.message}`
      : `invalid tenantId: ${tenantParsed.error?.message ?? 'not a UUID'}`;
    throw new SecretsValidationError(msg);
  }

  const projectId = getProjectId();
  const parent = `projects/${projectId}/secrets/${secretParsed.data}`;

  try {
    const [response] = await getClient().addSecretVersion({
      parent,
      payload: { data: Buffer.from(payload, 'utf8') },
    });
    const fullName = response.name ?? '';
    const versionId = fullName.split('/').pop() ?? '';
    auditLog({
      operation: 'put',
      tenant_id: tenantParsed.data ?? null,
      secret_id: secretParsed.data,
      key_id: null,
      outcome: 'ok',
      error_code: null,
      duration_ms: Date.now() - start,
    });
    return { name: fullName, versionId };
  } catch (err) {
    const mapped = err instanceof SecretsError ? err : mapGcpError(err);
    auditLog({
      operation: 'put',
      tenant_id: tenantParsed.data ?? null,
      secret_id: secretParsed.data,
      key_id: null,
      outcome: 'error',
      error_code: mapped.code,
      duration_ms: Date.now() - start,
    });
    throw mapped;
  }
}

export const secrets = { get, put };
