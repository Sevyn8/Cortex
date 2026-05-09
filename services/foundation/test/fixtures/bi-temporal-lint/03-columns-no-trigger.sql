-- Fixture: bi-temporal columns present but no SCD trigger attached. FAILS lint.

CREATE TABLE retail_product (
  id            uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid       NOT NULL,
  business_key  text       NOT NULL,
  name          text       NOT NULL,
  valid_time    tstzrange  NOT NULL,
  txn_time      tstzrange  NOT NULL DEFAULT tstzrange(now(), NULL)
);

ALTER TABLE retail_product
  ADD CONSTRAINT retail_product_business_key_no_overlap
  EXCLUDE USING gist (
    tenant_id    WITH =,
    business_key WITH =,
    valid_time   WITH &&
  ) WHERE (upper(txn_time) IS NULL);

CREATE INDEX retail_product_temporal_gist
  ON retail_product
  USING gist (tenant_id, valid_time, txn_time);
