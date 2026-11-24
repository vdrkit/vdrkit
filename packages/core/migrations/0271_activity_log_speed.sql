-- SPDX-License-Identifier: AGPL-3.0-only
create index event_workspace_seq on event (workspace_id, seq);
create index event_actor on event (actor_id) where actor_id is not null;
-- must match the API's person filter expression
create index event_data_person on event ((lower(coalesce(data ->> 'person_id', data ->> 'personId'))));

-- default estimate (1000) triggered JIT on log counts
alter function node_at(uuid, timestamptz, timestamptz) rows 1;
