/**
 * The insurance-cac cost ontology: the cost-line-to-funnel-stage assignment.
 *
 * Source: docs/spec/v3/cac/insurance-cac-cost-stage-map.md. Only the 65 lines
 * whose `applies to` contains G (generic) or I (insurance) are assigned; the 20
 * lines that are exclusively L, E, or C are out of scope and omitted.
 *
 * Each entry is a `CostLineInput` from the funnel-economics primitive minus the
 * runtime `amount` (amounts are tenant data joined at compute time, not pack
 * content). `mode` and `basis` carry the allocation rule per V3-FUNNEL-FR-003:
 *   - `direct`: the amount lands wholly on the assigned stage.
 *   - `allocated` / `fixed`: spread across stages by `basis`. Per the doc's
 *     judgment call 6, `equal` is the safe default where the basis is unconfirmed.
 * For `allocated`/`fixed` lines the `stage` is nominal (the primitive spreads by
 * basis, not by the assigned stage); the three section-2 cross-stage overhead
 * lines (C059, C060, C084) are spread across all stages this way.
 *
 * Field naming: `leakageFlag` is camelCase here because it is inherited from the
 * shared `CostLineInput` type in @cortex/funnel-economics. The neutral pack
 * contract is snake_case, so it serializes to `leakage_flag`. Normalizing it at
 * source would mean diverging from the shared type, so it stays as-is until the
 * shared type is changed (a separate, scoped change to @cortex/funnel-economics).
 */
import type { CostLineInput } from '@cortex/funnel-economics';

/** A pack cost-line assignment: the primitive's cost-line input shape without the runtime amount. */
export type CostLineAssignment = Omit<CostLineInput, 'amount'>;

export const INSURANCE_COST_ONTOLOGY: CostLineAssignment[] = [
  // Stage 1: Impression (direct on media spend)
  { id: 'C002', stage: 'impression', mode: 'direct' },
  { id: 'C003', stage: 'impression', mode: 'direct' },
  { id: 'C004', stage: 'impression', mode: 'direct' },
  { id: 'C010', stage: 'impression', mode: 'direct' },
  { id: 'C011', stage: 'impression', mode: 'allocated', basis: 'equal' },
  { id: 'C015', stage: 'impression', mode: 'direct' },
  { id: 'C017', stage: 'impression', mode: 'allocated', basis: 'equal' },
  { id: 'C073', stage: 'impression', mode: 'allocated', basis: 'equal', leakageFlag: true },
  { id: 'C078', stage: 'impression', mode: 'direct', leakageFlag: true },
  { id: 'C079', stage: 'impression', mode: 'direct', leakageFlag: true },
  { id: 'C080', stage: 'impression', mode: 'direct', leakageFlag: true },

  // Stage 2: Click (direct plus allocated)
  { id: 'C001', stage: 'click', mode: 'direct' },
  { id: 'C005', stage: 'click', mode: 'direct' },
  { id: 'C006', stage: 'click', mode: 'direct' },
  { id: 'C007', stage: 'click', mode: 'direct' },
  // C009 influencer fees: in scope (G) but unplaced in the doc; section 5 puts it
  // at click if used. Included here, conditional.
  { id: 'C009', stage: 'click', mode: 'direct' },
  { id: 'C012', stage: 'click', mode: 'direct' },
  { id: 'C013', stage: 'click', mode: 'direct' },
  { id: 'C016', stage: 'click', mode: 'direct' },
  { id: 'C018', stage: 'click', mode: 'allocated', basis: 'equal' },
  { id: 'C020', stage: 'click', mode: 'fixed', basis: 'equal' },
  { id: 'C021', stage: 'click', mode: 'fixed', basis: 'equal' },
  { id: 'C070', stage: 'click', mode: 'direct', leakageFlag: true },
  { id: 'C072', stage: 'click', mode: 'allocated', basis: 'equal', leakageFlag: true },

  // Stage 3: Lead (per leads)
  { id: 'C008', stage: 'lead', mode: 'direct' },
  { id: 'C014', stage: 'lead', mode: 'allocated', basis: 'equal' },
  { id: 'C019', stage: 'lead', mode: 'direct' },
  { id: 'C022', stage: 'lead', mode: 'fixed', basis: 'equal' },
  { id: 'C023', stage: 'lead', mode: 'direct' },
  { id: 'C024', stage: 'lead', mode: 'fixed', basis: 'equal' },
  { id: 'C038', stage: 'lead', mode: 'direct' },
  { id: 'C042', stage: 'lead', mode: 'direct' },
  { id: 'C043', stage: 'lead', mode: 'direct' },
  { id: 'C055', stage: 'lead', mode: 'fixed', basis: 'equal' },
  { id: 'C085', stage: 'lead', mode: 'direct', leakageFlag: true },

  // Stage 4: Contact (per leads)
  { id: 'C028', stage: 'contact', mode: 'direct' },
  { id: 'C075', stage: 'contact', mode: 'direct' },

  // Stage 5: Qualified (per qualified)
  { id: 'C046', stage: 'qualified', mode: 'direct', leakageFlag: true },
  { id: 'C047', stage: 'qualified', mode: 'direct' },
  { id: 'C048', stage: 'qualified', mode: 'direct' },
  { id: 'C049', stage: 'qualified', mode: 'fixed', basis: 'equal' },
  { id: 'C056', stage: 'qualified', mode: 'direct', leakageFlag: true },

  // Stage 6: Quote (per qualified or per quote)
  { id: 'C029', stage: 'quote', mode: 'direct' },
  { id: 'C050', stage: 'quote', mode: 'direct' },
  { id: 'C065', stage: 'quote', mode: 'direct' },

  // Stage 7: Policy (per customers)
  { id: 'C026', stage: 'policy', mode: 'fixed', basis: 'equal' },
  { id: 'C027', stage: 'policy', mode: 'direct' },
  { id: 'C030', stage: 'policy', mode: 'direct' },
  { id: 'C031', stage: 'policy', mode: 'direct' },
  { id: 'C032', stage: 'policy', mode: 'direct' },
  { id: 'C036', stage: 'policy', mode: 'direct' },
  { id: 'C039', stage: 'policy', mode: 'direct' },
  { id: 'C051', stage: 'policy', mode: 'direct' },
  { id: 'C054', stage: 'policy', mode: 'direct' },
  { id: 'C061', stage: 'policy', mode: 'direct' },
  { id: 'C062', stage: 'policy', mode: 'direct' },
  { id: 'C063', stage: 'policy', mode: 'direct' },
  { id: 'C076', stage: 'policy', mode: 'fixed', basis: 'equal' },
  { id: 'C077', stage: 'policy', mode: 'direct', leakageFlag: true },

  // Stage 8: Retained at 13m (per retained customers)
  { id: 'C052', stage: 'retained_13m', mode: 'fixed', basis: 'equal', leakageFlag: true },
  { id: 'C071', stage: 'retained_13m', mode: 'direct', leakageFlag: true },
  { id: 'C074', stage: 'retained_13m', mode: 'direct', leakageFlag: true },

  // Section 2: cross-stage overhead, spread across all stages (stage nominal)
  { id: 'C059', stage: 'impression', mode: 'fixed', basis: 'equal' },
  { id: 'C060', stage: 'impression', mode: 'fixed', basis: 'equal' },
  { id: 'C084', stage: 'impression', mode: 'fixed', basis: 'equal' },
];
