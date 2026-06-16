import { describe, expect, it } from 'vitest';
import { PACK_MANIFEST, packManifestSchema, validateManifest } from '../src/index.js';

describe('pack manifest carries the required V3-PACK-FR-001 skeleton fields', () => {
  it('validates against the manifest schema', () => {
    expect(() => validateManifest()).not.toThrow();
  });

  it('has id, version (SemVer), engine-compat range, and a signature placeholder', () => {
    const m = validateManifest();
    expect(m.id).toBe('insurance-cac');
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof m.engineCompat).toBe('string');
    expect(m.engineCompat.length).toBeGreaterThan(0);
    expect(PACK_MANIFEST.signature.signed).toBe(false);
  });

  it('rejects a non-SemVer version', () => {
    expect(() => packManifestSchema.parse({ ...PACK_MANIFEST, version: 'v1' })).toThrow();
  });

  it('rejects a manifest missing the signature field', () => {
    const withoutSignature: Record<string, unknown> = {
      id: PACK_MANIFEST.id,
      version: PACK_MANIFEST.version,
      engineCompat: PACK_MANIFEST.engineCompat,
    };
    expect(() => packManifestSchema.parse(withoutSignature)).toThrow();
  });
});
