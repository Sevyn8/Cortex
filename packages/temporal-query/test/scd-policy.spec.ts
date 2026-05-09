/**
 * F03 Slice C C.1 — SCD policy schema + namespace registration.
 *
 * Per Q-NEW-F03C-7: Types 3/4/6 schemas at C.1 are placeholders
 * (optional fields, permissive shapes). Real schema-design lock
 * comes at HOLD #2; these tests verify only that all 5 type
 * literals parse and that the schema is registered against
 * `tenant.scd` at version 1.
 */

import { describe, expect, it } from 'vitest';
import { getNamespaceSchema } from '@cortex/config-plane';
import {
  SCDPolicySchema,
  SCDEntityPolicySchema,
  SCD_POLICY_NAMESPACE,
  SCD_POLICY_SCHEMA_VERSION,
} from '../src/scd-policy.js';

describe('SCD policy schema (C.1)', () => {
  describe('namespace registration (Q-NEW-F03C-2 + F03C-5 locks)', () => {
    it('registers SCDPolicySchema in F04 registry at namespace=tenant.scd, version=1', () => {
      const entry = getNamespaceSchema(SCD_POLICY_NAMESPACE, SCD_POLICY_SCHEMA_VERSION);
      expect(entry).toBeDefined();
      expect(entry!.namespace).toBe('tenant.scd');
      expect(entry!.version).toBe(1);
      expect(entry!.schema).toBe(SCDPolicySchema);
    });
  });

  describe('per-type happy paths', () => {
    it('Type 1 (overwrite)', () => {
      const policy = { product: { type: 1 } };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(true);
    });

    it('Type 2 (new row per change)', () => {
      const policy = { product: { type: 2 } };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(true);
    });

    it('Type 3 (previous value in column) — single previousValueColumn (Q-NEW-F03C-7a)', () => {
      const policy = {
        customer_address: { type: 3, previousValueColumn: 'zip_code' },
      };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(true);
    });

    it('Type 4 (history table) with explicit historyTableName', () => {
      const policy = {
        retail_product: { type: 4, historyTableName: 'retail_product_history' },
      };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(true);
    });

    it('Type 4 (history table) without historyTableName — defaults to `<table>_history`', () => {
      const policy = { retail_product: { type: 4 } };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(true);
    });

    it('Type 6 (hybrid) with previousValueColumns array (Q-NEW-F03C-7c)', () => {
      const policy = {
        order: {
          type: 6,
          previousValueColumns: ['status', 'priority'],
        },
      };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(true);
    });

    it('Type 6 (hybrid) with empty previousValueColumns array (= Type 2 + zero captures)', () => {
      const policy = {
        order: { type: 6, previousValueColumns: [] },
      };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(true);
    });
  });

  describe('multi-entity policies', () => {
    it('accepts a record with multiple entity types in a single namespace', () => {
      const policy = {
        retail_product: { type: 2 },
        customer_address: { type: 3, previousValueColumn: 'old_zip' },
        order_item: { type: 1 },
      };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(true);
    });

    it('accepts an empty namespace (tenant has no SCD overrides)', () => {
      // This is the common Phase 1 case — tenant_config_version
      // namespace=tenant.scd absent OR set to {}; trigger falls
      // back to Type 2 per Q-NEW-F03C-4.
      expect(SCDPolicySchema.safeParse({}).success).toBe(true);
    });
  });

  describe('rejection cases', () => {
    it('rejects an unknown SCD type number (e.g., type=5)', () => {
      const policy = { product: { type: 5 } };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(false);
    });

    it('rejects a type field that is not a number literal', () => {
      const policy = { product: { type: '2' } };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(false);
    });

    it('rejects a missing type discriminator', () => {
      const policy = { product: { previousValueColumn: 'foo' } };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(false);
    });

    it('rejects Type 3 missing previousValueColumn (required per Q-NEW-F03C-7a lock)', () => {
      const policy = { customer_address: { type: 3 } };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(false);
    });

    it('rejects Type 3 previousValueColumn that fails the column-name regex', () => {
      const policy = {
        customer_address: { type: 3, previousValueColumn: 'BAD-NAME' },
      };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(false);
    });

    it('rejects Type 6 missing previousValueColumns (required per Q-NEW-F03C-7c lock)', () => {
      const policy = { order: { type: 6 } };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(false);
    });

    it('rejects Type 6 previousValueColumns containing a non-snake_case identifier', () => {
      const policy = {
        order: { type: 6, previousValueColumns: ['status', 'BAD-NAME'] },
      };
      expect(SCDPolicySchema.safeParse(policy).success).toBe(false);
    });
  });

  describe('SCDEntityPolicySchema (single-entity discriminated union)', () => {
    it('parses a single Type 2 entity policy', () => {
      expect(SCDEntityPolicySchema.safeParse({ type: 2 }).success).toBe(true);
    });

    it('rejects an empty object (missing discriminator)', () => {
      expect(SCDEntityPolicySchema.safeParse({}).success).toBe(false);
    });
  });
});
