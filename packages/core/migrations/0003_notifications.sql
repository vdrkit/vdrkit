-- SPDX-License-Identifier: AGPL-3.0-only

create table notification_policy (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  workspace_id   uuid not null references workspace(id),
  scope          text not null check (scope in ('workspace', 'group', 'user')),
  group_id       uuid references groups(id),
  person_id      uuid references person(id),
  category       text not null,
  mode           text check (mode in ('immediate', 'bundled', 'digest', 'off')),
  digest_times   text[],
  allowed_modes  text[],
  mandatory      boolean not null default false,
  check ((scope = 'workspace' and group_id is null and person_id is null)
      or (scope = 'group' and group_id is not null and person_id is null)
      or (scope = 'user' and person_id is not null and group_id is null)),
  check (scope = 'workspace' or not mandatory),
  check (scope <> 'workspace' or mode is not null)
);
create unique index notification_policy_one on notification_policy
  (workspace_id, scope, coalesce(group_id, person_id, workspace_id), category);

create table notification (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  workspace_id     uuid not null references workspace(id),
  person_id        uuid not null references person(id),
  category         text not null,
  mode             text not null check (mode in ('immediate', 'bundled', 'digest')),
  mandatory        boolean not null default false,
  status           text not null default 'open' check (status in ('open', 'sent', 'dropped', 'failed')),
  first_event_at   timestamptz not null,
  last_event_at    timestamptz not null,
  due_at           timestamptz not null,
  sent_at          timestamptz,
  channel          text,
  delivery_status  text,
  provider_message_id text,
  created_at       timestamptz not null default now()
);
create index notification_due on notification (due_at) where status = 'open';
create unique index notification_open_one on notification (person_id, workspace_id, category, mode) where status = 'open';

create table notification_item (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  notification_id  uuid not null references notification(id),
  event_id         uuid not null,
  action           text not null,
  node_id          uuid references node(id),
  occurred_at      timestamptz not null,
  dropped_reason   text
);
create index notification_item_parent on notification_item (notification_id);

do $$
declare t text;
begin
  foreach t in array array['notification_policy', 'notification', 'notification_item'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
    execute format('grant select, insert, update on %I to vdrkit_app', t);
  end loop;
end $$;
