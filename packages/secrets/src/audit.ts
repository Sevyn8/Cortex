export type AuditOperation = 'get' | 'put' | 'encrypt' | 'decrypt' | 'getKeyForTenant';

export interface AuditEntry {
  operation: AuditOperation;
  tenant_id: string | null;
  secret_id: string | null;
  key_id: string | null;
  outcome: 'ok' | 'error';
  error_code: string | null;
  duration_ms: number;
  actor: string;
}

function getActor(): string {
  return process.env.CORTEX_ACTOR ?? 'unknown';
}

// TODO(P0.6 Phase 2): swap console.error for @cortex/observability structured
// logger. Grep marker: [SECRETS-AUDIT].
export function auditLog(entry: Omit<AuditEntry, 'actor'>): void {
  const full: AuditEntry = { ...entry, actor: getActor() };

  console.error(`[SECRETS-AUDIT] ${JSON.stringify(full)}`);
}
