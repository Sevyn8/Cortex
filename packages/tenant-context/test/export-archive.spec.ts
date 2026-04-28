/**
 * Tests for `generateExportArchive` (F02 Slice C — Q-NEW-C4 / Q-NEW-C5).
 *
 * Verifies: gzipped JSONL shape, schema-versioned record envelope, all
 * 6 entity types collected, RLS-bind dependency, GCS upload path
 * (`tenants/{id}/exports/{ts}.jsonl.gz`), V4 signed URL via
 * `@cortex/blob-storage`'s validator-backed signer, env-based bucket
 * resolution.
 *
 * Storage + signer are stubbed via `options.storage` / `options.signer`
 * — no real GCS calls. DB queries hit the local Postgres (RLS bind
 * required).
 */

import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { generateExportArchive, EXPORT_ARCHIVE_SCHEMA_VERSION } from '../src/export-archive.js';
import { tenants } from '../src/tenants.js';
import { bindTenantToDbSession } from '../src/db-session.js';
import { forceRlsOnAuditEvent, getPool, withBoundClient } from './helpers/db.js';

const RUN_TAG = randomUUID().slice(0, 8);
const ACTOR = { type: 'service' as const, id: 'export-archive-spec', description: 'export test' };

interface StubFile {
  save: ReturnType<typeof vi.fn>;
  getSignedUrl: ReturnType<typeof vi.fn>;
}

interface StubBucket {
  file: ReturnType<typeof vi.fn>;
  __file: StubFile;
}

interface StubStorage {
  bucket: ReturnType<typeof vi.fn>;
  __bucket: StubBucket;
}

function createStubStorage(): StubStorage {
  const file: StubFile = {
    save: vi.fn().mockResolvedValue(undefined),
    getSignedUrl: vi
      .fn()
      .mockResolvedValue(['https://storage.googleapis.com/signed-url-stub?X-Goog-Signature=stub']),
  };
  const bucket: StubBucket = {
    file: vi.fn().mockReturnValue(file),
    __file: file,
  };
  return {
    bucket: vi.fn().mockReturnValue(bucket),
    __bucket: bucket,
  };
}

