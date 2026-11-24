-- Browser sessions that outlive restarts and replicas, replica-safe request nonces,
-- and no per-owner cap a real user can reach.

-- One browser sign-in is one web client and one row here, found by the SHA-256 of the
-- random handle in its cookie. The handle never changes, so no lost or reordered response
-- can roll a browser back, and any replica can admit it. No provider token is stored:
-- the OAuth exchange proves identity once, and the Supabase session id recorded here
-- keeps gating Host grants. A session lasts while it is used: one idle for 90 days ends.
create table public.remote_web_sessions (
  client_id uuid primary key references public.remote_clients(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  handle_hash text not null unique check (handle_hash ~ '^[0-9a-f]{64}$'),
  sid uuid not null,
  used_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now()
);
create index remote_web_sessions_owner_idx on public.remote_web_sessions(owner_id);

-- A signed Host request's nonce, held while its signature could still verify.
create table public.remote_request_nonces (
  identity text not null check (identity ~ '^[A-Za-z0-9_-]{36,43}$'),
  nonce text not null check (nonce ~ '^[A-Za-z0-9_-]{22}$'),
  expires_at timestamptz not null,
  primary key (identity, nonce)
);
create index remote_request_nonces_expiry_idx on public.remote_request_nonces(expires_at);

alter table public.remote_web_sessions enable row level security;
alter table public.remote_request_nonces enable row level security;
revoke all on public.remote_web_sessions, public.remote_request_nonces from public, anon, authenticated;
grant select, insert, update, delete on public.remote_web_sessions, public.remote_request_nonces to service_role;

alter table public.remote_access_accounts add column revocations_reset_at timestamptz;

-- service_role cannot read or delete auth.sessions on Supabase. These two fixed statements
-- run as the migration owner and touch only the named owner's session.
create function control_private.auth_session_alive(p_user uuid, p_sid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.sessions where id = p_sid and user_id = p_user);
$$;
create function control_private.auth_session_end(p_user uuid, p_sid uuid) returns void
language sql security definer set search_path = '' as $$
  delete from auth.sessions where id = p_sid and user_id = p_user;
$$;

-- A heartbeat lists at most 100 revoked clients and 100 revoked sessions per owner, and
-- Hosts refuse a longer list. When one more would not fit, every grant the owner holds is
-- retired instead: each Host's epoch moves on, which refuses all earlier grants, and both
-- lists start again from now. So admission never has to refuse anyone. Callers hold the
-- account row lock; stamps use the wall clock so a transaction that waited stays ordered.
create function control_private.revocations_reset(p_owner uuid) returns void
language sql security invoker set search_path = '' as $$
  update public.remote_hosts set epoch = epoch + 1 where owner_id = p_owner and revoked_at is null;
  delete from public.remote_grant_sessions where owner_id = p_owner;
  update public.remote_access_accounts set revocations_reset_at = pg_catalog.clock_timestamp()
    where user_id = p_owner;
$$;
-- Revokes a live client and ends its browser session, Supabase's included.
create function control_private.client_revoke(p_owner uuid, p_client uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_since timestamptz; v_sid uuid;
begin
  select greatest(pg_catalog.now() - interval '10 minutes', coalesce(revocations_reset_at, '-infinity'))
    into v_since from public.remote_access_accounts where user_id = p_owner for update;
  if not exists (select 1 from public.remote_clients where id = p_client and owner_id = p_owner
      and revoked_at is null) then
    return false;
  end if;
  if (select pg_catalog.count(*) from public.remote_clients where owner_id = p_owner
      and revoked_at >= v_since) >= 100 then
    perform control_private.revocations_reset(p_owner);
  end if;
  update public.remote_clients set revoked_at = pg_catalog.clock_timestamp() where id = p_client;
  delete from public.remote_web_sessions where client_id = p_client returning sid into v_sid;
  if v_sid is not null then perform control_private.auth_session_end(p_owner, v_sid); end if;
  return true;
end;
$$;
-- Ends the owner's browser sessions idle for 90 days, drops browser clients left without a
-- session (none can sign in again), and forgets clients revoked over a day ago.
create function control_private.clients_sweep(p_owner uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare v_client uuid;
begin
  for v_client in select client_id from public.remote_web_sessions where owner_id = p_owner
      and used_at < pg_catalog.now() - interval '90 days' loop
    perform control_private.client_revoke(p_owner, v_client);
  end loop;
  delete from public.remote_clients c where c.owner_id = p_owner and c.kind = 'web'
    and c.revoked_at is null and not exists (select 1 from public.remote_web_sessions s where s.client_id = c.id);
  delete from public.remote_clients where owner_id = p_owner
    and revoked_at < pg_catalog.now() - interval '1 day';
end;
$$;

-- Reads stay reads: the account is written only to provision it or record a new login.
create or replace function public.control_account(p_user_id uuid, p_login text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_account public.remote_access_accounts;
begin
  select * into v_account from public.remote_access_accounts where user_id = p_user_id;
  if not found or v_account.login is distinct from p_login then
    insert into public.remote_access_accounts(user_id, login) values (p_user_id, p_login)
      on conflict (user_id) do update set login = excluded.login, updated_at = pg_catalog.now()
      returning * into v_account;
  end if;
  return pg_catalog.jsonb_build_object('enabled', v_account.enabled, 'maxHosts', 100);
end;
$$;

create function public.control_web_session_create(p_user uuid, p_login text, p_sid uuid,
  p_handle_hash text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_client uuid;
begin
  if (public.control_account(p_user, p_login)->>'enabled')::boolean is distinct from true then
    return '{"outcome":"account-disabled"}'::jsonb;
  end if;
  perform control_private.clients_sweep(p_user);
  insert into public.remote_clients(owner_id, label, kind) values (p_user, 'Web browser', 'web')
    returning id into v_client;
  insert into public.remote_web_sessions(client_id, owner_id, handle_hash, sid)
    values (v_client, p_user, p_handle_hash, p_sid);
  return pg_catalog.jsonb_build_object('outcome', 'created', 'clientId', v_client);
end;
$$;
-- Admits one request. `renewed` says the idle clock moved (at most hourly), so the server
-- re-sends the cookie with a fresh lifetime.
create function public.control_web_session_use(p_handle_hash text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_session public.remote_web_sessions; v_account public.remote_access_accounts;
  v_renew boolean;
begin
  select * into v_session from public.remote_web_sessions where handle_hash = p_handle_hash;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  if v_session.used_at < pg_catalog.now() - interval '90 days'
      or not control_private.auth_session_alive(v_session.owner_id, v_session.sid) then
    perform control_private.client_revoke(v_session.owner_id, v_session.client_id);
    return '{"outcome":"not-found"}'::jsonb;
  end if;
  select * into v_account from public.remote_access_accounts where user_id = v_session.owner_id;
  if v_account.enabled is distinct from true then return '{"outcome":"account-disabled"}'::jsonb; end if;
  v_renew := v_session.used_at < pg_catalog.now() - interval '1 hour';
  if v_renew then
    update public.remote_web_sessions set used_at = pg_catalog.now() where client_id = v_session.client_id;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'active', 'userId', v_session.owner_id,
    'login', v_account.login, 'clientId', v_session.client_id, 'sid', v_session.sid, 'renewed', v_renew);
end;
$$;
create function public.control_web_session_end(p_handle_hash text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_session public.remote_web_sessions;
begin
  select * into v_session from public.remote_web_sessions where handle_hash = p_handle_hash;
  if not found or not control_private.client_revoke(v_session.owner_id, v_session.client_id) then
    return '{"outcome":"not-found"}'::jsonb;
  end if;
  return '{"outcome":"ended"}'::jsonb;
end;
$$;
-- Browser identity now lives in remote_web_sessions.
drop function public.control_web_client_status(uuid, uuid);

create function public.control_nonce_claim(p_identity text, p_nonce text, p_ttl_sec int) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  if p_ttl_sec is null or p_ttl_sec not between 1 and 3600 then raise exception 'invalid nonce ttl'; end if;
  delete from public.remote_request_nonces where ctid in (select ctid from public.remote_request_nonces
    where expires_at < pg_catalog.now() limit 100);
  insert into public.remote_request_nonces(identity, nonce, expires_at)
    values (p_identity, p_nonce, pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_sec))
    on conflict do nothing;
  if found then return '{"outcome":"claimed"}'::jsonb; end if;
  return '{"outcome":"replayed"}'::jsonb;
end;
$$;

create or replace function public.control_client_register(p_user uuid, p_label text, p_kind text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_client public.remote_clients;
begin
  if not exists (select 1 from public.remote_access_accounts where user_id = p_user and enabled) then
    return '{"outcome":"account-disabled"}'::jsonb;
  end if;
  perform control_private.clients_sweep(p_user);
  insert into public.remote_clients(owner_id, label, kind) values (p_user, p_label, p_kind) returning * into v_client;
  return pg_catalog.jsonb_build_object('outcome', 'registered', 'client',
    pg_catalog.jsonb_build_object('id', v_client.id, 'label', v_client.label));
end;
$$;
create or replace function public.control_client_revoke(p_user uuid, p_client uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  if not control_private.client_revoke(p_user, p_client) then return '{"outcome":"not-found"}'::jsonb; end if;
  return '{"outcome":"revoked"}'::jsonb;
end;
$$;
create or replace function public.control_grant_issue(p_user uuid, p_host uuid, p_client uuid, p_sid uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_host public.remote_hosts; v_client public.remote_clients;
begin
  -- The account lock orders issues against revocations and resets; lock order stays
  -- account, then rows, as in registration and enrollment approval.
  perform 1 from public.remote_access_accounts where user_id = p_user for update;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  -- Share row locks with revocation so its completion cannot race grant admission.
  select * into v_host from public.remote_hosts where id = p_host and owner_id = p_user
    and revoked_at is null for share;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  select * into v_client from public.remote_clients where id = p_client and owner_id = p_user
    and revoked_at is null for share;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  -- Bounded cleanup. Keep ten minutes of history after a session disappears.
  -- The age test is repeated on the target row: after waiting for a transaction that refreshed
  -- the row, PostgreSQL rechecks it against the new version and keeps the session.
  delete from public.remote_grant_sessions where sid in (
    select sid from public.remote_grant_sessions where last_issued_at < pg_catalog.now() - interval '10 minutes'
    order by last_issued_at limit 1000)
    and last_issued_at < pg_catalog.now() - interval '10 minutes';
  -- A 101st session in the heartbeat's window retires the owner's grants instead of waiting.
  if not exists (select 1 from public.remote_grant_sessions where sid = p_sid and owner_id = p_user)
    and (select pg_catalog.count(*) from public.remote_grant_sessions where owner_id = p_user
      and last_issued_at >= pg_catalog.now() - interval '10 minutes') >= 100 then
    perform control_private.revocations_reset(p_user);
    select * into v_host from public.remote_hosts where id = p_host;
  end if;
  insert into public.remote_grant_sessions(sid, owner_id) values (p_sid, p_user)
    on conflict (sid) do update set last_issued_at = pg_catalog.now()
      where remote_grant_sessions.owner_id = excluded.owner_id;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  return pg_catalog.jsonb_build_object('outcome', 'issued', 'epoch', v_host.epoch,
    'publicKey', v_host.public_key, 'endpoint', v_host.endpoint, 'client',
    pg_catalog.jsonb_build_object('id', v_client.id, 'label', v_client.label));
end;
$$;
create or replace function public.control_host_revocations(p_host uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select pg_catalog.jsonb_build_object('ownerId', h.owner_id, 'epoch', h.epoch,
    'revoked', pg_catalog.jsonb_build_object(
      'clients', coalesce((select pg_catalog.jsonb_agg(c.id order by c.revoked_at desc, c.id) from (
        select id, revoked_at from public.remote_clients where owner_id = h.owner_id
          and revoked_at >= greatest(pg_catalog.now() - interval '10 minutes',
            coalesce(a.revocations_reset_at, '-infinity'))
        order by revoked_at desc, id limit 100) c), '[]'::jsonb),
      'sessions', coalesce((select pg_catalog.jsonb_agg(s.sid order by s.last_issued_at desc, s.sid) from (
        select g.sid, g.last_issued_at from public.remote_grant_sessions g where g.owner_id = h.owner_id
          and g.last_issued_at >= pg_catalog.now() - interval '10 minutes'
          and not exists (select 1 from auth.sessions x where x.id = g.sid)
        order by g.last_issued_at desc, g.sid limit 100) s), '[]'::jsonb)))
    from public.remote_hosts h join public.remote_access_accounts a on a.user_id = h.owner_id
    where h.id = p_host and h.revoked_at is null), '{"outcome":"gone"}'::jsonb);
$$;

-- A Host's newest code replaces its pending ones; the global bound stays as flood protection.
create or replace function public.control_enrollment_create(p_public_key text, p_key_fingerprint text,
  p_code_hash text, p_hostname text, p_platform text, p_arch text, p_host_version text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_row public.remote_enrollments;
begin
  -- Serialize admission so concurrent creations cannot exceed the pending bound.
  perform pg_catalog.pg_advisory_xact_lock(61012120000);
  delete from public.remote_enrollments where ctid in (select ctid from public.remote_enrollments
    where expires_at < pg_catalog.now() - interval '1 day' limit 1000);
  delete from public.remote_audit_events where ctid in (select ctid from public.remote_audit_events
    where created_at < pg_catalog.now() - interval '180 days' limit 1000);
  if exists (select 1 from public.remote_hosts where public_key = p_public_key and revoked_at is null) then
    return '{"outcome":"key-in-use"}'::jsonb;
  end if;
  delete from public.remote_enrollments where public_key = p_public_key and status = 'pending';
  if (select pg_catalog.count(*) from public.remote_enrollments where status = 'pending'
      and expires_at > pg_catalog.now()) >= 10000 then
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
-- A hundred Hosts is what every shipped client can list (CONTROL_LIMITS, machines parser).
create or replace function public.control_enrollment_approve(p_user_id uuid, p_code_hash text, p_label text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_row public.remote_enrollments; v_host public.remote_hosts; v_enabled boolean;
begin
  select * into v_row from public.remote_enrollments where code_hash = p_code_hash and status = 'pending' for update;
  if not found or v_row.status <> 'pending' then return '{"outcome":"not-found"}'::jsonb; end if;
  -- Lock the account as well: distinct codes approved concurrently share the bound.
  select enabled into v_enabled from public.remote_access_accounts where user_id = p_user_id for update;
  -- Either lock may have waited, and now() is the transaction's start: use the wall clock.
  if v_row.expires_at <= pg_catalog.clock_timestamp() then return '{"outcome":"not-found"}'::jsonb; end if;
  if v_enabled is distinct from true then return '{"outcome":"account-disabled"}'::jsonb; end if;
  if (select pg_catalog.count(*) from public.remote_hosts where owner_id = p_user_id and revoked_at is null) >= 100 then
    return '{"outcome":"host-limit"}'::jsonb;
  end if;
  begin
    insert into public.remote_hosts(owner_id, label, hostname, public_key, key_fingerprint, platform, arch, host_version)
      values (p_user_id, p_label, v_row.hostname, v_row.public_key, v_row.key_fingerprint, v_row.platform, v_row.arch, v_row.host_version)
      returning * into v_host;
  exception when unique_violation then return '{"outcome":"key-in-use"}'::jsonb;
  end;
  -- The Host may poll just after the code's expiry; give it time to collect its id.
  update public.remote_enrollments set status = 'approved', owner_id = p_user_id,
    host_id = v_host.id, approved_at = pg_catalog.now(),
    expires_at = greatest(v_row.expires_at, pg_catalog.clock_timestamp() + interval '120 seconds')
    where id = v_row.id;
  insert into public.remote_audit_events(owner_id, host_id, kind) values (p_user_id, v_host.id, 'host-enrolled');
  return pg_catalog.jsonb_build_object('outcome', 'approved', 'machine', control_private.machine(v_host));
end;
$$;

-- Same ACL for every RPC and helper: only the server's service role may execute them.
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
end;
$$;
