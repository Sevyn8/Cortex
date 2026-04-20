-- Enable pgvector on the cortex_dev database. Bi-temporal helpers,
-- RLS baseline, audit scaffolding land in P0.4 via real migrations.
CREATE EXTENSION IF NOT EXISTS vector;
