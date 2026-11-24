-- SPDX-License-Identifier: AGPL-3.0-only
-- claim commits before the email leaves; stale claims fail, never resent
alter table notification drop constraint notification_status_check;
alter table notification add constraint notification_status_check check (status in ('open', 'sending', 'sent', 'dropped', 'failed'));
alter table notification add column claimed_at timestamptz;
create index notification_sending on notification (claimed_at) where status = 'sending';

alter table milestone add column due_set_at timestamptz;
-- forced RLS would hide every row from the owner here
alter table milestone no force row level security;
update milestone set due_set_at = created_at;
alter table milestone force row level security;
alter table milestone alter column due_set_at set not null;

-- only due_at changes reset reminders
create function milestone_due_set() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.due_set_at := coalesce(new.updated_at, new.created_at, now());
  elsif new.due_at is distinct from old.due_at then
    new.due_set_at := coalesce(new.updated_at, now());
  else
    new.due_set_at := old.due_set_at;
  end if;
  return new;
end $$;
create trigger milestone_due_set before insert or update on milestone for each row execute function milestone_due_set();

-- unique key = claim
create table deadline_reminder (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  workspace_id        uuid not null references workspace(id),
  milestone_id        uuid not null references milestone(id),
  person_id           uuid not null references person(id),
  kind                text not null check (kind in ('2d', '2h')),
  due_at              timestamptz not null,
  status              text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'dropped')),
  claimed_at          timestamptz not null,
  sent_at             timestamptz,
  channel             text,
  delivery_status     text,
  provider_message_id text,
  dropped_reason      text,
  unique (milestone_id, person_id, kind, due_at)
);
create index deadline_reminder_sending on deadline_reminder (claimed_at) where status = 'sending';

alter table deadline_reminder enable row level security;
alter table deadline_reminder force row level security;
create policy tenant_isolation on deadline_reminder using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on deadline_reminder to vdrkit_app;

-- owner only, while tenants_with_due_reminders() runs
create policy due_reminder_listing on milestone for select
  using (current_setting('vdrkit.due_reminder_listing', true) = 'on');
do $$ begin
  execute format('alter policy due_reminder_listing on milestone to %I', current_user);
end $$;

create function tenants_with_due_reminders(p_now timestamptz default now())
returns setof uuid language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  prior text := coalesce(current_setting('vdrkit.due_reminder_listing', true), '');
begin
  perform set_config('vdrkit.due_reminder_listing', 'on', true);
  return query
    select distinct m.tenant_id from milestone m
     where m.deleted_at is null and m.due_at > p_now and m.due_at - interval '2 days' <= p_now
     order by m.tenant_id;
  perform set_config('vdrkit.due_reminder_listing', prior, true);
end $$;

revoke all on function tenants_with_due_reminders(timestamptz) from public;
grant execute on function tenants_with_due_reminders(timestamptz) to vdrkit_app;

-- + stale claims
create or replace function tenants_with_due_notifications(p_now timestamptz default now())
returns setof uuid language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  prior text := coalesce(current_setting('vdrkit.due_tenant_listing', true), '');
begin
  perform set_config('vdrkit.due_tenant_listing', 'on', true);
  return query
    select distinct n.tenant_id from notification n
     where (n.status = 'open' and n.due_at <= p_now)
        or (n.status = 'sending' and n.claimed_at <= p_now - interval '15 minutes')
     order by n.tenant_id;
  perform set_config('vdrkit.due_tenant_listing', prior, true);
end $$;
