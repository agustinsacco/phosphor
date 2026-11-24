-- Machine-to-machine reach. Identity metadata only: no lane ids, paths or tokens.
-- Additive: two columns, one table, five functions. No existing object changes, and the
-- v1 heartbeat, revocation and grant functions are untouched, so a failing new function
-- cannot take a Host offline.
alter table public.remote_hosts
  add column machine_reach boolean not null default true,
  add column machine_grants boolean;

-- A machine principal is the client id and session id of grants one machine holds for
-- its siblings. Its sid never enters remote_grant_sessions (it has no auth.sessions row,
-- so control_host_revocations would list it as revoked on every beat).
create table public.remote_machine_principals (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  sid uuid not null default pg_catalog.gen_random_uuid(),
  host_id uuid not null references public.remote_hosts(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz
);
create unique index remote_machine_principals_live_idx
  on public.remote_machine_principals(host_id) where revoked_at is null;
create index remote_machine_principals_owner_idx
  on public.remote_machine_principals(owner_id, revoked_at desc);
alter table public.remote_machine_principals enable row level security;
revoke all on public.remote_machine_principals from public, anon, authenticated;
grant select, insert, update, delete on public.remote_machine_principals to service_role;

-- Best effort after an accepted beat. Writes only when support changes, so it adds no
-- realtime event per beat. p_machine_grants is null for a Host that sent no field. A
-- machine removed through the v1 functions keeps revoked_at null on its principal, so
-- revocation always joins remote_hosts.
create function public.control_machine_beat(p_host uuid, p_machine_grants boolean) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_host public.remote_hosts;
begin
  select * into v_host from public.remote_hosts where id = p_host and revoked_at is null;
  if not found then return '{"outcome":"gone"}'::jsonb; end if;
  if v_host.machine_grants is distinct from p_machine_grants then
    update public.remote_hosts set machine_grants = p_machine_grants where id = p_host;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'ok', 'machineReach', v_host.machine_reach,
    'revoked', coalesce((select pg_catalog.jsonb_agg(r.id order by r.revoked_at desc, r.id) from (
      select p.id, coalesce(p.revoked_at, h.revoked_at) as revoked_at
        from public.remote_machine_principals p
        join public.remote_hosts h on h.id = p.host_id
        where p.owner_id = v_host.owner_id
          and coalesce(p.revoked_at, h.revoked_at) >= pg_catalog.now() - interval '10 minutes'
        order by 2 desc, p.id limit 40) r), '[]'::jsonb));
end;
$$;

create function public.control_machine_grant_issue(p_caller uuid, p_target uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid; v_enabled boolean; v_caller public.remote_hosts;
  v_target public.remote_hosts; v_principal public.remote_machine_principals;
begin
  if p_caller = p_target then return '{"outcome":"not-found"}'::jsonb; end if;
  select owner_id into v_owner from public.remote_hosts where id = p_caller and revoked_at is null;
  if not found then return '{"outcome":"gone"}'::jsonb; end if;
  -- Lock order: account, then rows, as registration, approval and grant issue.
  select enabled into v_enabled from public.remote_access_accounts where user_id = v_owner for update;
  if v_enabled is distinct from true then return '{"outcome":"account-disabled"}'::jsonb; end if;
  select * into v_caller from public.remote_hosts where id = p_caller and owner_id = v_owner
    and revoked_at is null for share;
  if not found then return '{"outcome":"gone"}'::jsonb; end if;
  select * into v_target from public.remote_hosts where id = p_target and owner_id = v_owner
    and revoked_at is null for share;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  if not v_caller.machine_reach or not v_target.machine_reach then
    return '{"outcome":"reach-off"}'::jsonb;
  end if;
  if v_target.machine_grants is not true or v_target.state is distinct from 'running'
    or v_target.endpoint is null or v_target.last_seen_at is null
    or v_target.last_seen_at < pg_catalog.now() - interval '90 seconds' then
    return '{"outcome":"target-unavailable"}'::jsonb;
  end if;
  -- Bounded cleanup of this owner's rows only, under the account lock held above, so two
  -- owners' issues never lock each other's rows.
  delete from public.remote_machine_principals where id in (
    select p.id from public.remote_machine_principals p
      join public.remote_hosts h on h.id = p.host_id
      where p.owner_id = v_owner
        and coalesce(p.revoked_at, h.revoked_at) < pg_catalog.now() - interval '1 day'
      order by p.id limit 100);
  select * into v_principal from public.remote_machine_principals
    where host_id = p_caller and revoked_at is null for update;
  if not found then
    -- A beat lists at most 40 principals revoked in the last ten minutes; live plus
    -- recently revoked stay within that, so the list never omits a revocation.
    if (select pg_catalog.count(*) from public.remote_machine_principals p
          join public.remote_hosts h on h.id = p.host_id
          where p.owner_id = v_owner
            and (coalesce(p.revoked_at, h.revoked_at) is null
              or coalesce(p.revoked_at, h.revoked_at) >= pg_catalog.now() - interval '10 minutes')) >= 40 then
      return '{"outcome":"too-many-requests"}'::jsonb;
    end if;
    insert into public.remote_machine_principals(host_id, owner_id) values (p_caller, v_owner)
      returning * into v_principal;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'issued', 'ownerId', v_owner,
    'epoch', v_target.epoch, 'publicKey', v_target.public_key, 'endpoint', v_target.endpoint,
    'sid', v_principal.sid, 'client',
    pg_catalog.jsonb_build_object('id', v_principal.id, 'label', v_caller.label));
