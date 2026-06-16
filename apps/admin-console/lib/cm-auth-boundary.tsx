import type { ReactNode } from 'react';

/**
 * PLACEHOLDER Customer Master auth boundary.
 *
 * TODO(CM/contracts C1): replace with the real CM machine/user auth integration.
 *
 * Identity, RBAC vocabulary, RLS, the action ledger, and the policy gate are
 * owned by Customer Master (ADR-IDENTITY-001; invariant 3, "no second identity
 * or policy authority"). This is a stand-in integration seam ONLY: it renders
 * its children and evaluates no roles, permissions, or policy. When CM publishes
 * the C1 machine-auth token contract via the contracts repo, this boundary is
 * swapped for the real check (validate the C1 token, bind tenant and scope
 * context); call sites under `/cac` stay the same.
 */
export interface CmAuthBoundaryProps {
  /** Label of the guarded area, for the placeholder marker. */
  area: string;
  children: ReactNode;
}

export function CmAuthBoundary({ area, children }: CmAuthBoundaryProps) {
  return (
    <div data-cm-auth={area} data-cm-auth-state="placeholder">
      {children}
    </div>
  );
}
