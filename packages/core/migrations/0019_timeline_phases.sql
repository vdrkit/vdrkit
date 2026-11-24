-- SPDX-License-Identifier: AGPL-3.0-only
-- phase = the milestone ending it; phases are visible to every group

alter table milestone
  add column phase_name      text,
  add column phase_starts_on date;

alter table milestone
  add constraint milestone_phase_name check (phase_name is null or length(btrim(phase_name)) between 1 and 120),
  add constraint milestone_phase_start check (phase_starts_on is null or phase_name is not null),
  add constraint milestone_phase_for_all check (phase_name is null or cardinality(visible_to_group_ids) = 0);
