-- SPDX-License-Identifier: AGPL-3.0-only
-- shared across API instances

-- keys hashed (IPs, person ids). No RLS: no tenant data, app role uses the functions
create table rate_limit_counter (
  key_hash       bytea primary key,
  hits           integer not null,
  window_ends_at timestamptz not null
);
create index rate_limit_counter_window_ends_at on rate_limit_counter (window_ends_at);
revoke all on rate_limit_counter from public;

-- db clock, not the caller's
create function rate_limit_hit(p_key text, p_window_ms integer)
returns table (hits integer, ttl_ms integer) language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  t timestamptz := clock_timestamp();
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 1000 then
    raise exception 'rate_limit_hit: the key must be 1 to 1000 characters';
  end if;
  if p_window_ms is null or p_window_ms < 1 or p_window_ms > 86400000 then
    raise exception 'rate_limit_hit: the window must be between 1 ms and one day';
  end if;
  return query
    insert into rate_limit_counter as c (key_hash, hits, window_ends_at)
    values (sha256(convert_to(p_key, 'UTF8')), 1, t + make_interval(secs => p_window_ms / 1000.0))
    on conflict (key_hash) do update
       set hits = case when c.window_ends_at <= t then 1 else c.hits + 1 end,
           window_ends_at = case when c.window_ends_at <= t then excluded.window_ends_at else c.window_ends_at end
    returning c.hits, greatest(0, ceil(extract(epoch from (c.window_ends_at - t)) * 1000))::integer;
end $$;

create function purge_rate_limits()
returns integer language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  n integer;
begin
  delete from rate_limit_counter where window_ends_at < clock_timestamp() - interval '1 minute';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function rate_limit_hit(text, integer) from public;
revoke all on function purge_rate_limits() from public;
grant execute on function rate_limit_hit(text, integer) to vdrkit_app;
grant execute on function purge_rate_limits() to vdrkit_app;
