-- SPDX-License-Identifier: AGPL-3.0-only
-- tells a dead worker from a long document
alter table document_version add column processing_heartbeat_at timestamptz;

create function tenants_with_stuck_versions(p_silent_before timestamptz, p_started_before timestamptz, p_pending_before timestamptz)
returns setof uuid language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  prior text := coalesce(current_setting('vdrkit.stuck_processing_listing', true), '');
begin
  perform set_config('vdrkit.stuck_processing_listing', 'on', true);
  return query
    select distinct v.tenant_id from document_version v
     where (v.processing_status = 'processing'
            and (coalesce(v.processing_heartbeat_at, v.processing_started_at, v.created_at) < p_silent_before
                 or coalesce(v.processing_started_at, v.created_at) < p_started_before))
        or (v.processing_status = 'pending' and coalesce(v.queued_at, v.created_at) < p_pending_before)
     order by v.tenant_id;
  perform set_config('vdrkit.stuck_processing_listing', prior, true);
end $$;

revoke all on function tenants_with_stuck_versions(timestamptz, timestamptz, timestamptz) from public;
grant execute on function tenants_with_stuck_versions(timestamptz, timestamptz, timestamptz) to vdrkit_app;
