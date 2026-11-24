-- SPDX-License-Identifier: AGPL-3.0-only
-- code_sha256 is salted with id
create table email_change (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  person_id      uuid not null references person(id) on delete cascade,
  old_email      text not null,
  new_email      text not null check (new_email = lower(new_email) and length(new_email) between 3 and 320),
  token_sha256   text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  code_sha256    text not null check (code_sha256 ~ '^[0-9a-f]{64}$'),
  -- null: site admin
  workspace_id   uuid references workspace(id),
  requested_by   uuid not null references person(id),
  requested_at   timestamptz not null,
  expires_at     timestamptz not null,
  wrong_codes    smallint not null default 0 check (wrong_codes between 0 and 5),
  status         text not null default 'pending' check (status in ('pending', 'confirmed', 'replaced', 'expired', 'locked')),
  closed_at      timestamptz,
  check ((status = 'pending') = (closed_at is null))
);
create index email_change_person on email_change (person_id) where status = 'pending';
create index email_change_new_email on email_change (tenant_id, new_email) where status = 'pending';

alter table email_change enable row level security;
alter table email_change force row level security;
create policy tenant_isolation on email_change using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on email_change to vdrkit_app;

-- erasure
create or replace function email_change_follow_erasure() returns trigger language plpgsql as $$
begin
  if new.erased_at is not null and old.erased_at is null then
    delete from email_change where person_id = new.id;
  end if;
  return new;
end $$;
create trigger email_change_follow_erasure after update of erased_at on person
  for each row execute function email_change_follow_erasure();
grant delete on email_change to vdrkit_app;
