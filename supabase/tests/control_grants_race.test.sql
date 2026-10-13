-- Two-connection races in control_grant_issue. The racing transactions must see each other's
-- committed rows, so the fixture is committed through dblink, under one owner that is deleted
-- first, last, and on any error. Local stack only: dblink signs in with the local stack's
-- default postgres password over the server's own TCP address (pg_prove connects over TCP).
begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set local search_path = public, extensions;
select plan(6);
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
  v_clean constant text := $f$delete from auth.users where id = '00000000-0000-4000-a000-000000000001'$f$;
  v_issue constant text := $f$select public.control_grant_issue('00000000-0000-4000-a000-000000000001',
    '00000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-000000000003', '%s')->>'outcome'$f$;
  v_pid int;
  v_name text;
begin
  perform dblink_connect('setup', v_dsn);
  perform dblink_exec('setup', v_clean);
  begin
    perform dblink_connect('a', v_dsn);
    perform dblink_connect('b', v_dsn);
    perform dblink_exec('setup', $f$
      insert into auth.users(id, email) values ('00000000-0000-4000-a000-000000000001', 'grant-race@example.test');
      insert into public.remote_access_accounts(user_id) values ('00000000-0000-4000-a000-000000000001');
      insert into public.remote_hosts(id, owner_id, label, hostname, public_key, key_fingerprint, platform, arch, endpoint, epoch)
        values ('00000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-000000000001', 'Race', 'race',
          repeat('c', 42) || 'A', 'abcd-abcd-abcd-abcd', 'linux', 'x64', null, 1);
      insert into public.remote_clients(id, owner_id, label, kind) values ('00000000-0000-4000-a000-000000000003',
        '00000000-0000-4000-a000-000000000001', 'Desktop', 'desktop');
      insert into public.remote_grant_sessions(sid, owner_id, last_issued_at) values
        ('00000000-0000-4000-a000-000000000010', '00000000-0000-4000-a000-000000000001', now() - interval '11 minutes')$f$);
    select p into v_pid from dblink('b', 'select pg_backend_pid()') as t(p int);
    perform dblink_exec('a', 'set role service_role');
    perform dblink_exec('b', 'set role service_role');
    -- Race 1: a transaction refreshes an expired session while another issue's cleanup selects it.
    perform dblink_exec('a', 'begin');
    perform dblink_exec('a', $f$update public.remote_grant_sessions set last_issued_at = now()
      where sid = '00000000-0000-4000-a000-000000000010'$f$);
    perform dblink_send_query('b', format(v_issue, '00000000-0000-4000-a000-000000000011'));
    insert into race values ('refresh-waits', pg_temp.race_blocked(v_pid)::text);
    perform dblink_exec('a', 'commit');
    insert into race select 'refresh-issue', o from dblink_get_result('b') as t(o text);
    perform * from dblink_get_result('b') as t(o text);
    insert into race select 'refresh-kept', n::text from dblink('setup', $f$select count(*)
      from public.remote_grant_sessions where sid = '00000000-0000-4000-a000-000000000010'$f$) as t(n bigint);
    -- Race 2: two issues for new sessions when the owner holds 99 in the window (010, 011, 97).
    perform dblink_exec('setup', $f$insert into public.remote_grant_sessions(sid, owner_id)
      select ('00000000-0000-4000-a000-' || lpad(i::text, 12, '0'))::uuid, '00000000-0000-4000-a000-000000000001'
      from generate_series(100, 196) i$f$);
    perform dblink_exec('a', 'begin');
    insert into race select 'cap-first', o from dblink('a', format(v_issue, '00000000-0000-4000-a000-000000000200')) as t(o text);
    perform dblink_send_query('b', format(v_issue, '00000000-0000-4000-a000-000000000201'));
    insert into race values ('cap-waits', pg_temp.race_blocked(v_pid)::text);
    perform dblink_exec('a', 'commit');
    insert into race select 'cap-second', o from dblink_get_result('b') as t(o text);
    perform * from dblink_get_result('b') as t(o text);
    insert into race select 'cap-count', n::text from dblink('setup', $f$select count(*)
      from public.remote_grant_sessions where owner_id = '00000000-0000-4000-a000-000000000001'$f$) as t(n bigint);
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
select is((select value from race where name = 'refresh-waits'), 'true',
  'cleanup waits for the transaction refreshing an expired session');
select is((select value from race where name = 'refresh-issue'), 'issued', 'the waiting issue completes');
select is((select value from race where name = 'refresh-kept'), '1',
  'a session refreshed during cleanup is kept');
select is((select value from race where name = 'cap-first'), 'issued', 'the 100th session is admitted');
select is((select value from race where name = 'cap-waits') || ' ' || (select value from race where name = 'cap-second'),
  'true too-many-requests', 'a concurrent 101st session waits for the account lock and is refused');
select is((select value from race where name = 'cap-count'), '100', 'the owner holds exactly 100 sessions');
select * from finish();
rollback;
