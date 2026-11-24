-- SPDX-License-Identifier: AGPL-3.0-only
-- see-as previews a preparing room as open (preview rows never commit)
create or replace function workspace_state_at(p_workspace uuid, p_at timestamptz, p_known_at timestamptz default null)
returns text language sql stable set search_path = public, pg_temp as $$
  select case
           when s.state = 'preparing' and exists (select 1 from public.see_as_preview sp where sp.workspace_id = p_workspace)
             then 'open'
           else s.state
         end
    from (select coalesce(
            (select h.state from public.workspace_state_history h
              where h.workspace_id = p_workspace and h.valid_from <= p_at and h.recorded_at <= coalesce(p_known_at, p_at)
              order by h.valid_from desc, h.id desc limit 1),
            (select w.state from public.workspace w where w.id = p_workspace)) as state) s
$$;
