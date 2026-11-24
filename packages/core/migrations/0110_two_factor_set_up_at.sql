-- SPDX-License-Identifier: AGPL-3.0-only
-- Better Auth stores no set-up date

alter table auth_two_factor add column set_up_at timestamptz;
alter table auth_two_factor alter column set_up_at set default record_clock();

-- flag flips after the first valid code
create function auth_two_factor_mark_set_up() returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  if new.two_factor_enabled and not coalesce(old.two_factor_enabled, false) then
    update auth_two_factor set set_up_at = record_clock() where user_id = new.id;
  end if;
  return new;
end $$;

create trigger auth_user_two_factor_set_up
  after update of two_factor_enabled on auth_user
  for each row execute function auth_two_factor_mark_set_up();
