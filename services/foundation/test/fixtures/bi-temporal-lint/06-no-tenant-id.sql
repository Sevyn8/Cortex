-- Fixture: a global lookup table with no tenant_id column. PASSES lint —
-- not subject to the bi-temporal rule (rule applies to tenant-scoped tables).

CREATE TABLE country_code (
  code        text  PRIMARY KEY,
  iso_alpha_3 text  NOT NULL,
  display     text  NOT NULL
);
