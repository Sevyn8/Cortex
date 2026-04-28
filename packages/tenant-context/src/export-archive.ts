/**
 * Tenant export archive generator for F02 Slice C `tenants.offboard`.
 *
 * Per planning-doc Q-NEW-C4 lock + audit sub-phase 7.1: gzipped JSON Lines,
 * one record per row, schema-versioned wrapper. Each line is
 * `{schema_version, entity_type, entity_id, data}` so a future schema bump
 * is additive and old archives remain readable.
 *
 * Six entity types:
 *   - `tenant`                — the tenant row (single record)
 *   - `tenant_config_version` — every config version
 *   - `tenant_kms_key`        — KMS-key resource-name binding (no key material)
 *   - `tenant_quota_usage`    — quota counters across windows
 *   - `legal_hold`            — active + released holds (full history)
 *   - `audit_event`           — full per-tenant audit chain
 *
 * Upload + signing path:
 *   - Bucket: `cortex-{env}-tenant-data` via `@cortex/blob-storage`
 *     `getTenantBucketName(env)`. Per-tenant prefix `tenants/{tenantId}/`
 *     enforced via `buildFullObjectPath`.
 *   - Object key: `exports/{ISO-8601-timestamp}.jsonl.gz` within the
 *     tenant prefix. Hyphenated timestamp is filesystem/URL-safe.
 *   - Storage upload: `@google-cloud/storage` Storage client directly
 *     (per `@cortex/blob-storage` documented convention — that package
 *     ships path validators + signer; emission paths are caller's).
 *   - Signing: `createSignedUrlSigner(env, { storage })` from
 *     `@cortex/blob-storage`. V4 signed URLs cap at 7 days
 *     server-side (GCS limit); convention §6.1's "30-day TTL" tracks
 *     OBJECT retention via lifecycle policy, not signed-URL TTL.
 *     Operators regenerate the signed URL via a future
 *     `tenants.regenerateOffboardingArchiveUrl(...)` near expiry.
 *
 * RLS contract:
 *   - Caller MUST bind `app.tenant_id` to the target tenant via
 *     `bindTenantToDbSession(tx, tenantId)` before calling. The
 *     audit_event / tenant_config_version / tenant_quota_usage /
 *     tenant_kms_key / legal_hold queries depend on the bind.
 *   - The `tenant` table has no RLS (control plane); the SELECT is
 *     unscoped but filtered by `id = $tenantId`.
 *
 * The function is intentionally NOT wrapped in `db.transaction` —
 * upload + sign are network calls. Caller controls the txn boundary;
 * the typical pattern is to read entities inside a short-lived txn,
 * then upload + sign post-commit (lock not held during network IO).
 * `tenants.offboard` does this composition.
 */

import { gzipSync } from 'node:zlib';
import { Storage } from '@google-cloud/storage';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  buildFullObjectPath,
  createSignedUrlSigner,
  getTenantBucketName,
  getTenantPrefix,
  type Environment,
  type SignedUrlSigner,
} from '@cortex/blob-storage';

/** Archive schema version. Bump (additively) for breaking shape changes. */
export const EXPORT_ARCHIVE_SCHEMA_VERSION = '1' as const;

/** Default signed-URL TTL (7 days — GCS V4 server-side max). */
const DEFAULT_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/** Entity types in archive iteration order. */
const ENTITY_TYPES = [
  'tenant',
  'tenant_config_version',
  'tenant_kms_key',
  'tenant_quota_usage',
  'legal_hold',
  'audit_event',
] as const;

export type ExportArchiveEntityType = (typeof ENTITY_TYPES)[number];

