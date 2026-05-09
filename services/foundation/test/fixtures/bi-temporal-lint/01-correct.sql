-- Fixture: a correct bi-temporal tenant-scoped domain table. PASSES lint.

CREATE TABLE retail_product (
  id            uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid       NOT NULL,
  business_key  text       NOT NULL,
  name          text       NOT NULL,
  price_cents   integer    NOT NULL,
  valid_time    tstzrange  NOT NULL,
  txn_time      tstzrange  NOT NULL DEFAULT tstzrange(now(), NULL)
);

CREATE TRIGGER retail_product_scd
  BEFORE INSERT OR UPDATE OR DELETE ON retail_product
  FOR EACH ROW EXECUTE FUNCTION cortex.cortex_scd_trigger();

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

CREATE INDEX retail_product_tenant_current
  ON retail_product (tenant_id)
  WHERE upper(txn_time) IS NULL;
