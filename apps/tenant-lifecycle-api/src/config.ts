import { z } from 'zod';

/**
 * Cloud SQL connection model per ADR-INFRA-005:
 *   - `cloudsql.iam_authentication = on` (only active auth path).
 *   - No password on the postgres superuser; no per-app password user.
 *   - The runtime SA (tenant-lifecycle-runtime-{env}) authenticates via
 *     OAuth tokens — see `db.ts` for the password-callback pattern.
 *
 * Cloud Run injects the Unix socket at `/cloudsql/{INSTANCE_CONNECTION_NAME}`
 * when `--add-cloudsql-instances` is set on the service. We pass the
 * instance connection name (project:region:instance) and let `db.ts`
 * compose the host path; PG username is the SA email without
 * `.gserviceaccount.com` per the IAM-auth username convention.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  GCP_PROJECT_ID: z.string().min(1).default('sevyn8-cortex-dev'),

  // Cloud SQL IAM-auth identity. Format: project:region:instance.
  // Cloud Run resolves this to a Unix socket at /cloudsql/{this value}.
  CLOUDSQL_INSTANCE_CONNECTION_NAME: z.string().regex(/^[^:]+:[^:]+:[^:]+$/, {
    message: 'expected project:region:instance',
  }),
  // PG database name (Cortex's main DB). Created by P0.4 Phase B.
  PGDATABASE: z.string().min(1).default('cortex'),
  // PG user = SA email without the .gserviceaccount.com suffix.
  // Example: tenant-lifecycle-runtime@sevyn8-cortex-dev.iam
  PG_IAM_USER: z.string().min(1),

  COMMIT_SHA: z.string().default('unknown'),

  // Tag-gate: dev-only test routes (slow-5s for SIGTERM verification).
  // Set to 'true' on the dev measurement deploy ONLY — convention §7.1
  // captures the prototype-only nature of this gate.
  ENABLE_TEST_ROUTES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Cloud Run revision id, useful for cold-start measurement narrative.
  K_REVISION: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast at startup; config errors are unrecoverable.
    throw new Error(`Invalid env: ${parsed.error.message}`);
  }
  return parsed.data;
}