export interface ExportArchive {
  /** Bucket name (e.g., `cortex-dev-tenant-data`). */
  bucket: string;
  /** Full object path including tenant prefix (e.g., `tenants/{id}/exports/{ts}.jsonl.gz`). */
  fullObjectPath: string;
  /** GCS-prefixed path (e.g., `gs://cortex-dev-tenant-data/tenants/{id}/exports/{ts}.jsonl.gz`). */
  gcsUri: string;
  /** Pre-signed download URL (V4). */
  signedUrl: string;
  /** Wall-clock signed-URL expiry (caller's reference; GCS validates server-side). */
  signedUrlExpiresAt: Date;
  /** Gzipped archive size. */
  sizeBytes: number;
  /** ISO-8601 timestamp captured at archive-generation start. */
  generatedAt: Date;
  /** Schema version of the archive's record envelope. */
  schemaVersion: typeof EXPORT_ARCHIVE_SCHEMA_VERSION;
  /** Per-entity record counts. Matches the entity-type union. */
  entityCounts: Record<ExportArchiveEntityType, number>;
}

export interface GenerateExportArchiveOptions {
  /**
   * Override env resolution. Defaults to `process.env.CORTEX_ENV` then
   * `'dev'` (matches `@cortex/blob-storage`'s default-signer fallback).
   */
  env?: Environment;
  /**
   * Signed-URL TTL in seconds. Defaults to 7 days. GCS V4 caps at 7
   * days server-side; values above that are rejected by the signer.
   */
  expiresInSeconds?: number;
  /**
   * Override `Storage` client (for tests). Production callers omit so
   * the default ADC/WIF-backed client constructs lazily.
   */
  storage?: Storage;
  /**
   * Override `SignedUrlSigner` (for tests). Production callers omit;
   * the function constructs a default signer via
   * `createSignedUrlSigner(env, { storage })`.
   */
  signer?: SignedUrlSigner;
}

/**
 * Generate an export archive for a tenant.
 *
 * Reads all six entity tables under the caller's RLS bind, formats as
 * JSON Lines (one record per row), gzips, uploads to GCS at
 * `tenants/{tenantId}/exports/{timestamp}.jsonl.gz`, and returns a
 * V4-signed download URL.
 *
 * @throws BlobStorageValidationError if `tenantId` is not a UUID, or
 *   if the constructed path violates tenant-prefix invariants
 *   (defense-in-depth via `buildFullObjectPath`).
 * @throws Error from `@google-cloud/storage` on upload failure (network,
 *   IAM, bucket-not-found). Caller decides retry policy.
 */
