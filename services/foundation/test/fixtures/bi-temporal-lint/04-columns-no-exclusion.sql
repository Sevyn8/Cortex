-- Fixture: bi-temporal columns + trigger present but no business-key
-- exclusion constraint. FAILS lint.

CREATE TABLE retail_product (
  id            uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid       NOT NULL,
  business_key  text       NOT NULL,
  name          text       NOT NULL,
  valid_time    tstzrange  NOT NULL,
  txn_time      tstzrange  NOT NULL DEFAULT tstzrange(now(), NULL)
);

CREATE TRIGGER retail_product_scd
  BEFORE INSERT OR UPDATE OR DELETE ON retail_product
  FOR EACH ROW EXECUTE FUNCTION cortex.cortex_scd_trigger();

CREATE INDEX retail_product_temporal_gist
  ON retail_product
  USING gist (tenant_id, valid_time, txn_time);
