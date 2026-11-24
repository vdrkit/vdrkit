-- SPDX-License-Identifier: AGPL-3.0-only
alter table invitation add column waits_for_room boolean not null default false;
-- first send only
alter table invitation add column sent_at timestamptz;
-- forced RLS would hide every row from the owner here
alter table invitation no force row level security;
update invitation set sent_at = created_at;
alter table invitation force row level security;

create index invitation_waiting on invitation (workspace_id) where waits_for_room and status = 'pending';
