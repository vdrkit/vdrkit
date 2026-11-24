-- SPDX-License-Identifier: AGPL-3.0-only
-- NDA version name and publisher (null on old rows)

alter table agreement_version add column name text check (name is null or length(btrim(name)) between 1 and 120);
alter table agreement_version add column published_by uuid references person(id);
