-- SPDX-License-Identifier: AGPL-3.0-only
-- planned number, so a failed upload does not renumber the rest

alter table upload_session
  add column planned_number int;

alter table upload_session
  add constraint upload_session_planned_number check (planned_number is null or planned_number between 1 and 99999);
