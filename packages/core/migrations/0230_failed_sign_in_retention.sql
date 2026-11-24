-- SPDX-License-Identifier: AGPL-3.0-only
-- purge old failed sign-ins (keeps the event)

-- owner only, while purge_failed_sign_ins() runs
create policy failed_sign_in_purge on event for select
  using (current_setting('vdrkit.sign_in_purge', true) = 'on');
create policy failed_sign_in_purge_read on event_context for select
  using (current_setting('vdrkit.sign_in_purge', true) = 'on');
create policy failed_sign_in_purge on event_context for delete
  using (current_setting('vdrkit.sign_in_purge', true) = 'on');
do $$ begin
  execute format('alter policy failed_sign_in_purge on event to %I', current_user);
  execute format('alter policy failed_sign_in_purge_read on event_context to %I', current_user);
  execute format('alter policy failed_sign_in_purge on event_context to %I', current_user);
end $$;

create function purge_failed_sign_ins(p_before timestamptz)
returns integer language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  prior text := coalesce(current_setting('vdrkit.sign_in_purge', true), '');
  n integer;
begin
  perform set_config('vdrkit.sign_in_purge', 'on', true);
  delete from event_context ec
   using event e
   where e.id = ec.event_id and e.occurred_at = ec.occurred_at
     and e.action = 'auth.sign_in_failed' and e.workspace_id is null
     and ec.occurred_at < p_before;
  get diagnostics n = row_count;
  perform set_config('vdrkit.sign_in_purge', prior, true);
  return n;
end $$;

revoke all on function purge_failed_sign_ins(timestamptz) from public;
grant execute on function purge_failed_sign_ins(timestamptz) to vdrkit_app;
