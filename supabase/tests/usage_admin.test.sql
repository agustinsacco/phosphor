begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- Privileges: nothing here is reachable from a browser, and service_role cannot
-- read or write the administrator table at all.
select ok(not has_table_privilege(r, t, p), r || ' has no ' || p || ' on ' || t)
  from (values ('anon'), ('authenticated')) roles(r),
    (values ('public.usage_daily'), ('public.usage_downloads')) tabs(t),
    (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) privs(p);
select ok(not has_table_privilege('service_role', t, 'DELETE'), 'service cannot delete from ' || t)
  from (values ('public.usage_daily'), ('public.usage_downloads')) tabs(t);
select ok(not has_table_privilege(r, 'control_private.admins', p), r || ' has no ' || p || ' on admins')
  from (values ('anon'), ('authenticated'), ('service_role')) roles(r),
    (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) privs(p);
select is((select count(*) from pg_class where oid in ('public.usage_daily'::regclass,
  'public.usage_downloads'::regclass, 'control_private.admins'::regclass) and relrowsecurity),
  3::bigint, 'usage and admin tables have RLS');
select is((select count(*) from pg_policy where polrelid in ('public.usage_daily'::regclass,
  'public.usage_downloads'::regclass, 'control_private.admins'::regclass)), 0::bigint, 'no client policies');
select ok(not exists (select 1 from pg_publication_tables where schemaname = 'public'
  and tablename in ('usage_daily', 'usage_downloads')), 'usage is not published to Realtime');
select is((select count(*) from pg_constraint where contype = 'f' and conrelid in
  ('public.usage_daily'::regclass, 'public.usage_downloads'::regclass)), 0::bigint,
  'usage rows reference no user, Host or client');
select ok(not has_function_privilege(r, f, 'EXECUTE'), r || ' cannot execute ' || f)
  from (values ('anon'), ('authenticated')) roles(r),
    (values ('public.control_usage_ping(text,text,text,text,boolean,boolean,boolean)'),
      ('public.control_usage_download(text)'), ('public.control_admin_check(uuid,text)'),
      ('public.control_admin_stats()'), ('public.control_account_delete(uuid)')) funcs(f);
select ok(has_function_privilege('service_role', f, 'EXECUTE'), 'service can execute ' || f)
  from (values ('public.control_usage_ping(text,text,text,text,boolean,boolean,boolean)'),
    ('public.control_usage_download(text)'), ('public.control_admin_check(uuid,text)'),
    ('public.control_admin_stats()'), ('public.control_account_delete(uuid)')) funcs(f);

-- The administrator table admits one GitHub account id and nothing else.
select throws_ok($$insert into control_private.admins(github_id) values ('42')$$, '23514', null,
  'another GitHub id is refused');
select throws_ok($$insert into control_private.admins(github_id) values ('agustinsacco')$$, '23514', null,
  'a login is refused');
select lives_ok($$insert into control_private.admins(github_id) values ('5874561')$$, 'the owner row inserts');
select throws_ok($$insert into control_private.admins(github_id) values ('5874561')$$, '23505', null,
  'the owner row is unique');
delete from control_private.admins;

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.test', '{"user_name":"agustinsacco"}'),
  ('00000000-0000-4000-8000-000000000002', 'claims@example.test', '{"user_name":"agustinsacco"}'),
  ('00000000-0000-4000-8000-000000000003', 'other@example.test', '{}');
insert into auth.identities(provider_id, user_id, identity_data, provider) values
  ('5874561', '00000000-0000-4000-8000-000000000001', '{"sub":"5874561"}', 'github'),
  ('42', '00000000-0000-4000-8000-000000000002', '{"sub":"42","user_name":"agustinsacco"}', 'github'),
  ('5874561', '00000000-0000-4000-8000-000000000003', '{"sub":"5874561"}', 'gitlab');

set local role service_role;
select is(public.control_admin_check('00000000-0000-4000-8000-000000000001', '5874561'), false,
  'no administrator while the table is empty');
reset role;
insert into control_private.admins(github_id) values ('5874561');
set local role service_role;
select is(public.control_admin_check('00000000-0000-4000-8000-000000000001', '5874561'), true,
  'the owner GitHub identity is the administrator');
select is(public.control_admin_check('00000000-0000-4000-8000-000000000002', '5874561'), false,
  'a user whose metadata claims the login is not');
