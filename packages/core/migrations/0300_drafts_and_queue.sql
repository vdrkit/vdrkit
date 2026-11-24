-- SPDX-License-Identifier: AGPL-3.0-only
alter table document_version add column queued_at timestamptz;
-- "Publish now" while processing; worker rechecks rules
alter table document_version add column publish_when_ready jsonb;

create function tenants_with_stuck_versions(p_processing_before timestamptz, p_pending_before timestamptz)
returns setof uuid language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  prior text := coalesce(current_setting('vdrkit.stuck_processing_listing', true), '');
begin
  perform set_config('vdrkit.stuck_processing_listing', 'on', true);
  return query
    select distinct v.tenant_id from document_version v
     where (v.processing_status = 'processing' and coalesce(v.processing_started_at, v.created_at) < p_processing_before)
        or (v.processing_status = 'pending' and coalesce(v.queued_at, v.created_at) < p_pending_before)
     order by v.tenant_id;
  perform set_config('vdrkit.stuck_processing_listing', prior, true);
end $$;

revoke all on function tenants_with_stuck_versions(timestamptz, timestamptz) from public;
grant execute on function tenants_with_stuck_versions(timestamptz, timestamptz) to vdrkit_app;

-- caller deletes the bytes after commit. No delete grant on these tables
create function forget_removed_draft_files(p_version uuid)
returns setof text language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  v document_version%rowtype;
begin
  select * into v from document_version where id = p_version and tenant_id = current_tenant_id();
  if not found then return; end if;
  if v.released_at is not null or v.withdrawn_at is null or not coalesce((v.metadata ->> 'removed_draft')::boolean, false) then
    raise exception 'Only a removed draft that was never released loses its files';
  end if;
  delete from document_text where version_id = p_version;
  return query delete from derived_file where version_id = p_version returning storage_key;
end $$;

revoke all on function forget_removed_draft_files(uuid) from public;
grant execute on function forget_removed_draft_files(uuid) to vdrkit_app;
