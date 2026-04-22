import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Tests connect to Cloud SQL dev via cloud-sql-proxy; serialize
    // to avoid contention and chain-fork noise during audit tests.
    sequence: { concurrent: false },
  },
});