select is(public.control_admin_check('00000000-0000-4000-8000-000000000003', '5874561'), false,
  'the same id from another provider is not');
select is(public.control_admin_check('00000000-0000-4000-8000-000000000001', '42'), false,
  'a different server constant is not');
select is(public.control_admin_check('00000000-0000-4000-8000-000000000002', '42'), false,
  'another GitHub account is not');
select is(public.control_admin_check(null, null), false, 'nulls are not');
select throws_ok('select * from control_private.admins', '42501', null, 'service cannot read admins');
select throws_ok($$insert into control_private.admins values ('5874561')$$, '42501', null,
  'service cannot add an administrator');
select throws_ok('delete from control_private.admins', '42501', null, 'service cannot remove one');
reset role;
delete from control_private.admins;
set local role service_role;
select is(public.control_admin_check('00000000-0000-4000-8000-000000000001', '5874561'), false,
  'deleting the row revokes the administrator');

-- Pings add to one counter row per UTC day and release facts.
select is(public.control_usage_ping('desktop', '0.1.542', 'darwin', 'arm64', true, true, true)->>'outcome',
  'counted', 'a first ping is counted');
select public.control_usage_ping('desktop', '0.1.542', 'darwin', 'arm64', false, false, false);
select public.control_usage_ping('desktop', '0.1.542', 'darwin', 'arm64', false, true, false);
select public.control_usage_ping('desktop', '0.1.542', 'darwin', 'arm64', true, false, false);
select is((select row(pings, firsts, weeks, months)::text from public.usage_daily
  where version = '0.1.542'), '(4,2,3,2)', 'a first ping also counts as new in its week and month');
set local timezone = 'Pacific/Kiritimati';
select public.control_usage_ping('desktop', '0.1.541', 'linux', 'x64', false, false, false);
reset timezone;
select is((select array_agg(distinct day) from public.usage_daily),
  array[(now() at time zone 'UTC')::date], 'the day is UTC whatever the session time zone');
select throws_ok($$select public.control_usage_ping('desktop', '0.1.542-dev', 'darwin', 'arm64', false, false, false)$$,
  '23514', null, 'a dev version is refused');
select throws_ok($$select public.control_usage_ping('web', '0.1.542', 'darwin', 'arm64', false, false, false)$$,
  '23514', null, 'an unknown product is refused');
select throws_ok($$select public.control_usage_ping('host', '0.1.542', 'freebsd', 'x64', false, false, false)$$,
  '23514', null, 'an unknown OS is refused');
select throws_ok($$select public.control_usage_ping('host', '0.1.542', 'linux', 'ia32', false, false, false)$$,
  '23514', null, 'an unknown architecture is refused');
select throws_ok($$select public.control_usage_ping('host', '0.1.542', 'linux', 'x64', null, false, false)$$,
  '23502', null, 'a null flag is refused');

select is(public.control_usage_download('install-sh')->>'outcome', 'counted', 'a download is counted');
select public.control_usage_download('install-sh');
select public.control_usage_download('latest');
select is((select downloads from public.usage_downloads where artifact = 'install-sh'), 2::bigint,
  'downloads add up per artifact');
select throws_ok($$select public.control_usage_download('../etc/passwd')$$, '23514', null,
  'an unknown artifact is refused');

-- The summary: aggregates only, with small breakdown cells suppressed.
reset role;
insert into public.usage_daily(day, product, version, os, arch, pings, firsts, weeks, months) values
  ((now() at time zone 'UTC')::date - 1, 'host', '0.2.16', 'linux', 'x64', 5, 1, 2, 2),
  ((now() at time zone 'UTC')::date - 1, 'host', '0.2.15', 'linux', 'arm64', 2, 0, 0, 0),
  ((now() at time zone 'UTC')::date - 200, 'host', '0.1.1', 'linux', 'x64', 9, 9, 9, 9);
insert into public.remote_access_accounts(user_id, login) values
  ('00000000-0000-4000-8000-000000000001', 'agustinsacco'),
  ('00000000-0000-4000-8000-000000000002', 'secretlogin');
