-- Grant tracking contains identity only, never lane information or tokens.
create table public.remote_grant_sessions (
  sid uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  last_issued_at timestamptz not null default pg_catalog.now()
);
create index remote_grant_sessions_owner_recent_idx
  on public.remote_grant_sessions(owner_id, last_issued_at desc);
create index remote_clients_revoked_idx on public.remote_clients(owner_id, revoked_at desc)
  where revoked_at is not null;
alter table public.remote_grant_sessions enable row level security;
revoke all on public.remote_grant_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.remote_grant_sessions to service_role;

-- Mirror the Host label check for Desktop labels, including UTF-16 length.
alter table public.remote_clients drop constraint remote_clients_label_check,
  add constraint remote_clients_label_check check (
    pg_catalog.char_length(label)
      + pg_catalog.char_length(pg_catalog.regexp_replace(label, U&'[^\+010000-\+10FFFF]', '', 'g'))
      between 1 and 80
    and label !~ U&'^[\0020\00A0\1680\2000-\200A\202F\205F\3000\FEFF]|[\0020\00A0\1680\2000-\200A\202F\205F\3000\FEFF]$'
    and label !~ U&'[\0001-\001F\007F-\009F\061C\200E-\200F\2028-\202E\2066-\2069]');

create function public.control_client_register(p_user uuid, p_label text, p_kind text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_client public.remote_clients; v_enabled boolean;
begin
  -- The account lock serializes concurrent registrations against the cap.
  select enabled into v_enabled from public.remote_access_accounts where user_id = p_user for update;
  if v_enabled is distinct from true then return '{"outcome":"account-disabled"}'::jsonb; end if;
  if (select pg_catalog.count(*) from public.remote_clients where owner_id = p_user and revoked_at is null) >= 20 then
    return '{"outcome":"too-many-requests"}'::jsonb;
  end if;
  -- A heartbeat lists at most 100 clients revoked in the last ten minutes. Live plus recently
  -- revoked clients stay within that, so the list can never omit a revocation.
  if (select pg_catalog.count(*) from public.remote_clients where owner_id = p_user
      and (revoked_at is null or revoked_at >= pg_catalog.now() - interval '10 minutes')) >= 100 then
    return '{"outcome":"too-many-requests"}'::jsonb;
  end if;
  insert into public.remote_clients(owner_id, label, kind) values (p_user, p_label, p_kind) returning * into v_client;
  return pg_catalog.jsonb_build_object('outcome', 'registered', 'client',
    pg_catalog.jsonb_build_object('id', v_client.id, 'label', v_client.label));
end;
$$;
create function public.control_client_revoke(p_user uuid, p_client uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  update public.remote_clients set revoked_at = pg_catalog.now()
    where id = p_client and owner_id = p_user and revoked_at is null;
  if not found then return '{"outcome":"not-found"}'::jsonb; end if;
  return '{"outcome":"revoked"}'::jsonb;
end;
$$;
create function public.control_grant_issue(p_user uuid, p_host uuid, p_client uuid, p_sid uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_host public.remote_hosts; v_client public.remote_clients;
begin
  -- The account lock serializes one owner's issues against the session cap below. It comes
  -- first, as in registration and enrollment approval, so lock order stays account, then rows.
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
  -- A heartbeat lists at most 100 revoked sessions from the last ten minutes. An owner may hold
  -- at most 100 sessions in that window, so the list can never omit a grant still valid.
  if (select pg_catalog.count(*) from public.remote_grant_sessions where owner_id = p_user
      and sid <> p_sid and last_issued_at >= pg_catalog.now() - interval '10 minutes') >= 100 then
    return '{"outcome":"too-many-requests"}'::jsonb;
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
-- service_role cannot read auth.sessions on Supabase. This one fixed query runs
-- as the migration owner; only service_role may call it, and it reads ids only.
create function public.control_host_revocations(p_host uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select pg_catalog.jsonb_build_object('ownerId', h.owner_id, 'epoch', h.epoch,
    'revoked', pg_catalog.jsonb_build_object(
      'clients', coalesce((select pg_catalog.jsonb_agg(c.id order by c.revoked_at desc, c.id) from (
        select id, revoked_at from public.remote_clients where owner_id = h.owner_id
          and revoked_at >= pg_catalog.now() - interval '10 minutes'
        order by revoked_at desc, id limit 100) c), '[]'::jsonb),
      'sessions', coalesce((select pg_catalog.jsonb_agg(s.sid order by s.last_issued_at desc, s.sid) from (
        select g.sid, g.last_issued_at from public.remote_grant_sessions g where g.owner_id = h.owner_id
          and g.last_issued_at >= pg_catalog.now() - interval '10 minutes'
          and not exists (select 1 from auth.sessions a where a.id = g.sid)
        order by g.last_issued_at desc, g.sid limit 100) s), '[]'::jsonb)))
    from public.remote_hosts h where h.id = p_host and h.revoked_at is null), '{"outcome":"gone"}'::jsonb);
$$;

revoke all on function public.control_client_register(uuid, text, text),
  public.control_client_revoke(uuid, uuid), public.control_grant_issue(uuid, uuid, uuid, uuid),
  public.control_host_revocations(uuid) from public, anon, authenticated;
grant execute on function public.control_client_register(uuid, text, text),
  public.control_client_revoke(uuid, uuid), public.control_grant_issue(uuid, uuid, uuid, uuid),
  public.control_host_revocations(uuid) to service_role;
