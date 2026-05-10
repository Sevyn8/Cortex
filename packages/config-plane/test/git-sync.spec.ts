/**
 * F04 Slice E — git-sync stub tests.
 *
 * Verify both stub functions throw `GitSyncNotImplementedError` per
 * Q-NEW-F04E-2 lock + barrel exports surface the stub API + error
 * class. No DB needed — these are pure unit tests over the in-memory
 * stub.
 *
 * Phase 2 will replace these with round-trip integration tests
 * (`importFromYaml(ctx, await exportToYaml(ctx))` reproduces full
 * version history). For Phase 1 the contract is "throws clearly with
 * Phase 2 + roadmap §5.5 references in the message."
 */

import { describe, expect, it } from 'vitest';
import {
  exportToYaml,
  importFromYaml,
  GitSyncNotImplementedError,
  type GitSyncContext,
} from '../src/index.js';

const ctx: GitSyncContext = { tenantId: '00000000-0000-0000-0000-000000000000' };

describe('@cortex/config-plane git-sync stub (Slice E)', () => {
  it('exportToYaml throws GitSyncNotImplementedError referencing Phase 2 + roadmap §5.5', async () => {
    await expect(exportToYaml(ctx)).rejects.toBeInstanceOf(GitSyncNotImplementedError);
    await expect(exportToYaml(ctx)).rejects.toThrow(/Phase 2/);
    await expect(exportToYaml(ctx)).rejects.toThrow(/§5\.5/);
    await expect(exportToYaml(ctx)).rejects.toThrow(/exportToYaml/);
  });

  it('importFromYaml throws GitSyncNotImplementedError referencing Phase 2 + roadmap §5.5', async () => {
    await expect(importFromYaml(ctx, '# placeholder')).rejects.toBeInstanceOf(
      GitSyncNotImplementedError,
    );
    await expect(importFromYaml(ctx, '')).rejects.toThrow(/Phase 2/);
    await expect(importFromYaml(ctx, '')).rejects.toThrow(/§5\.5/);
    await expect(importFromYaml(ctx, '')).rejects.toThrow(/importFromYaml/);
  });

  it('GitSyncNotImplementedError sets `name` for type-narrowing in JSON-serialized contexts', () => {
    const err = new GitSyncNotImplementedError('exportToYaml');
    expect(err.name).toBe('GitSyncNotImplementedError');
    expect(err).toBeInstanceOf(Error);
  });

  it('barrel exports the Slice E surface: exportToYaml, importFromYaml, GitSyncNotImplementedError, GitSyncContext', () => {
    // Compile-time check — if any of these names drift from the barrel,
    // the import at the top of this file fails to typecheck. Runtime
    // check confirms the exports are functions / classes as expected.
    expect(typeof exportToYaml).toBe('function');
    expect(typeof importFromYaml).toBe('function');
    expect(typeof GitSyncNotImplementedError).toBe('function'); // class constructor
  });
});
