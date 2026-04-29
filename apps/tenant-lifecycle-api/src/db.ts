import { GoogleAuth } from 'google-auth-library';
import { Pool } from 'pg';
import type { AppConfig } from './config.js';

/**
 * Cloud SQL IAM-auth `pg.Pool` per ADR-INFRA-005 Decision 11.
 *
 * Connection model:
 *   - `host = /cloudsql/{INSTANCE_CONNECTION_NAME}` — Cloud Run's native
 *     `--add-cloudsql-instances` connector exposes a Unix socket at
 *     this path. No sidecar; no proxy binary in the image.
 *   - `user = <runtime-sa-email-without-gserviceaccount-suffix>`. PG
 *     username convention for IAM auth per Cloud SQL docs.
 *   - `password = () => Promise<string>`. The pg pool calls this
 *     callback whenever it acquires a new physical connection; we
 *     fetch a fresh OAuth access token from the SA's ADC each time.
 *     Tokens are typically valid for ~1 h; the callback refresh loop
 *     keeps long-running pools healthy without manual rotation.
 *
 * Pool warmup cost lands in the cold-start window (SD3 "first
 * request handled" boundary). On a route that doesn't touch the DB
 * (e.g. `/health`), pool warmup never happens — measurement isolates
 * pure app-init cost. `/v1/tenants/{id}` does query the DB and
 * therefore captures pool + IAM-token + Cloud SQL handshake cost.
 *
 * D.4 follow-up (TF gap, see convention §7.1):
 *   - tenant-lifecycle-runtime SA needs roles/cloudsql.client on the
 *     env project (network reachability) AND
 *     roles/cloudsql.instanceUser on the Cloud SQL instance
 *     (IAM-auth login).
 *   - A `google_sql_user` resource of `type = "CLOUD_IAM_SERVICE_ACCOUNT"`
 *     must register the SA email as a database user.
 *   - SQL grants (CONNECT on cortex DB, USAGE on schemas, SELECT/
 *     INSERT/UPDATE/DELETE on the relevant tables) — typically applied
 *     via a migration; D.4 wires the application script.
 *   Until D.4 lands these, /v1/tenants/{id} will 500 on first DB
 *   query. /health and /v1/test/slow-5s are unaffected, so D.1's
 *   Conditions 2 + 3 measurement still proceeds.
 */
export function createPool(config: AppConfig): Pool {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/sqlservice.admin'],
  });

  return new Pool({
    host: `/cloudsql/${config.CLOUDSQL_INSTANCE_CONNECTION_NAME}`,
    user: config.PG_IAM_USER,
    database: config.PGDATABASE,
    password: async (): Promise<string> => {
      // GoogleAuth.getAccessToken returns string | null | undefined;
      // a missing token at runtime is unrecoverable.
      const token = await auth.getAccessToken();
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('Failed to acquire IAM access token for Cloud SQL connection');
      }
      return token;
    },
    // Unix-socket connection; SSL is not applicable.
    ssl: false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
