-- Metadata only. The control server is the only writer.
create schema control_private;
revoke all on schema control_private from public, anon, authenticated;
grant usage on schema control_private to service_role;

alter table public.remote_access_accounts
  alter column enabled set default true,
  add column login text check (login ~ '^[A-Za-z0-9-]{1,39}$'),
  add column updated_at timestamptz not null default pg_catalog.now();
alter table public.remote_hosts
  alter column endpoint drop not null,
  drop constraint remote_hosts_endpoint_check,
  drop constraint remote_hosts_label_check,
  add constraint remote_hosts_label_check check (
    pg_catalog.char_length(label) between 1 and 80 and label = pg_catalog.btrim(label)
    and label !~ U&'[\0001-\001F\007F-\009F\061C\200E-\200F\2028-\202E\2066-\2069]'),
  add constraint remote_hosts_endpoint_check check (
    endpoint is null or case
      when endpoint ~ '^https://[a-z0-9][a-z0-9.-]{0,252}(:[1-9][0-9]{0,4})?$'
      then coalesce(pg_catalog.substring(endpoint, ':([0-9]+)$')::int <= 65535, true)
      else false end),
  add column hostname text not null check (hostname ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$'),
  add column public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  add column key_fingerprint text not null check (key_fingerprint ~ '^[0-9a-f]{4}(-[0-9a-f]{4}){3}$'),
  add column platform text not null check (platform in ('linux', 'darwin', 'win32')),
  add column arch text not null check (arch in ('x64', 'arm64')),
  add column host_version text check (host_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}([-+][0-9A-Za-z.-]{1,64})?$'),
  add column state text check (state in ('running', 'stopping')),
  add column uptime_sec bigint check (uptime_sec between 0 and 316224000),
  add column readiness jsonb check (coalesce(
    pg_catalog.jsonb_typeof(readiness) = 'object' and pg_catalog.octet_length(readiness::text) < 1024
    and readiness ?& array['pi', 'claude', 'tailscale']
    and readiness - array['pi', 'claude', 'tailscale'] = '{}'::jsonb
    and readiness ->> 'pi' in ('ok', 'missing', 'outdated', 'unknown')
    and readiness ->> 'claude' in ('ok', 'missing', 'signed-out', 'unknown')
    and readiness ->> 'tailscale' in ('ok', 'missing', 'stopped', 'no-https', 'unknown'), false)
    or readiness is null),
  add column running_lanes int check (running_lanes between 0 and 10000),
  add column waiting_lanes int check (waiting_lanes between 0 and 10000),
  add column last_seq bigint not null default 0 check (last_seq between 0 and 9007199254740991),
  add column epoch int not null default 1 check (epoch >= 1),
  add constraint remote_hosts_lane_pair check ((running_lanes is null) = (waiting_lanes is null));
-- Canonical base64url checks make text uniqueness equivalent to key uniqueness.
create unique index remote_hosts_active_key_idx on public.remote_hosts(public_key) where revoked_at is null;

create table public.remote_enrollments (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  key_fingerprint text not null check (key_fingerprint ~ '^[0-9a-f]{4}(-[0-9a-f]{4}){3}$'),
  hostname text not null check (hostname ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$'),
  platform text not null check (platform in ('linux', 'darwin', 'win32')),
  arch text not null check (arch in ('x64', 'arm64')),
  host_version text not null check (host_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}([-+][0-9A-Za-z.-]{1,64})?$'),
  status text not null default 'pending' check (status in ('pending', 'approved')),
  owner_id uuid references auth.users(id) on delete cascade,
  host_id uuid references public.remote_hosts(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null default (pg_catalog.now() + interval '600 seconds'),
  approved_at timestamptz,
  check ((status = 'pending' and owner_id is null and host_id is null and approved_at is null)
    or (status = 'approved' and owner_id is not null and host_id is not null and approved_at is not null))
);
create unique index remote_enrollments_pending_code_idx on public.remote_enrollments(code_hash) where status = 'pending';
create index remote_enrollments_expiry_idx on public.remote_enrollments(expires_at);
create index remote_enrollments_pending_key_idx on public.remote_enrollments(public_key) where status = 'pending';
create table public.remote_audit_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  host_id uuid not null references public.remote_hosts(id) on delete cascade,
  kind text not null check (kind in ('host-enrolled', 'host-renamed', 'host-revoked', 'host-self-revoked')),
  created_at timestamptz not null default pg_catalog.now()
);
create index remote_audit_events_owner_idx on public.remote_audit_events(owner_id);
create index remote_audit_events_created_idx on public.remote_audit_events(created_at);
alter table public.remote_enrollments enable row level security;
alter table public.remote_audit_events enable row level security;
revoke all on public.remote_enrollments, public.remote_audit_events from public, anon, authenticated;
grant select on public.remote_audit_events to authenticated;
grant select, insert, update, delete on public.remote_enrollments, public.remote_audit_events to service_role;
revoke all on sequence public.remote_audit_events_id_seq from public, anon, authenticated;
grant usage, select on sequence public.remote_audit_events_id_seq to service_role;
create policy audit_owner_read on public.remote_audit_events for select to authenticated using (
  owner_id = (select auth.uid()) and exists (
    select 1 from public.remote_access_accounts a where a.user_id = (select auth.uid()) and a.enabled
  )
);

create function control_private.iso(p_time timestamptz) returns text
language sql stable strict security invoker set search_path = '' as $$
  select pg_catalog.to_char(p_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;
create function control_private.machine(p_host public.remote_hosts) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', p_host.id, 'label', p_host.label, 'hostname', p_host.hostname,
    'platform', p_host.platform, 'arch', p_host.arch, 'hostVersion', p_host.host_version,
    'keyFingerprint', p_host.key_fingerprint, 'enrolledAt', control_private.iso(p_host.created_at),
    'lastSeenAt', control_private.iso(p_host.last_seen_at), 'state', p_host.state,
    'readiness', p_host.readiness, 'endpoint', p_host.endpoint, 'lanes',
    case when p_host.running_lanes is null then null else
      pg_catalog.jsonb_build_object('running', p_host.running_lanes, 'waiting', p_host.waiting_lanes) end);
$$;
create function public.control_account(p_user_id uuid, p_login text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_enabled boolean;
begin
  insert into public.remote_access_accounts(user_id, login) values (p_user_id, p_login)
    on conflict (user_id) do update set login = excluded.login, updated_at = pg_catalog.now()
    returning enabled into v_enabled;
  return pg_catalog.jsonb_build_object('enabled', v_enabled, 'maxHosts', 20);
end;
$$;
create function public.control_enrollment_create(p_public_key text, p_key_fingerprint text,
  p_code_hash text, p_hostname text, p_platform text, p_arch text, p_host_version text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_row public.remote_enrollments;
begin
  -- Serialize admission so concurrent creations cannot exceed either pending cap.
  perform pg_catalog.pg_advisory_xact_lock(61012120000);
  delete from public.remote_enrollments where ctid in (select ctid from public.remote_enrollments
    where expires_at < pg_catalog.now() - interval '1 day' limit 1000);
  delete from public.remote_audit_events where ctid in (select ctid from public.remote_audit_events
    where created_at < pg_catalog.now() - interval '180 days' limit 1000);
  if exists (select 1 from public.remote_hosts where public_key = p_public_key and revoked_at is null) then
    return '{"outcome":"key-in-use"}'::jsonb;
  end if;
  if (select pg_catalog.count(*) from public.remote_enrollments where status = 'pending' and expires_at > pg_catalog.now()) >= 10000
    or (select pg_catalog.count(*) from public.remote_enrollments where status = 'pending'
      and expires_at > pg_catalog.now() and public_key = p_public_key) >= 3 then
    return '{"outcome":"busy"}'::jsonb;
  end if;
  begin
    insert into public.remote_enrollments(public_key, key_fingerprint, code_hash, hostname, platform, arch, host_version)
      values (p_public_key, p_key_fingerprint, p_code_hash, p_hostname, p_platform, p_arch, p_host_version)
      returning * into v_row;
  exception when unique_violation then return '{"outcome":"code-collision"}'::jsonb;
  end;
  return pg_catalog.jsonb_build_object('outcome', 'created', 'enrollmentId', v_row.id,
    'expiresAt', control_private.iso(v_row.expires_at));
end;
$$;
create function public.control_enrollment_poll(p_enrollment_id uuid, p_public_key text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_row public.remote_enrollments; v_login text; v_label text;
begin
  select * into v_row from public.remote_enrollments where id = p_enrollment_id and public_key = p_public_key;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  if v_row.expires_at <= pg_catalog.now() then return '{"outcome":"expired"}'::jsonb; end if;
  if v_row.status = 'pending' then return '{"outcome":"pending"}'::jsonb; end if;
  select login into v_login from public.remote_access_accounts where user_id = v_row.owner_id;
  select label into v_label from public.remote_hosts where id = v_row.host_id;
  return pg_catalog.jsonb_build_object('outcome', 'approved', 'hostId', v_row.host_id,
    'label', v_label, 'owner', pg_catalog.jsonb_build_object('login', v_login));
end;
$$;
create function public.control_enrollment_lookup(p_user_id uuid, p_code_hash text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_row public.remote_enrollments;
begin
  select * into v_row from public.remote_enrollments where code_hash = p_code_hash
    and status = 'pending' and expires_at > pg_catalog.now();
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  return pg_catalog.jsonb_build_object('outcome', 'found', 'hostname', v_row.hostname,
    'platform', v_row.platform, 'arch', v_row.arch, 'hostVersion', v_row.host_version,
    'keyFingerprint', v_row.key_fingerprint, 'expiresAt', control_private.iso(v_row.expires_at));
end;
$$;
create function public.control_enrollment_approve(p_user_id uuid, p_code_hash text, p_label text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_row public.remote_enrollments; v_host public.remote_hosts; v_enabled boolean;
begin
  select * into v_row from public.remote_enrollments where code_hash = p_code_hash and status = 'pending' for update;
  if not found or v_row.status <> 'pending' or v_row.expires_at <= pg_catalog.now() then
    return '{"outcome":"not-found"}'::jsonb;
  end if;
  -- Lock the account as well: distinct codes approved concurrently share the cap.
  select enabled into v_enabled from public.remote_access_accounts where user_id = p_user_id for update;
  if v_enabled is distinct from true then return '{"outcome":"account-disabled"}'::jsonb; end if;
  if (select pg_catalog.count(*) from public.remote_hosts where owner_id = p_user_id and revoked_at is null) >= 20 then
    return '{"outcome":"host-limit"}'::jsonb;
  end if;
  begin
    insert into public.remote_hosts(owner_id, label, hostname, public_key, key_fingerprint, platform, arch, host_version)
      values (p_user_id, p_label, v_row.hostname, v_row.public_key, v_row.key_fingerprint, v_row.platform, v_row.arch, v_row.host_version)
      returning * into v_host;
  exception when unique_violation then return '{"outcome":"key-in-use"}'::jsonb;
  end;
  update public.remote_enrollments set status = 'approved', owner_id = p_user_id,
    host_id = v_host.id, approved_at = pg_catalog.now() where id = v_row.id;
  insert into public.remote_audit_events(owner_id, host_id, kind) values (p_user_id, v_host.id, 'host-enrolled');
  return pg_catalog.jsonb_build_object('outcome', 'approved', 'machine', control_private.machine(v_host));
end;
$$;
create function public.control_machines(p_user_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object('machines', coalesce(pg_catalog.jsonb_agg(control_private.machine(h)
    order by h.label, h.id), '[]'::jsonb), 'serverTime', control_private.iso(pg_catalog.now()))
    from public.remote_hosts h where h.owner_id = p_user_id and h.revoked_at is null;
$$;
create function public.control_machine_rename(p_user_id uuid, p_host_id uuid, p_label text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_host public.remote_hosts;
begin
  update public.remote_hosts set label = p_label where id = p_host_id and owner_id = p_user_id
    and revoked_at is null returning * into v_host;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  insert into public.remote_audit_events(owner_id, host_id, kind) values (p_user_id, p_host_id, 'host-renamed');
  return pg_catalog.jsonb_build_object('outcome', 'renamed', 'machine', control_private.machine(v_host));
end;
$$;
create function public.control_machine_revoke(p_user_id uuid, p_host_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  update public.remote_hosts set revoked_at = pg_catalog.now(), epoch = epoch + 1
    where id = p_host_id and owner_id = p_user_id and revoked_at is null;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  insert into public.remote_audit_events(owner_id, host_id, kind) values (p_user_id, p_host_id, 'host-revoked');
  return '{"outcome":"revoked"}'::jsonb;
end;
$$;
create function public.control_host_key(p_host_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce((select pg_catalog.jsonb_build_object('outcome', 'active', 'publicKey', public_key)
    from public.remote_hosts where id = p_host_id and revoked_at is null), '{"outcome":"gone"}'::jsonb);
$$;
create function public.control_host_self(p_host_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce((select pg_catalog.jsonb_build_object('outcome', 'active', 'hostId', h.id, 'label', h.label,
    'owner', pg_catalog.jsonb_build_object('login', a.login), 'enrolledAt', control_private.iso(h.created_at),
    'lastSeenAt', control_private.iso(h.last_seen_at)) from public.remote_hosts h
    join public.remote_access_accounts a on a.user_id = h.owner_id where h.id = p_host_id and h.revoked_at is null),
    '{"outcome":"gone"}'::jsonb);
$$;
create function public.control_host_revoke_self(p_host_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid;
begin
  update public.remote_hosts set revoked_at = pg_catalog.now(), epoch = epoch + 1
    where id = p_host_id and revoked_at is null returning owner_id into v_owner;
  if not found then return '{"outcome":"gone"}'::jsonb; end if;
  insert into public.remote_audit_events(owner_id, host_id, kind) values (v_owner, p_host_id, 'host-self-revoked');
  return '{"outcome":"revoked"}'::jsonb;
end;
$$;
create function public.control_host_heartbeat(p_host_id uuid, p_seq bigint, p_state text,
  p_host_version text, p_uptime_sec bigint, p_readiness jsonb, p_running int, p_waiting int, p_endpoint text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_host public.remote_hosts;
begin
  update public.remote_hosts set last_seq = p_seq, state = p_state, host_version = p_host_version,
    uptime_sec = p_uptime_sec, readiness = p_readiness, running_lanes = p_running,
    waiting_lanes = p_waiting, endpoint = p_endpoint, last_seen_at = pg_catalog.now()
    where id = p_host_id and revoked_at is null and last_seq < p_seq
    and (p_state = 'stopping' or last_seen_at is null or last_seen_at <= pg_catalog.now() - interval '10 seconds')
    returning * into v_host;
  if found then return '{"outcome":"accepted"}'::jsonb; end if;
  select * into v_host from public.remote_hosts where id = p_host_id;
  if not found or v_host.revoked_at is not null then return '{"outcome":"gone"}'::jsonb; end if;
  if p_seq <= v_host.last_seq then return '{"outcome":"stale"}'::jsonb; end if;
  return '{"outcome":"too-soon"}'::jsonb;
end;
$$;

-- Apply the same ACL to every RPC and helper, without exposing helper RPCs.
do $$
declare v_function text;
begin
  for v_function in select pg_catalog.format('%I.%I(%s)', n.nspname, p.proname,
    pg_catalog.pg_get_function_identity_arguments(p.oid)) from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'control_private' or (n.nspname = 'public' and p.proname like 'control\_%' escape '\')
  loop
    execute 'revoke all on function ' || v_function || ' from public, anon, authenticated';
    execute 'grant execute on function ' || v_function || ' to service_role';
  end loop;
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.remote_hosts;
  end if;
end;
$$;
