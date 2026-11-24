-- SPDX-License-Identifier: AGPL-3.0-only
-- forced RLS would hide every row from the owner here
alter table derived_file no force row level security;

do $$
declare
  n bigint;
begin
  select count(*) into n from (
    select 1 from derived_file group by version_id, storage_key having count(*) > 1) d;
  if n > 0 then
    raise exception '% versions have the same derived file recorded more than once. Process those versions again, or remove the extra derived_file rows by hand, then run the migration again.', n;
  end if;
end $$;

create unique index derived_file_one_set on derived_file (version_id, storage_key);

alter table derived_file force row level security;

-- security definer: the app role has no delete grant here
create function forget_derived_files(p_version uuid)
returns void language plpgsql volatile security definer
set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from document_version where id = p_version and tenant_id = current_tenant_id() and processing_status = 'processing') then
    raise exception 'Only a version that is being processed loses its derived files';
  end if;
  delete from document_text where version_id = p_version;
  delete from derived_file where version_id = p_version;
end $$;

revoke all on function forget_derived_files(uuid) from public;
grant execute on function forget_derived_files(uuid) to vdrkit_app;
