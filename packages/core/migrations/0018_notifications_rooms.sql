-- SPDX-License-Identifier: AGPL-3.0-only
-- null = inherit

alter table notification_policy add column enabled boolean;

-- forced RLS would hide every row from the owner here
alter table notification_policy no force row level security;

update notification_policy set enabled = case when mandatory then true else false end,
                               mode = case when scope = 'workspace' then 'immediate' end
 where mode = 'off';

insert into notification_policy (tenant_id, workspace_id, scope, group_id, person_id, category, enabled, mode, digest_times, allowed_modes, mandatory)
select d.tenant_id, d.workspace_id, d.scope, d.group_id, d.person_id, 'versions', d.enabled, d.mode, d.digest_times, d.allowed_modes, d.mandatory
  from notification_policy d
 where d.category = 'documents'
   and not exists (select 1 from notification_policy v
                    where v.workspace_id = d.workspace_id and v.scope = d.scope and v.category = 'versions'
                      and coalesce(v.group_id, v.person_id, v.workspace_id) = coalesce(d.group_id, d.person_id, d.workspace_id));

alter table notification_policy add constraint notification_policy_mode_is_frequency check (mode is distinct from 'off');
alter table notification_policy add constraint notification_policy_mandatory_is_on check (not mandatory or coalesce(enabled, true));
alter table notification_policy force row level security;

create table notification_room_setting (
  workspace_id          uuid primary key references workspace(id),
  tenant_id             uuid not null references tenant(id),
  bundle_quiet_minutes  integer not null default 10 check (bundle_quiet_minutes between 1 and 60),
  bundle_max_minutes    integer not null default 60 check (bundle_max_minutes between 10 and 240),
  -- "HH:MM", recipient time zone
  summary_times         text[] not null default '{08:00}'
    check (array_to_string(summary_times, ',') ~ '^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])?$'),
  updated_at            timestamptz not null default now(),
  check (bundle_max_minutes >= bundle_quiet_minutes)
);

create function activity_reader(p_person uuid, p_workspace uuid, p_at timestamptz)
returns text language sql stable set search_path = public, pg_temp as $$
  select case
    when public.is_workspace_admin(p_person, p_workspace, p_at) then 'admin'
    when exists (
      select 1 from public.membership m
        join public.groups gr on gr.id = m.group_id
        join public.party pa on pa.id = gr.party_id
       where m.person_id = p_person and gr.workspace_id = p_workspace
         and gr.role_template = 'observer' and pa.kind = 'seller' and m.status = 'active'
         and m.valid_from <= p_at and p_at < m.valid_to
         and m.recorded_at <= public.record_clock() and public.record_clock() < m.superseded_at
         and gr.valid_from <= p_at and p_at < gr.valid_to) then 'observer'
  end
$$;
grant execute on function activity_reader(uuid, uuid, timestamptz) to vdrkit_app;

-- don't redefine effective_level() here: older text would drop rules

create table workspace_logo (
  workspace_id  uuid not null references workspace(id),
  tenant_id     uuid not null references tenant(id),
  variant       text not null check (variant in ('light', 'dark')),
  content_type  text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml')),
  bytes         bytea not null check (octet_length(bytes) between 1 and 262144),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, variant)
);

alter table person add column open_at_sign_in_workspace_id uuid references workspace(id);

do $$
declare t text;
begin
  foreach t in array array['notification_room_setting', 'workspace_logo'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
    execute format('grant select, insert, update on %I to vdrkit_app', t);
  end loop;
end $$;

grant delete on workspace_logo to vdrkit_app;
