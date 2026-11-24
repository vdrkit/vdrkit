-- SPDX-License-Identifier: AGPL-3.0-only
alter table document_version add column processing_started_at timestamptz;

create policy stuck_processing_listing on document_version for select
  using (current_setting('vdrkit.stuck_processing_listing', true) = 'on');
do $$ begin
  execute format('alter policy stuck_processing_listing on document_version to %I', current_user);
end $$;

create function tenants_with_stuck_processing(p_before timestamptz)
returns setof uuid language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  prior text := coalesce(current_setting('vdrkit.stuck_processing_listing', true), '');
begin
  perform set_config('vdrkit.stuck_processing_listing', 'on', true);
  return query
    select distinct v.tenant_id from document_version v
     where v.processing_status = 'processing' and coalesce(v.processing_started_at, v.created_at) < p_before
     order by v.tenant_id;
  perform set_config('vdrkit.stuck_processing_listing', prior, true);
end $$;

revoke all on function tenants_with_stuck_processing(timestamptz) from public;
grant execute on function tenants_with_stuck_processing(timestamptz) to vdrkit_app;