end;
$$;

-- The caller's siblings: no hostname, key fingerprint or endpoint. With the caller's
-- reach off it lists none.
create function public.control_machine_directory(p_host uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_self public.remote_hosts; v_enabled boolean;
begin
  select * into v_self from public.remote_hosts where id = p_host and revoked_at is null;
  if not found then return '{"outcome":"gone"}'::jsonb; end if;
  select enabled into v_enabled from public.remote_access_accounts where user_id = v_self.owner_id;
  if v_enabled is distinct from true then return '{"outcome":"account-disabled"}'::jsonb; end if;
  return pg_catalog.jsonb_build_object('outcome', 'ok',
    'serverTime', control_private.iso(pg_catalog.now()),
    'self', pg_catalog.jsonb_build_object('id', v_self.id, 'label', v_self.label,
      'machineReach', v_self.machine_reach),
    'machines', case when not v_self.machine_reach then '[]'::jsonb else
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', h.id, 'label', h.label, 'hostVersion', h.host_version,
        'lastSeenAt', control_private.iso(h.last_seen_at), 'state', h.state,
        'readiness', h.readiness, 'machineGrants', coalesce(h.machine_grants, false),
        'machineReach', h.machine_reach, 'reachable', h.endpoint is not null) order by h.label, h.id)
        from public.remote_hosts h
        where h.owner_id = v_self.owner_id and h.revoked_at is null and h.id <> v_self.id),
        '[]'::jsonb) end);
end;
$$;

-- Switching reach off revokes the machine's principal, so its outbound grants are refused
-- by every target within one beat through the existing client revocation path.
create function public.control_machine_reach_set(p_user uuid, p_host uuid, p_enabled boolean) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.remote_access_accounts where user_id = p_user for update;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  update public.remote_hosts set machine_reach = p_enabled
    where id = p_host and owner_id = p_user and revoked_at is null;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  if not p_enabled then
    update public.remote_machine_principals set revoked_at = pg_catalog.now()
      where host_id = p_host and revoked_at is null;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'set', 'machineReach', p_enabled);
end;
$$;

create function public.control_machine_reach_list(p_user uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', h.id,
    'machineReach', h.machine_reach, 'machineGrants', coalesce(h.machine_grants, false))
    order by h.id), '[]'::jsonb)
    from public.remote_hosts h where h.owner_id = p_user and h.revoked_at is null;
$$;

revoke all on function public.control_machine_beat(uuid, boolean),
  public.control_machine_grant_issue(uuid, uuid), public.control_machine_directory(uuid),
  public.control_machine_reach_set(uuid, uuid, boolean), public.control_machine_reach_list(uuid)
  from public, anon, authenticated;
grant execute on function public.control_machine_beat(uuid, boolean),
  public.control_machine_grant_issue(uuid, uuid), public.control_machine_directory(uuid),
  public.control_machine_reach_set(uuid, uuid, boolean), public.control_machine_reach_list(uuid)
  to service_role;