insert into public.remote_hosts(owner_id, label, hostname, public_key, key_fingerprint, platform, arch,
    last_seen_at, state, revoked_at) values
  ('00000000-0000-4000-8000-000000000001', 'Secret Lab', 'secret-host', repeat('a', 42) || 'A',
    'abcd-abcd-abcd-abcd', 'linux', 'x64', now(), 'running', null),
  ('00000000-0000-4000-8000-000000000002', 'Other', 'other-host', repeat('b', 42) || 'A',
    'abcd-abcd-abcd-abce', 'linux', 'x64', now() - interval '2 hours', 'running', null),
  ('00000000-0000-4000-8000-000000000002', 'Gone', 'gone-host', repeat('c', 42) || 'A',
    'abcd-abcd-abcd-abcf', 'linux', 'x64', now(), 'running', now());
insert into public.remote_clients(owner_id, kind, label) values
  ('00000000-0000-4000-8000-000000000002', 'web', 'Browser');
create temporary table stats (s jsonb);
grant all on stats to service_role;
set local role service_role;
insert into stats select public.control_admin_stats();
select is((select s->'accounts' from stats), '{"total":2,"new7d":2,"new30d":2}'::jsonb, 'account counts');
select is((select s->'hosts' from stats), '{"enrolled":2,"online":1,"seen24h":2}'::jsonb,
  'Host counts skip revoked machines');
select is((select s->'downloads'->'byArtifact30d' from stats),
  '[{"artifact":"install-sh","downloads":2},{"artifact":"latest","downloads":1}]'::jsonb,
  'downloads by artifact, busiest first');
select is((select s->'downloads'->>'total' from stats), '3', 'download total');
select is((select s->'usage'->'desktop' from stats),
  '{"day":0,"week":3,"lastWeek":0,"month":2,"lastMonth":0,"new7d":2,"new30d":2}'::jsonb, 'desktop totals');
select is((select (s->'usage'->'host'->>'day')::int from stats), 7, 'host installs active yesterday');
select is((select (s->'usage'->'host'->>'week')::int + (s->'usage'->'host'->>'lastWeek')::int from stats), 2,
  'yesterday counts toward this week or the last');
select is((select (s->'usage'->'host'->>'new30d')::int from stats), 1, 'old installs fall out of new30d');
select is((select jsonb_array_length(s->'series') from stats), 90, 'ninety days of series');
select is((select s->'series'->89 from stats), jsonb_build_object('day',
  to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD'), 'desktop', 5, 'host', 0, 'installs', 2,
  'downloads', 3), 'the series ends today');
select is((select s->'versions' from stats), '[{"product":"host","version":"0.2.16","pings":5},
  {"product":"desktop","version":"0.1.542","pings":4},{"product":"desktop","version":"0.1.541","pings":null},
  {"product":"host","version":"0.2.15","pings":null}]'::jsonb, 'small version cells are suppressed');
select ok((select s->'platforms' @> '[{"product":"host","os":"linux","arch":"arm64","pings":null}]' from stats),
  'small platform cells are suppressed');
select ok((select s::text !~* '(login|email|label|hostname|owner|user|secret|agustinsacco)' from stats),
  'no person, login, label or hostname leaves the summary');

-- Account deletion removes the user and everything that references them.
select is(public.control_account_delete('00000000-0000-4000-8000-000000000002')->>'outcome', 'deleted',
  'an account is deleted');
select is(public.control_account_delete('00000000-0000-4000-8000-000000000002')->>'outcome', 'not-found',
  'a second delete finds nothing');
select is(public.control_account_delete(null)->>'outcome', 'not-found', 'a null id deletes nothing');
reset role;
select is((select count(*) from auth.users where id = '00000000-0000-4000-8000-000000000002'), 0::bigint, 'user gone');
select is((select count(*) from auth.identities where user_id = '00000000-0000-4000-8000-000000000002'),
  0::bigint, 'identities gone');
select is((select count(*) from public.remote_access_accounts where user_id = '00000000-0000-4000-8000-000000000002'),
  0::bigint, 'account row gone');
select is((select count(*) from public.remote_hosts where owner_id = '00000000-0000-4000-8000-000000000002'),
  0::bigint, 'their Hosts gone');
select is((select count(*) from public.remote_clients where owner_id = '00000000-0000-4000-8000-000000000002'),
  0::bigint, 'their clients gone');
select is((select count(*) from auth.users where id = '00000000-0000-4000-8000-000000000001'), 1::bigint,
  'other users stay');
select is((select count(*) from public.remote_hosts), 1::bigint, 'other Hosts stay');
select is((select sum(pings) from public.usage_daily), 21::numeric, 'anonymous counters stay');
select * from finish();
rollback;
