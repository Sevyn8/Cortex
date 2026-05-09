-- Fixture: tenant-scoped table missing valid_time + txn_time. FAILS lint.

CREATE TABLE retail_product (
  id           uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid     NOT NULL,
  business_key text     NOT NULL,
  name         text     NOT NULL
);
