import { CmAuthBoundary } from '../../lib/cm-auth-boundary';

/**
 * CAC area: the insurance acquisition funnel experience.
 *
 * Per ADR-CAC-001 this is a pack-experience surface, not a bespoke module. The
 * funnel renders via the engine funnel archetype (V3-UX01-FR-002) over Atlas
 * V3-INS pack content. That archetype is Phase 2 experience-engine work and
 * does not exist yet, so this is a documented placeholder shell, not a stand-in
 * archetype implementation.
 */
export default function CacPage() {
  return (
    <CmAuthBoundary area="cac">
      <main className="p-8">
        <h1 className="text-2xl font-semibold">CAC</h1>
        <p className="mt-2 text-sm opacity-80">
          Insurance acquisition funnel surface. Renders via the funnel archetype over the V3-INS
          pack (pending Phase 2).
        </p>
      </main>
    </CmAuthBoundary>
  );
}
