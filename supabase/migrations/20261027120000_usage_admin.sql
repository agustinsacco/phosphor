-- Anonymous usage counters, the single administrator and account deletion.
--
-- No usage row describes an install, a person or an address. Each is a counter
-- keyed by a UTC day and coarse release facts; the server adds to it and keeps
-- nothing else. Neither usage table references a user.

create table public.usage_daily (
  day date not null,
  product text not null check (product in ('desktop', 'host')),
  version text not null check (version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  os text not null check (os in ('linux', 'darwin', 'win32')),
  arch text not null check (arch in ('x64', 'arm64')),
  -- Every accepted ping: installs active that day.
  pings bigint not null default 0 check (pings >= 0),
  -- First pings ever: new installs.
  firsts bigint not null default 0 check (firsts >= 0),
  -- First pings in an ISO week or calendar month: summed over the period, active installs.
  weeks bigint not null default 0 check (weeks >= 0),
  months bigint not null default 0 check (months >= 0),
  primary key (day, product, version, os, arch)
);
create table public.usage_downloads (
  day date not null,
  artifact text not null check (artifact in ('latest', 'install-sh')),
  downloads bigint not null default 0 check (downloads >= 0),
  primary key (day, artifact)
);
alter table public.usage_daily enable row level security;
alter table public.usage_downloads enable row level security;
revoke all on public.usage_daily, public.usage_downloads from public, anon, authenticated, service_role;
grant select, insert, update on public.usage_daily, public.usage_downloads to service_role;

-- The one administrator, by GitHub's numeric account id. GitHub never changes or
-- reuses it, unlike a login, and Supabase writes it to auth.identities only through
-- a completed GitHub sign-in; user_metadata, which a user can edit, is never read.
-- The check admits exactly one value, so adding anyone else takes a reviewed
-- migration. The table starts empty: an operator inserts the row by hand on the
-- hosted project, and deleting it revokes admin at once. No API role can read or
-- write it; only control_admin_check, below, reads it.
create table control_private.admins (
  github_id text primary key check (github_id = '5874561'),
  created_at timestamptz not null default pg_catalog.now()
);
alter table control_private.admins enable row level security;
revoke all on control_private.admins from public, anon, authenticated, service_role;

create function public.control_usage_ping(p_product text, p_version text, p_os text, p_arch text,
  p_first boolean, p_new_week boolean, p_new_month boolean) returns jsonb
language sql security invoker set search_path = '' as $$
  -- A first ping is also the first of its week and month.
  insert into public.usage_daily as u (day, product, version, os, arch, pings, firsts, weeks, months)
  values ((pg_catalog.now() at time zone 'UTC')::date, p_product, p_version, p_os, p_arch, 1,
    p_first::int, (p_first or p_new_week)::int, (p_first or p_new_month)::int)
  on conflict (day, product, version, os, arch) do update set
    pings = u.pings + 1, firsts = u.firsts + excluded.firsts,
    weeks = u.weeks + excluded.weeks, months = u.months + excluded.months
  returning '{"outcome":"counted"}'::jsonb;
$$;

create function public.control_usage_download(p_artifact text) returns jsonb
language sql security invoker set search_path = '' as $$
  insert into public.usage_downloads as d (day, artifact, downloads)
  values ((pg_catalog.now() at time zone 'UTC')::date, p_artifact, 1)
  on conflict (day, artifact) do update set downloads = d.downloads + 1
  returning '{"outcome":"counted"}'::jsonb;
$$;

-- service_role cannot read auth.identities or the admins table. This one fixed
-- query runs as the migration owner; only service_role may call it. It returns
-- true only when the admins row matches the caller's constant and the user holds
-- that GitHub identity.
create function public.control_admin_check(p_user_id uuid, p_github_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from control_private.admins a
      join auth.identities i on i.provider = 'github' and i.provider_id = a.github_id
    where a.github_id = p_github_id and i.user_id = p_user_id);
$$;

-- Aggregates only: no user, login, machine label or hostname leaves this function.
-- Version and platform cells under three are returned as null.
create function public.control_admin_stats() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.now();
  -- Plain timestamps, so no period bound depends on the session's time zone.
  v_today date := (pg_catalog.now() at time zone 'UTC')::date;
  v_week date := pg_catalog.date_trunc('week', v_today::timestamp)::date;
  v_month date := pg_catalog.date_trunc('month', v_today::timestamp)::date;
  v_last_month date := (v_month::timestamp - interval '1 month')::date;
  v_usage jsonb := '{}'::jsonb;
  v_product text;
  v_result jsonb;
begin
  foreach v_product in array array['desktop', 'host'] loop
    v_usage := v_usage || pg_catalog.jsonb_build_object(v_product, (
      select pg_catalog.jsonb_build_object(
        'day', coalesce(sum(u.pings) filter (where u.day = v_today - 1), 0),
        'week', coalesce(sum(u.weeks) filter (where u.day >= v_week), 0),
        'lastWeek', coalesce(sum(u.weeks) filter (where u.day >= v_week - 7 and u.day < v_week), 0),
        'month', coalesce(sum(u.months) filter (where u.day >= v_month), 0),
        'lastMonth', coalesce(sum(u.months) filter (where u.day >= v_last_month and u.day < v_month), 0),
        'new7d', coalesce(sum(u.firsts) filter (where u.day > v_today - 7), 0),
        'new30d', coalesce(sum(u.firsts) filter (where u.day > v_today - 30), 0))
      from public.usage_daily u
      where u.product = v_product and u.day >= least(v_last_month, v_week - 7, v_today - 30)));
  end loop;

  select pg_catalog.jsonb_build_object(
    'generatedAt', control_private.iso(v_now),
    'accounts', (select pg_catalog.jsonb_build_object(
      'total', count(*),
      'new7d', count(*) filter (where a.created_at > v_now - interval '7 days'),
      'new30d', count(*) filter (where a.created_at > v_now - interval '30 days'))
      from public.remote_access_accounts a),
    'hosts', (select pg_catalog.jsonb_build_object(
      'enrolled', count(*),
      'online', count(*) filter (where h.last_seen_at > v_now - interval '90 seconds'
        and h.state = 'running'),
      'seen24h', count(*) filter (where h.last_seen_at > v_now - interval '1 day'))
      from public.remote_hosts h where h.revoked_at is null),
    'downloads', (select pg_catalog.jsonb_build_object(
      'last7d', coalesce(sum(d.downloads) filter (where d.day > v_today - 7), 0),
      'last30d', coalesce(sum(d.downloads) filter (where d.day > v_today - 30), 0),
      'total', coalesce(sum(d.downloads), 0),
      'byArtifact30d', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'artifact', x.artifact, 'downloads', x.n) order by x.n desc, x.artifact)
        from (select artifact, sum(downloads) as n from public.usage_downloads
          where day > v_today - 30 group by artifact) x), '[]'::jsonb))
      from public.usage_downloads d),
    'usage', v_usage,
    'series', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'day', pg_catalog.to_char(g.day, 'YYYY-MM-DD'),
        'desktop', coalesce(u.desktop, 0), 'host', coalesce(u.host, 0),
        'installs', coalesce(u.installs, 0), 'downloads', coalesce(d.downloads, 0)) order by g.day)
      from (select v_today - n as day from pg_catalog.generate_series(0, 89) n) g
      left join (select day, sum(pings) filter (where product = 'desktop') as desktop,
          sum(pings) filter (where product = 'host') as host, sum(firsts) as installs
        from public.usage_daily where day > v_today - 90 group by day) u on u.day = g.day
      left join (select day, sum(downloads) as downloads from public.usage_downloads
        where day > v_today - 90 group by day) d on d.day = g.day),
    'versions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'product', v.product, 'version', v.version, 'pings', case when v.n < 3 then null else v.n end)
        order by case when v.n < 3 then 0 else v.n end desc, v.product, v.version)
      from (select product, version, sum(pings) as n from public.usage_daily
        where day > v_today - 7 group by product, version
        order by sum(pings) desc, product, version limit 40) v), '[]'::jsonb),
    'platforms', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'product', p.product, 'os', p.os, 'arch', p.arch,
        'pings', case when p.n < 3 then null else p.n end)
        order by case when p.n < 3 then 0 else p.n end desc, p.product, p.os, p.arch)
      from (select product, os, arch, sum(pings) as n from public.usage_daily
        where day > v_today - 7 group by product, os, arch
        order by sum(pings) desc, product, os, arch limit 40) p), '[]'::jsonb))
  into v_result;
  return v_result;
end;
$$;

-- service_role cannot delete from auth.users on Supabase. This one fixed statement
-- runs as the migration owner; only service_role may call it, and the server passes
-- only the caller's own verified id. Every directory table references auth.users
-- with on delete cascade, so the account row, Hosts, clients, enrollments, grant
-- sessions and audit events go with it, as do Supabase's own identities and
-- sessions. The usage counters hold no user reference and are untouched.
create function public.control_account_delete(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  delete from auth.users where id = p_user_id;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  return '{"outcome":"deleted"}'::jsonb;
end;
$$;

revoke all on function public.control_usage_ping(text, text, text, text, boolean, boolean, boolean),
  public.control_usage_download(text), public.control_admin_check(uuid, text),
  public.control_admin_stats(), public.control_account_delete(uuid)
  from public, anon, authenticated;
grant execute on function public.control_usage_ping(text, text, text, text, boolean, boolean, boolean),
  public.control_usage_download(text), public.control_admin_check(uuid, text),
  public.control_admin_stats(), public.control_account_delete(uuid)
  to service_role;
