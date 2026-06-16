import { CmAuthBoundary } from '../../../lib/cm-auth-boundary';

/**
 * CAC admin area: pack and tenant configuration for the insurance vertical
 * (pack version pinning, tenant theme and label overrides per V3-UX01-FR-001;
 * never schema or rules). Admin-vs-user scoping is enforced by the CM auth
 * contract (see lib/cm-auth-boundary.tsx), not here. Placeholder shell.
 */
export default function CacAdminPage() {
  return (
    <CmAuthBoundary area="cac-admin">
      <main className="p-8">
        <h1 className="text-2xl font-semibold">CAC Admin</h1>
        <p className="mt-2 text-sm opacity-80">
          Insurance pack and tenant configuration surface (R0a-redux shell).
        </p>
      </main>
    </CmAuthBoundary>
  );
}
