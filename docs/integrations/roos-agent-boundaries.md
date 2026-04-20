# ROOS Agents vs Cortex Agents — Responsibility Boundaries

**Status:** Draft — pending Ithina coordination
**Version:** 0.1
**Governing ADR:** ADR-SCOPE-009

## Context

Ithina runs existing agents on ROOS. Cortex plans its own agents for Display Data Phase 1. Where nomenclature collides (most notably PAC), this document draws the line.

## ROOS agents (remain on ROOS, operated by Ithina)

- **PA** — TBD: what it does, what inputs, what outputs
- **PAC** — TBD: what it does, what inputs, what outputs
- **PROMO** — TBD: what it does, what inputs, what outputs
- **POG** — TBD: what it does, what inputs, what outputs

## Cortex agents (built in Cortex, operated by Sevyn8)

- **Planogram** — CV-based shelf compliance. Inputs: shelf imagery from HHT app + active planogram definition. Outputs: compliance score per (store, shelf, date), flagged findings, image annotations.
- **PAC (Cortex)** — CV-based assortment compliance. Inputs: shelf imagery + expected SKU list + POS data. Outputs: assortment gaps, OOS detection, prioritised corrective tasks.
- **Promotion** — CV-based promotional display verification. Inputs: shelf imagery + active promotion calendar. Outputs: promotion execution score per (store, promotion), missing-display flags.
- **Perishable** — forecasting-based waste prevention. Inputs: inventory data + POS data + demand patterns. Outputs: markdown recommendations, waste risk scores, reorder signals.

## Where nomenclature collides

**PAC (ROOS) vs PAC (Cortex):** TBD — expected distinction is "ROOS PAC is transaction-analytics-based; Cortex PAC is computer-vision-based on shelf imagery." Confirm with Ithina and document specifically what each owns.

**PROMO (ROOS) vs Promotion (Cortex):** TBD — expected distinction is "ROOS PROMO tracks promotional sales perform
**POG (ROOS) vs Planogram (Cortex):** TBD — expected distinction is "ROOS POG tracks planogram definitions and updates; Cortex Planogram detects compliance against those definitions using CV."

## Coordination

Any finding produced by a Cortex agent that duplicates (or contradicts) a ROOS agent finding is flagged and routed to joint triage for the first 30 days of integration. Post-30-day review determines whether any boundary changes are needed.
