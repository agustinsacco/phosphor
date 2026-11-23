-- Two-connection races in control_machine_grant_issue, in the style of control_grants_race.
-- The fixture is committed through dblink under two owners that are deleted first, last, and
-- on any error. Local stack only: dblink signs in with the local stack's default postgres
-- password over the server's own TCP address.
begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set local search_path = public, extensions;
select plan(5);
create temporary table race (name text primary key, value text);
-- True once the backend waits for a lock, false after five seconds without one.
create function pg_temp.race_blocked(p_pid int) returns boolean language plpgsql as $$
begin
  for i in 1..500 loop
    if exists (select 1 from pg_catalog.pg_locks where pid = p_pid and not granted) then return true; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
  return false;
end $$;
do $$
declare
  v_dsn text := format('host=%s port=%s dbname=%s user=postgres password=postgres',
    host(inet_server_addr()), inet_server_port(), current_database());
  v_clean constant text := $f$delete from auth.users where id in ('00000000-0000-4000-b000-000000000001',
    '00000000-0000-4000-b000-000000000002')$f$;
  v_issue constant text := $f$select public.control_machine_grant_issue('%s', '%s')->>'outcome'$f$;
  v_pid int;
  v_name text;
begin
  perform dblink_connect('setup', v_dsn);
  perform dblink_exec('setup', v_clean);
  begin
    perform dblink_connect('a', v_dsn);
    perform dblink_connect('b', v_dsn);
    perform dblink_exec('setup', $f$
      insert into auth.users(id, email) values
        ('00000000-0000-4000-b000-000000000001', 'machine-race-1@example.test'),
        ('00000000-0000-4000-b000-000000000002', 'machine-race-2@example.test');
      insert into public.remote_access_accounts(user_id, enabled) values
        ('00000000-0000-4000-b000-000000000001', true), ('00000000-0000-4000-b000-000000000002', true);
      insert into public.remote_hosts(id, owner_id, label, hostname, public_key, key_fingerprint, platform, arch,
        endpoint, epoch, state, last_seen_at, machine_grants)
        select ('00000000-0000-4000-b000-0000000000' || h.suffix)::uuid, ('00000000-0000-4000-b000-00000000000' || h.owner)::uuid,
          'Race ' || h.suffix, 'race-' || h.suffix, repeat(h.letter, 42) || 'A', 'abcd-abcd-abcd-abcd', 'linux', 'x64',
          'https://race-' || h.suffix || '.ts.net', 1, 'running', now(), true
        from (values ('11', '1', 'e'), ('12', '1', 'f'), ('13', '1', 'g'), ('14', '1', 'h'),
          ('21', '2', 'i'), ('22', '2', 'j')) h(suffix, owner, letter);
      -- Each owner holds a day-old principal that a cleanup without an owner filter would lock.
      insert into public.remote_machine_principals(host_id, owner_id, revoked_at) values
        ('00000000-0000-4000-b000-000000000011', '00000000-0000-4000-b000-000000000001', now() - interval '2 days'),
        ('00000000-0000-4000-b000-000000000021', '00000000-0000-4000-b000-000000000002', now() - interval '2 days')$f$);
    select p into v_pid from dblink('b', 'select pg_backend_pid()') as t(p int);
    perform dblink_exec('a', 'set role service_role');
    perform dblink_exec('b', 'set role service_role');
    -- Race 1: two owners issue at once. Neither waits for the other.
    perform dblink_exec('a', 'begin');
    insert into race select 'owners-first', o from dblink('a', format(v_issue,
      '00000000-0000-4000-b000-000000000011', '00000000-0000-4000-b000-000000000012')) as t(o text);
    perform dblink_send_query('b', format(v_issue, '00000000-0000-4000-b000-000000000021',
      '00000000-0000-4000-b000-000000000022'));
    insert into race values ('owners-waits', pg_temp.race_blocked(v_pid)::text);
    perform dblink_exec('a', 'commit');
    insert into race select 'owners-second', o from dblink_get_result('b') as t(o text);
    perform * from dblink_get_result('b') as t(o text);
    -- Race 2: two callers of one owner at 39 live or recent principals (11's live one and 38).
    perform dblink_exec('setup', $f$insert into public.remote_machine_principals(host_id, owner_id, revoked_at)
      select '00000000-0000-4000-b000-000000000012', '00000000-0000-4000-b000-000000000001', now()
      from generate_series(1, 38)$f$);
    perform dblink_exec('a', 'begin');
    insert into race select 'cap-first', o from dblink('a', format(v_issue,
      '00000000-0000-4000-b000-000000000013', '00000000-0000-4000-b000-000000000012')) as t(o text);
    perform dblink_send_query('b', format(v_issue, '00000000-0000-4000-b000-000000000014',
      '00000000-0000-4000-b000-000000000012'));
    insert into race values ('cap-waits', pg_temp.race_blocked(v_pid)::text);
    perform dblink_exec('a', 'commit');
    insert into race select 'cap-second', o from dblink_get_result('b') as t(o text);
    perform * from dblink_get_result('b') as t(o text);
    insert into race select 'cap-count', n::text from dblink('setup', $f$select count(*)
      from public.remote_machine_principals where owner_id = '00000000-0000-4000-b000-000000000001'$f$) as t(n bigint);
  exception when others then
    -- Close the racing sessions first: an open transaction would block the cleanup's cascade.
    foreach v_name in array coalesce(dblink_get_connections(), '{}') loop
      if v_name <> 'setup' then
        begin
          perform dblink_cancel_query(v_name);
          perform dblink_disconnect(v_name);
        exception when others then null;
        end;
      end if;
    end loop;
    perform dblink_exec('setup', v_clean);
    perform dblink_disconnect('setup');
    raise;
  end;
  perform dblink_disconnect('a');
  perform dblink_disconnect('b');
  perform dblink_exec('setup', v_clean);
  perform dblink_disconnect('setup');
end $$;
select is((select value from race where name = 'owners-first'), 'issued', 'the first owner''s issue succeeds');
select is((select value from race where name = 'owners-waits') || ' ' || (select value from race where name = 'owners-second'),
  'false issued', 'another owner''s concurrent issue neither waits nor fails');
select is((select value from race where name = 'cap-first'), 'issued', 'the 40th principal is admitted');
select is((select value from race where name = 'cap-waits') || ' ' || (select value from race where name = 'cap-second'),
  'true too-many-requests', 'a concurrent 41st principal waits for the account lock and is refused');
select is((select value from race where name = 'cap-count'), '40', 'the owner holds exactly 40 principals');
select * from finish();
rollback;
