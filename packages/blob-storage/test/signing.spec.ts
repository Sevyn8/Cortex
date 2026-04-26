import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Storage } from '@google-cloud/storage';
import {
  BlobStorageValidationError,
  __resetForTesting,
  __setSignerForTesting,
  createSignedUrlSigner,
  generateSignedUrl,
  type SignedUrlSigner,
} from '../src/index.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

// ─────────────────────────────────────────────────────────────────────
// In-memory Storage stub. We capture the bucket name + object path the
// signer requests, return a deterministic URL, and assert call shape.
// ─────────────────────────────────────────────────────────────────────

interface SignCall {
  bucketName: string;
  filePath: string;
  signOpts: { version: string; action: string; expires: number; contentType?: string };
}

function fakeStorage(): { storage: Storage; calls: SignCall[] } {
  const calls: SignCall[] = [];
  const storage = {
    bucket: vi.fn((bucketName: string) => ({
      file: vi.fn((filePath: string) => ({
        getSignedUrl: vi.fn(
          (opts: { version: string; action: string; expires: number; contentType?: string }) => {
            calls.push({ bucketName, filePath, signOpts: opts });
            return Promise.resolve([
              `https://storage.googleapis.com/${bucketName}/${filePath}?signed=fake&exp=${opts.expires}`,
            ]);
          },
        ),
      })),
    })),
  } as unknown as Storage;
  return { storage, calls };
}

afterEach(() => {
  __resetForTesting();
});

describe('createSignedUrlSigner — happy path', () => {
  it('signs a v4 read URL bound to tenants/{id}/ prefix', async () => {
    const { storage, calls } = fakeStorage();
    const signer = createSignedUrlSigner('dev', { storage });
    const result = await signer.sign({
      tenantId: TENANT_A,
      objectName: 'reports/foo.csv',
      expiresInSeconds: 900,
      action: 'read',
    });

    expect(result.url).toContain('storage.googleapis.com');
    expect(result.fullObjectPath).toBe(`tenants/${TENANT_A}/reports/foo.csv`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bucketName).toBe('cortex-dev-tenant-data');
    expect(calls[0]!.filePath).toBe(`tenants/${TENANT_A}/reports/foo.csv`);
    expect(calls[0]!.signOpts.version).toBe('v4');
    expect(calls[0]!.signOpts.action).toBe('read');
  });

  it('expiresAt = now + expiresInSeconds * 1000 (ms precision)', async () => {
    const { storage } = fakeStorage();
    const signer = createSignedUrlSigner('staging', { storage });
    const before = Date.now();
    const result = await signer.sign({
      tenantId: TENANT_A,
      objectName: 'foo.txt',
      expiresInSeconds: 60,
      action: 'read',
    });
    const after = Date.now();

    const expiresMs = result.expiresAt.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresMs).toBeLessThanOrEqual(after + 60_000);
  });

  it('write action threads contentType through to GCS sign opts', async () => {
    const { storage, calls } = fakeStorage();
    const signer = createSignedUrlSigner('prod', { storage });
    await signer.sign({
      tenantId: TENANT_A,
      objectName: 'uploads/file.bin',
      expiresInSeconds: 60,
      action: 'write',
      contentType: 'application/octet-stream',
    });
    expect(calls[0]!.signOpts.action).toBe('write');
    expect(calls[0]!.signOpts.contentType).toBe('application/octet-stream');
  });
});

describe('createSignedUrlSigner — validation rejection', () => {
  it('rejects non-UUID tenantId', async () => {
    const { storage } = fakeStorage();
    const signer = createSignedUrlSigner('dev', { storage });
    await expect(
      signer.sign({
        tenantId: 'not-a-uuid',
        objectName: 'foo',
        expiresInSeconds: 60,
        action: 'read',
      }),
    ).rejects.toBeInstanceOf(BlobStorageValidationError);
  });

  it('rejects path-traversal objectName', async () => {
    const { storage } = fakeStorage();
    const signer = createSignedUrlSigner('dev', { storage });
    await expect(
      signer.sign({
        tenantId: TENANT_A,
        objectName: '../escape',
        expiresInSeconds: 60,
        action: 'read',
      }),
    ).rejects.toBeInstanceOf(BlobStorageValidationError);
  });

  it('rejects objectName starting with tenants/ (cross-tenant escape attempt)', async () => {
    const { storage } = fakeStorage();
    const signer = createSignedUrlSigner('dev', { storage });
    await expect(
      signer.sign({
        tenantId: TENANT_A,
        objectName: `tenants/${TENANT_B}/foo`,
        expiresInSeconds: 60,
        action: 'read',
      }),
    ).rejects.toBeInstanceOf(BlobStorageValidationError);
  });

  it('rejects expiresInSeconds above 7 days', async () => {
    const { storage } = fakeStorage();
    const signer = createSignedUrlSigner('dev', { storage });
    await expect(
      signer.sign({
        tenantId: TENANT_A,
        objectName: 'foo',
        expiresInSeconds: 7 * 24 * 60 * 60 + 1,
        action: 'read',
      }),
    ).rejects.toBeInstanceOf(BlobStorageValidationError);
  });
});

describe('hybrid DI escape hatches', () => {
  it('__setSignerForTesting routes generateSignedUrl through the swap', async () => {
    const signSpy = vi.fn(() =>
      Promise.resolve({
        url: 'sentinel-url',
        expiresAt: new Date(0),
        fullObjectPath: 'sentinel-path',
      }),
    );
    const sentinel: SignedUrlSigner = { sign: signSpy };
    __setSignerForTesting(sentinel);
    const result = await generateSignedUrl({
      tenantId: TENANT_A,
      objectName: 'whatever',
      expiresInSeconds: 60,
      action: 'read',
    });
    expect(result.url).toBe('sentinel-url');
    expect(signSpy).toHaveBeenCalledOnce();
  });
});
