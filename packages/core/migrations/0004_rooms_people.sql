-- SPDX-License-Identifier: AGPL-3.0-only

-- token stored as SHA-256 only
create table invitation (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  workspace_id      uuid not null references workspace(id),
  group_id          uuid not null references groups(id),
  person_id         uuid not null references person(id),
  membership_id     uuid not null references membership(id),
  invited_by        uuid references person(id),
  message           text,
  token_sha256      text not null unique,
  status            text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at        timestamptz not null,            -- link stops working
  access_expires_at timestamptz,                     -- access ends (membership valid_to)
  created_at        timestamptz not null default now(),
  accepted_at       timestamptz
);
create index invitation_workspace on invitation (workspace_id, status);

create table approval (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  workspace_id  uuid not null references workspace(id),
  kind          text not null check (kind in ('colleague_request', 'agent_action', 'other')),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  requested_by  uuid not null references person(id),
  group_id      uuid references groups(id),
  payload       jsonb not null default '{}',
  decided_by    uuid references person(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);
create index approval_pending on approval (workspace_id, status, created_at);

create table milestone (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenant(id),
  workspace_id          uuid not null references workspace(id),
  title                 text not null,
  due_at                timestamptz not null,
  visible_to_group_ids  uuid[] not null default '{}',   -- empty = every group
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create index milestone_due on milestone (workspace_id, due_at) where deleted_at is null;

create table workspace_visit (
  tenant_id          uuid not null references tenant(id),
  workspace_id       uuid not null references workspace(id),
  person_id          uuid not null references person(id),
  last_visit_at      timestamptz not null,
  previous_visit_at  timestamptz,
  primary key (workspace_id, person_id)
);

alter table person add column can_create_rooms boolean not null default false;

do $$
declare t text;
begin
  foreach t in array array['invitation', 'approval', 'milestone', 'workspace_visit'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
    execute format('grant select, insert, update on %I to vdrkit_app', t);
  end loop;
end $$;
