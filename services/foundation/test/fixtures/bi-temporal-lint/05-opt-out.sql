-- Fixture: tenant-scoped bookkeeping table opted out via directive. PASSES lint.

-- @bi-temporal: skip
CREATE TABLE tenant_metric_counter (
  id          uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid       NOT NULL,
  metric_name text       NOT NULL,
  count       bigint     NOT NULL DEFAULT 0
);
