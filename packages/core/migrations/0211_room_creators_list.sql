-- SPDX-License-Identifier: AGPL-3.0-only
-- forced RLS would hide every row from the owner here
alter table person no force row level security;
alter table site_settings no force row level security;

update person p
   set can_create_rooms = false
  from site_settings s
 where s.tenant_id = p.tenant_id and s.room_creation = 'site_admins' and p.can_create_rooms;

-- domain rule -> explicit list
update person p
   set can_create_rooms = (s.org_domain is not null and lower(split_part(p.email, '@', 2)) = s.org_domain
                           and p.erased_at is null and not p.is_site_admin)
  from site_settings s
 where s.tenant_id = p.tenant_id and s.room_creation = 'domain';

alter table person force row level security;
alter table site_settings force row level security;

create or replace function person_can_create_rooms(p_person uuid) returns boolean language sql stable
set search_path = public, pg_temp as $$
  select coalesce((
    select p.disabled_at is null and p.erased_at is null and (p.is_site_admin or p.can_create_rooms)
      from public.person p
     where p.id = p_person), false)
$$;

alter table site_settings drop column room_creation;
