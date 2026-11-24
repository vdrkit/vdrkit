-- SPDX-License-Identifier: AGPL-3.0-only
-- display only

alter table groups add column organisation text;

alter table groups
  add constraint groups_organisation_length check (organisation is null or length(btrim(organisation)) between 1 and 200);
