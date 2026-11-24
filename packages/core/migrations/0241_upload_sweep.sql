-- SPDX-License-Identifier: AGPL-3.0-only
-- quarantine copies are unencrypted; local disk has no lifecycle rule

alter table upload_session drop constraint upload_session_status_check;
alter table upload_session add constraint upload_session_status_check
  check (status in ('open', 'completed', 'rejected', 'aborted', 'expired'));

create policy expired_upload_listing on upload_session for select
  using (current_setting('vdrkit.expired_upload_listing', true) = 'on');
do $$ begin
  execute format('alter policy expired_upload_listing on upload_session to %I', current_user);
end $$;

create function tenants_with_expired_uploads(p_before timestamptz)
returns setof uuid language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  prior text := coalesce(current_setting('vdrkit.expired_upload_listing', true), '');
begin
  perform set_config('vdrkit.expired_upload_listing', 'on', true);
  return query
    select distinct s.tenant_id from upload_session s
     where s.status = 'open' and s.expires_at < p_before
     order by s.tenant_id;
  perform set_config('vdrkit.expired_upload_listing', prior, true);
end $$;

revoke all on function tenants_with_expired_uploads(timestamptz) from public;
grant execute on function tenants_with_expired_uploads(timestamptz) to vdrkit_app;
