/**
 * PII redaction config used by pino's `redact` option.
 *
 * Per ADR-OBS-001 §Decision 5, redaction happens at the logger boundary
 * (pino transformer) — not per-service. This keeps PII out of logs even
 * if a service developer passes a value-bearing object inadvertently.
 *
 * Mechanism: pino's redact is **path-based**. The `*` wildcard matches a
 * single path segment; nested objects are redacted by listing each
 * level. Bracket notation (e.g., `req.headers["x-api-key"]`) handles
 * keys with hyphens or other non-identifier characters.
 *
 * No value-based detection (regex on log values) ships in Phase 2:
 * - Performance cost is non-trivial at high log volume.
 * - False-positive risk: legitimate strings that look like PII (test
 *   fixtures, debugging dumps) get redacted unnecessarily.
 * - Defer-track in ADR-OBS-003 (drafted in sub-phase 2.10). Revisit if
 *   real PII leaks are observed in production logs.
 *
 * Reference: https://github.com/pinojs/pino/blob/main/docs/redaction.md
 */

/**
 * Canonical redaction paths for Cortex. Indian-context PII (aadhaar,
 * pan) explicitly included alongside the international set. Auth-token
 * headers (`authorization`, `cookie`, `x-api-key`) are always redacted
 * — these are the leakiest channels for credential exfiltration.
 */
export const DEFAULT_REDACTION_PATHS: readonly string[] = [
  // Common credential field names (any nesting level)
  '*.password',
  '*.api_key',
  '*.apiKey',
  '*.token',
  '*.access_token',
  '*.accessToken',
  '*.refresh_token',
  '*.refreshToken',
  '*.secret',
  '*.client_secret',
  '*.clientSecret',
  '*.private_key',
  '*.privateKey',

  // Personal identifiers
  '*.email',
  '*.phone',
  '*.phone_number',
  '*.phoneNumber',
  '*.ssn',
  '*.aadhaar',
  '*.aadhar', // alternate spelling
  '*.pan',
  '*.pan_number',

  // Payment instruments
  '*.credit_card',
  '*.creditCard',
  '*.card_number',
  '*.cardNumber',
  '*.cvv',
  '*.iban',

  // HTTP request/response headers — always-redact
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  // Tenant id header. Not strictly PII but redacted in shared logs to
  // avoid cross-tenant leakage when a developer captures a request
  // dump in a multi-tenant context.
  'req.headers["x-cortex-tenant-id"]',
  'res.headers["set-cookie"]',
];

/**
 * Replacement value pino writes in place of redacted leaves.
 */
export const REDACTION_CENSOR = '[REDACTED]';

/**
 * Build the redact config in the shape pino expects (`{ paths, censor }`).
 * `extraPaths` are concatenated with the canonical defaults — callers
 * can extend, but cannot subtract. (If subtraction ever becomes a real
 * need, surface as a deferral and revisit; today's posture is "default
 * set is the minimum safe baseline.")
 */
export function buildRedactionConfig(extraPaths?: readonly string[]): {
  paths: string[];
  censor: string;
} {
  const paths =
    extraPaths === undefined
      ? [...DEFAULT_REDACTION_PATHS]
      : [...DEFAULT_REDACTION_PATHS, ...extraPaths];
  return { paths, censor: REDACTION_CENSOR };
}
