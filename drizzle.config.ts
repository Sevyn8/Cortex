import { defineConfig } from 'drizzle-kit';

// Credentials are env-driven. The Makefile's db-migrate-<env> targets
// resolve PGPASSWORD via `gcloud secrets versions access` against the
// break-glass secret per env (cortex-db-postgres-break-glass-<env>).
// drizzle-kit picks up PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE at runtime.
export default defineConfig({
  dialect: 'postgresql',
  out: './services/foundation/migrations',
  schema: './packages/canonical-schema/src/drizzle/schema.ts',
  dbCredentials: {
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE ?? 'cortex',
    ssl: false,
  },
  migrations: {
    table: '__drizzle_migrations',
    schema: 'public',
  },
  verbose: true,
  strict: true,
});