describe('generateExportArchive', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';
    process.env.CORTEX_ENV = 'dev';
    pool = getPool();
    db = drizzle(pool);
    await forceRlsOnAuditEvent(pool);
  });

  afterAll(async () => {
    for (const id of createdTenantIds) {
      try {
        await withBoundClient(pool, id, async (client) => {
          await client.query('DELETE FROM tenant_config_version WHERE tenant_id = $1', [id]);
          await client.query('DELETE FROM tenant_kms_key WHERE tenant_id = $1', [id]);
          await client.query('DELETE FROM legal_hold WHERE tenant_id = $1', [id]);
        });
      } catch {
        // ignore
      }
      await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
    }
    await pool.end();
  });

  function externalIdFor(label: string): string {
    return `test-export-${RUN_TAG}-${label}`;
  }

  async function createActiveTenant(label: string): Promise<string> {
    const created = await tenants.create(
      db,
      {
        externalId: externalIdFor(label),
        displayName: `Export ${label}`,
        tier: 'STANDARD',
        initialStatus: 'ACTIVE',
        initialConfig: { feature_flag_x: true },
      },
      { actor: ACTOR },
    );
    createdTenantIds.push(created.id);
    return created.id;
  }

  it('returns archive metadata with schema_version, entityCounts, sizeBytes, and signed URL', async () => {
    const tenantId = await createActiveTenant('happy-1');
    const stub = createStubStorage();

    const result = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return generateExportArchive(tx, tenantId, {
        env: 'dev',
        storage: stub as never,
      });
    });

    expect(result.schemaVersion).toBe(EXPORT_ARCHIVE_SCHEMA_VERSION);
    expect(result.bucket).toBe('cortex-dev-tenant-data');
    expect(result.gcsUri).toMatch(
      /^gs:\/\/cortex-dev-tenant-data\/tenants\/[0-9a-f-]+\/exports\/\d{4}-\d{2}-\d{2}T.*\.jsonl\.gz$/,
    );
    expect(result.fullObjectPath).toContain(`tenants/${tenantId}/exports/`);
    expect(result.fullObjectPath.endsWith('.jsonl.gz')).toBe(true);
    expect(result.signedUrl).toContain('signed-url-stub');
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.entityCounts.tenant).toBe(1);
    expect(result.entityCounts.tenant_kms_key).toBe(1);
    expect(result.entityCounts.tenant_config_version).toBe(1);
    expect(result.entityCounts.audit_event).toBeGreaterThanOrEqual(3); // CREATED + KMS_BOUND + CONFIG_CREATED
    expect(result.entityCounts.legal_hold).toBe(0);
    expect(result.entityCounts.tenant_quota_usage).toBe(0);
  });

  it('uploaded buffer ungzips to JSONL with the schema-versioned envelope shape', async () => {
    const tenantId = await createActiveTenant('jsonl-1');
    const stub = createStubStorage();

    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return generateExportArchive(tx, tenantId, { env: 'dev', storage: stub as never });
    });

    const saveCall = stub.__bucket.__file.save.mock.calls[0];
    const gzipped = saveCall?.[0] as Buffer;
    expect(gzipped).toBeInstanceOf(Buffer);

    const jsonl = gunzipSync(gzipped).toString('utf-8');
    const lines = jsonl.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        schema_version: string;
        entity_type: string;
        entity_id: string;
        data: unknown;
      };
      expect(parsed.schema_version).toBe(EXPORT_ARCHIVE_SCHEMA_VERSION);
      expect(typeof parsed.entity_type).toBe('string');
      expect(typeof parsed.entity_id).toBe('string');
      expect(parsed.data).toBeDefined();
    }
  });

  it('records iterate in canonical entity order: tenant, config, kms, quota, legal, audit', async () => {
    const tenantId = await createActiveTenant('order-1');
    const stub = createStubStorage();

    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return generateExportArchive(tx, tenantId, { env: 'dev', storage: stub as never });
    });

    const saveCall = stub.__bucket.__file.save.mock.calls[0];
    const jsonl = gunzipSync(saveCall?.[0] as Buffer).toString('utf-8');
    const types = jsonl
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { entity_type: string }).entity_type);
    // Find first occurrence of each type and assert the relative order.
    const firstIndexes = new Map<string, number>();
    types.forEach((t, i) => {
      if (!firstIndexes.has(t)) firstIndexes.set(t, i);
    });
    const tenantIdx = firstIndexes.get('tenant') ?? -1;
    const kmsIdx = firstIndexes.get('tenant_kms_key') ?? -1;
    const configIdx = firstIndexes.get('tenant_config_version') ?? -1;
    const auditIdx = firstIndexes.get('audit_event') ?? -1;
    expect(tenantIdx).toBeGreaterThanOrEqual(0);
    expect(tenantIdx).toBeLessThan(configIdx);
    expect(configIdx).toBeLessThan(kmsIdx);
    expect(kmsIdx).toBeLessThan(auditIdx);
  });

  it('GCS upload uses the per-env bucket name + correct content metadata', async () => {
    const tenantId = await createActiveTenant('upload-1');
    const stub = createStubStorage();

    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return generateExportArchive(tx, tenantId, { env: 'staging', storage: stub as never });
    });

    expect(stub.bucket).toHaveBeenCalledWith('cortex-staging-tenant-data');
    const saveCall = stub.__bucket.__file.save.mock.calls[0];
    const saveOptions = saveCall?.[1] as {
      contentType: string;
      metadata: { contentEncoding: string; metadata: Record<string, string> };
    };
    expect(saveOptions.contentType).toBe('application/gzip');
    expect(saveOptions.metadata.contentEncoding).toBe('gzip');
    expect(saveOptions.metadata.metadata.tenantId).toBe(tenantId);
    expect(saveOptions.metadata.metadata.schemaVersion).toBe(EXPORT_ARCHIVE_SCHEMA_VERSION);
  });

  it('signed URL TTL defaults to 7 days (GCS V4 server-side max)', async () => {
    const tenantId = await createActiveTenant('ttl-default');
    const stub = createStubStorage();

    const result = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return generateExportArchive(tx, tenantId, { env: 'dev', storage: stub as never });
    });

    const ttlMs = result.signedUrlExpiresAt.getTime() - Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // Allow 5s slack for the time elapsed between sign and assertion.
    expect(ttlMs).toBeGreaterThan(sevenDaysMs - 5000);
    expect(ttlMs).toBeLessThanOrEqual(sevenDaysMs);
  });

  it('respects custom expiresInSeconds within the 7-day cap', async () => {
    const tenantId = await createActiveTenant('ttl-custom');
    const stub = createStubStorage();
    const oneHourSeconds = 60 * 60;

    const result = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return generateExportArchive(tx, tenantId, {
        env: 'dev',
        storage: stub as never,
        expiresInSeconds: oneHourSeconds,
      });
    });

    const ttlMs = result.signedUrlExpiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(oneHourSeconds * 1000 - 5000);
    expect(ttlMs).toBeLessThanOrEqual(oneHourSeconds * 1000);
  });

  it('rejects expiresInSeconds above the 7-day GCS cap (BlobStorageValidationError)', async () => {
    const tenantId = await createActiveTenant('ttl-overcap');
    const stub = createStubStorage();
    const eightDaysSeconds = 8 * 24 * 60 * 60;

    await expect(
      db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, tenantId);
        return generateExportArchive(tx, tenantId, {
          env: 'dev',
          storage: stub as never,
          expiresInSeconds: eightDaysSeconds,
        });
      }),
    ).rejects.toThrow(/expiresInSeconds.*<=/);
  });

  it('object name uses ISO timestamp with hyphens (no colons / dots) for path safety', async () => {
    const tenantId = await createActiveTenant('path-safety');
    const stub = createStubStorage();

    const result = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return generateExportArchive(tx, tenantId, { env: 'dev', storage: stub as never });
    });

    expect(result.fullObjectPath).not.toMatch(/:/);
    // Only the .gz extension dot is allowed; the timestamp itself has no '.'.
    const timestampPart = result.fullObjectPath.split('/').pop()?.replace('.jsonl.gz', '');
    expect(timestampPart).not.toMatch(/\./);
  });

  it('legal_hold rows are included in the archive', async () => {
    const tenantId = await createActiveTenant('legal-hold-1');
    await withBoundClient(pool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO legal_hold (tenant_id, scope, reason, set_by_user_id)
           VALUES ($1, 'tenant', 'export-archive test hold', 'workos_user_export')`,
        [tenantId],
      );
    });
    const stub = createStubStorage();

    const result = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return generateExportArchive(tx, tenantId, { env: 'dev', storage: stub as never });
    });

    expect(result.entityCounts.legal_hold).toBe(1);
    const jsonl = gunzipSync(stub.__bucket.__file.save.mock.calls[0]?.[0] as Buffer).toString(
      'utf-8',
    );
    expect(jsonl).toContain('export-archive test hold');
  });

  it('audit_event records use event_id (not id) as the entity_id', async () => {
    const tenantId = await createActiveTenant('audit-id-1');
    const stub = createStubStorage();

    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return generateExportArchive(tx, tenantId, { env: 'dev', storage: stub as never });
    });

    const jsonl = gunzipSync(stub.__bucket.__file.save.mock.calls[0]?.[0] as Buffer).toString(
      'utf-8',
    );
    const auditLines = jsonl
      .trimEnd()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as { entity_type: string; entity_id: string; data: { event_id: string } },
      )
      .filter((rec) => rec.entity_type === 'audit_event');
    for (const rec of auditLines) {
      expect(rec.entity_id).toBe(rec.data.event_id);
    }
  });

  it('rejects invalid tenantId at the path-validation layer (BlobStorageValidationError)', async () => {
    const stub = createStubStorage();
    await expect(
      db.transaction(async (tx) => {
        return generateExportArchive(tx, 'not-a-uuid', { env: 'dev', storage: stub as never });
      }),
    ).rejects.toThrow(/Invalid tenantId/);
  });
});