export async function generateExportArchive(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  options: GenerateExportArchiveOptions = {},
): Promise<ExportArchive> {
  const env = options.env ?? (process.env.CORTEX_ENV as Environment | undefined) ?? 'dev';
  const expiresInSeconds = options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;

  // 0. Fail-fast tenantId validation. `getTenantPrefix` throws
  //    BlobStorageValidationError on non-UUID input — surfaces a clear
  //    error before any DB query runs (where Postgres would surface
  //    "invalid input syntax for type uuid" instead).
  getTenantPrefix(tenantId);

  // 1. Collect entities (RLS-bound via caller's session).
  const entities = await collectEntities(db, tenantId);

  // 2. Format as JSON Lines + gzip.
  const generatedAt = new Date();
  const lines: string[] = [];
  const entityCounts = {
    tenant: 0,
    tenant_config_version: 0,
    tenant_kms_key: 0,
    tenant_quota_usage: 0,
    legal_hold: 0,
    audit_event: 0,
  } as Record<ExportArchiveEntityType, number>;

  for (const entityType of ENTITY_TYPES) {
    const rows = entities[entityType];
    entityCounts[entityType] = rows.length;
    for (const row of rows) {
      lines.push(
        JSON.stringify({
          schema_version: EXPORT_ARCHIVE_SCHEMA_VERSION,
          entity_type: entityType,
          entity_id: extractEntityId(entityType, row),
          data: row,
        }),
      );
    }
  }

  // Trailing newline so consumers reading line-by-line don't drop the
  // final record. Standard JSONL convention.
  const jsonl = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  const gzipped = gzipSync(Buffer.from(jsonl, 'utf-8'));

  // 3. Build the object path (tenant-prefix-validated).
  // ISO timestamp with `:` and `.` replaced by `-` for path safety.
  const isoTimestamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  const objectName = `exports/${isoTimestamp}.jsonl.gz`;
  const fullObjectPath = buildFullObjectPath(tenantId, objectName);
  const bucket = getTenantBucketName(env);

  // 4. Upload to GCS.
  const storage = options.storage ?? new Storage();
  await storage
    .bucket(bucket)
    .file(fullObjectPath)
    .save(gzipped, {
      contentType: 'application/gzip',
      metadata: {
        contentEncoding: 'gzip',
        cacheControl: 'private, no-cache',
        metadata: {
          schemaVersion: EXPORT_ARCHIVE_SCHEMA_VERSION,
          tenantId,
          generatedAt: generatedAt.toISOString(),
        },
      },
    });

  // 5. Sign URL via `@cortex/blob-storage`'s validator-backed signer.
  const signer =
    options.signer ??
    createSignedUrlSigner(env, options.storage !== undefined ? { storage: options.storage } : {});
  const signedResult = await signer.sign({
    tenantId,
    objectName,
    expiresInSeconds,
    action: 'read',
  });

  return {
    bucket,
    fullObjectPath,
    gcsUri: `gs://${bucket}/${fullObjectPath}`,
    signedUrl: signedResult.url,
    signedUrlExpiresAt: signedResult.expiresAt,
    sizeBytes: gzipped.length,
    generatedAt,
    schemaVersion: EXPORT_ARCHIVE_SCHEMA_VERSION,
    entityCounts,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

interface EntityCollection {
  tenant: Record<string, unknown>[];
  tenant_config_version: Record<string, unknown>[];
  tenant_kms_key: Record<string, unknown>[];
  tenant_quota_usage: Record<string, unknown>[];
  legal_hold: Record<string, unknown>[];
  audit_event: Record<string, unknown>[];
}

async function collectEntities(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
): Promise<EntityCollection> {
  const tenantRows = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM tenant WHERE id = ${tenantId}`,
  );
  const configRows = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM tenant_config_version WHERE tenant_id = ${tenantId} ORDER BY version_number`,
  );
  // Exclude any future key-material columns by enumerating known-safe
  // columns explicitly. Phase 1 schema has no key material in the DB
  // (KMS owns the keys); this is defense in depth for future schema
  // additions.
  const kmsRows = await db.execute<Record<string, unknown>>(
    sql`SELECT id, tenant_id, kms_key_resource_name, created_at, rotated_at
        FROM tenant_kms_key WHERE tenant_id = ${tenantId}`,
  );
  const quotaRows = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM tenant_quota_usage WHERE tenant_id = ${tenantId}
        ORDER BY window_start, resource_class`,
  );
  const legalHoldRows = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM legal_hold WHERE tenant_id = ${tenantId} ORDER BY set_at`,
  );
  const auditRows = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM audit_event WHERE tenant_id = ${tenantId} ORDER BY occurred_at, ctid`,
  );

  return {
    tenant: tenantRows.rows,
    tenant_config_version: configRows.rows,
    tenant_kms_key: kmsRows.rows,
    tenant_quota_usage: quotaRows.rows,
    legal_hold: legalHoldRows.rows,
    audit_event: auditRows.rows,
  };
}

/**
 * Extract a stable per-record identifier for the JSONL record envelope.
 * Most tables have an `id` UUID column; `audit_event` uses `event_id`.
 * Falls back to a composite when neither is present (defensive — should
 * never fire for the six known entity types).
 */
function extractEntityId(
  entityType: ExportArchiveEntityType,
  row: Record<string, unknown>,
): string {
  if (entityType === 'audit_event') {
    const eventId = row.event_id;
    if (typeof eventId === 'string') return eventId;
  }
  const id = row.id;
  if (typeof id === 'string') return id;
  // Composite-key fallback. tenant_quota_usage's UNIQUE is
  // (tenant_id, resource_class, window_start) — used here only if
  // `id` is somehow missing.
  const tenantPart = typeof row.tenant_id === 'string' ? row.tenant_id : 'unknown';
  const suffix =
    typeof row.window_start === 'string'
      ? row.window_start
      : typeof row.version_number === 'number'
        ? String(row.version_number)
        : 'unknown';
  return `${tenantPart}-${suffix}`;
}
