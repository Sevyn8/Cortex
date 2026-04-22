// Per-service Drizzle schemas live in each service (services/<svc>/src/schema/).
// This barrel exists so drizzle-kit's config has a stable `schema:` pointer
// even before any service contributes schemas. Re-exports nothing in Phase B.
export {};
