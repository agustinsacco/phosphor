begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
-- Owner 1 holds Alpha (a1), Bravo (b1) and Charlie (c1); owner 2 holds Delta (d1).
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000001', 'machine-owner@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'machine-other@example.test');
insert into public.remote_access_accounts(user_id, enabled) values
  ('00000000-0000-4000-8000-000000000001', true), ('00000000-0000-4000-8000-000000000002', true);
insert into public.remote_hosts(id, owner_id, label, hostname, public_key, key_fingerprint, platform, arch,
  endpoint, epoch, state, last_seen_at) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Alpha', 'alpha',
    repeat('a',42)||'A', 'abcd-abcd-abcd-abcd', 'linux', 'x64', 'https://alpha.ts.net', 1, 'running', now()),
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001', 'Bravo', 'bravo',
    repeat('b',42)||'A', 'abcd-abcd-abcd-abcd', 'linux', 'x64', 'https://bravo.ts.net', 3, 'running', now()),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'Charlie', 'charlie',
    repeat('c',42)||'A', 'abcd-abcd-abcd-abcd', 'darwin', 'arm64', null, 1, null, null),
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000002', 'Delta', 'delta',
    repeat('d',42)||'A', 'abcd-abcd-abcd-abcd', 'linux', 'x64', 'https://delta.ts.net', 1, 'running', now());
create temporary table machine_context (name text primary key, value jsonb);
grant all on machine_context to service_role, anon, authenticated;
insert into machine_context select 'call-' || p.proname, to_jsonb(format('select public.%I(%s)', p.proname,
  (select string_agg('null::' || format_type(t, null), ', ' order by ord)
    from unnest(p.proargtypes::oid[]) with ordinality a(t, ord))))
  from pg_proc p where p.oid in ('public.control_machine_beat(uuid,boolean)'::regprocedure,
    'public.control_machine_grant_issue(uuid,uuid)'::regprocedure, 'public.control_machine_directory(uuid)'::regprocedure,
    'public.control_machine_reach_set(uuid,uuid,boolean)'::regprocedure, 'public.control_machine_reach_list(uuid)'::regprocedure);

-- Schema, functions and access.
select is((select count(*) from machine_context), 5::bigint, 'five machine functions exist');
select ok((select not prosecdef and proconfig = array['search_path=""'] and proname ~ '^control_[a-z_]{1,64}$'
  from pg_proc where oid = f::regprocedure), f || ' is an invoker with empty search_path and a valid RPC name')
  from (values ('public.control_machine_beat(uuid,boolean)'), ('public.control_machine_grant_issue(uuid,uuid)'),
    ('public.control_machine_directory(uuid)'), ('public.control_machine_reach_set(uuid,uuid,boolean)'),
    ('public.control_machine_reach_list(uuid)')) funcs(f);
select ok(has_function_privilege('service_role', f, 'EXECUTE') and not has_function_privilege('anon', f, 'EXECUTE')
  and not has_function_privilege('authenticated', f, 'EXECUTE'), f || ' executes for service_role only')
  from (values ('public.control_machine_beat(uuid,boolean)'), ('public.control_machine_grant_issue(uuid,uuid)'),
    ('public.control_machine_directory(uuid)'), ('public.control_machine_reach_set(uuid,uuid,boolean)'),
    ('public.control_machine_reach_list(uuid)')) funcs(f);
select ok((select relrowsecurity from pg_class where oid = 'public.remote_machine_principals'::regclass), 'principals have RLS');
select is((select count(*) from pg_policy where polrelid = 'public.remote_machine_principals'::regclass), 0::bigint,
  'principals have no client policies');
select is((select count(*) from public.remote_hosts where machine_reach is not true), 0::bigint, 'reach defaults on');
select is((select count(*) from public.remote_hosts where machine_grants is not null), 0::bigint, 'support defaults unknown');
set local role anon;
select throws_ok(value #>> '{}', '42501', null, 'anon cannot call ' || name) from machine_context where name like 'call-%';
select throws_ok('select * from public.remote_machine_principals', '42501', null, 'anon cannot read principals');
set local role authenticated;
select throws_ok(value #>> '{}', '42501', null, 'authenticated cannot call ' || name) from machine_context where name like 'call-%';
select throws_ok('select * from public.remote_machine_principals', '42501', null, 'authenticated cannot read principals');
select throws_ok('insert into public.remote_machine_principals(host_id, owner_id) values (null, null)', '42501', null,
  'authenticated cannot write principals');
set local role service_role;

-- Beat: records support only when it changes and answers reach and revoked principals.
select is(public.control_machine_beat('00000000-0000-4000-8000-0000000000ff', true), '{"outcome":"gone"}'::jsonb, 'unknown Host is gone');
select is(public.control_machine_beat('00000000-0000-4000-8000-0000000000a1', true),
  jsonb_build_object('outcome', 'ok', 'machineReach', true, 'revoked', '[]'::jsonb), 'beat answers reach and no revocations');
select is((select machine_grants from public.remote_hosts where id = '00000000-0000-4000-8000-0000000000a1'), true, 'support recorded');
insert into machine_context select 'ctid-a', to_jsonb(ctid::text) from public.remote_hosts where id = '00000000-0000-4000-8000-0000000000a1';
select public.control_machine_beat('00000000-0000-4000-8000-0000000000a1', true);
select is((select ctid::text from public.remote_hosts where id = '00000000-0000-4000-8000-0000000000a1'),
  (select value #>> '{}' from machine_context where name = 'ctid-a'), 'an unchanged beat writes nothing');
select public.control_machine_beat('00000000-0000-4000-8000-0000000000b1', true);
select is(public.control_machine_beat('00000000-0000-4000-8000-0000000000c1', null)->>'outcome', 'ok', 'an old Host beats with null');
select is((select machine_grants from public.remote_hosts where id = '00000000-0000-4000-8000-0000000000c1'), null::boolean, 'null support kept');

-- Issue refusals.
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1')->>'outcome',
  'not-found', 'a machine cannot target itself');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000ff', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'gone', 'unknown caller is gone');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000d1')->>'outcome',
  'not-found', 'another owner''s machine is not found');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1')->>'outcome',
  'target-unavailable', 'a target that never reported support is unavailable');
update public.remote_hosts set machine_grants = true, state = 'running', last_seen_at = now()
  where id = '00000000-0000-4000-8000-0000000000c1';
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1')->>'outcome',
  'target-unavailable', 'a target without an endpoint is unavailable');
update public.remote_hosts set last_seen_at = now() - interval '91 seconds' where id = '00000000-0000-4000-8000-0000000000b1';
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'target-unavailable', 'a stale target is unavailable');
update public.remote_hosts set last_seen_at = now(), state = 'stopping' where id = '00000000-0000-4000-8000-0000000000b1';
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'target-unavailable', 'a stopping target is unavailable');
update public.remote_hosts set state = 'running', machine_grants = false where id = '00000000-0000-4000-8000-0000000000b1';
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'target-unavailable', 'an old target is unavailable');
update public.remote_hosts set machine_grants = true where id = '00000000-0000-4000-8000-0000000000b1';
update public.remote_access_accounts set enabled = false where user_id = '00000000-0000-4000-8000-000000000001';
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'account-disabled', 'a disabled account issues nothing');
select is(public.control_machine_directory('00000000-0000-4000-8000-0000000000a1')->>'outcome',
  'account-disabled', 'a disabled account lists nothing');
update public.remote_access_accounts set enabled = true where user_id = '00000000-0000-4000-8000-000000000001';
select is((select count(*) from public.remote_machine_principals), 0::bigint, 'refusals mint no principal');

-- Issue.
insert into machine_context values ('issue', public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000b1'));
select is((select value - 'sid' - 'client' from machine_context where name = 'issue'), jsonb_build_object('outcome', 'issued',
  'ownerId', '00000000-0000-4000-8000-000000000001', 'epoch', 3, 'publicKey', repeat('b',42)||'A',
  'endpoint', 'https://bravo.ts.net'), 'issue answers the target''s identity metadata');
select is((select value->'client' from machine_context where name = 'issue'), (select jsonb_build_object('id', id, 'label', 'Alpha')
  from public.remote_machine_principals where host_id = '00000000-0000-4000-8000-0000000000a1' and revoked_at is null),
  'the client is the caller''s principal, labelled with the caller');
select is((select value->>'sid' from machine_context where name = 'issue'), (select sid::text from public.remote_machine_principals
  where host_id = '00000000-0000-4000-8000-0000000000a1'), 'the sid is the principal''s');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')->'client',
  (select value->'client' from machine_context where name = 'issue'), 'a principal is stable across issues');
select is((select count(*) from public.remote_machine_principals), 1::bigint, 'one principal per caller');
select is((select count(*) from public.remote_grant_sessions where owner_id = '00000000-0000-4000-8000-000000000001'), 0::bigint,
  'the principal sid is not a grant session');
select ok(not (public.control_host_revocations('00000000-0000-4000-8000-0000000000b1')->'revoked'->'sessions'
  ? (select value->>'sid' from machine_context where name = 'issue')), 'v1 revocations never list the principal sid');
select ok(not (public.control_host_revocations('00000000-0000-4000-8000-0000000000b1')->'revoked'->'clients'
  ? (select value->'client'->>'id' from machine_context where name = 'issue')), 'v1 revocations never list a live principal');
select is(public.control_machine_beat('00000000-0000-4000-8000-0000000000b1', true)->'revoked', '[]'::jsonb,
  'a live principal is not revoked');

-- Reach.
select is(public.control_machine_reach_set('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a1', false)->>'outcome',
  'not-found', 'another owner cannot switch reach');
select is(public.control_machine_reach_set('00000000-0000-4000-8000-0000000000ff', '00000000-0000-4000-8000-0000000000a1', false)->>'outcome',
  'not-found', 'an unknown account cannot switch reach');
select is(public.control_machine_reach_set('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b1', false),
  '{"outcome":"set","machineReach":false}'::jsonb, 'owner switches a target off');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'reach-off', 'a target with reach off is refused');
select is(public.control_machine_beat('00000000-0000-4000-8000-0000000000b1', true)->'machineReach', 'false'::jsonb,
  'the target learns reach is off');
select is(public.control_machine_reach_set('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b1', true),
  '{"outcome":"set","machineReach":true}'::jsonb, 'owner switches it back on');
select is(public.control_machine_reach_set('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', false)->>'outcome',
  'set', 'owner switches a caller off');
select ok((select revoked_at = now() from public.remote_machine_principals
  where id = (select (value->'client'->>'id')::uuid from machine_context where name = 'issue')), 'switching off revokes the principal');
select is(public.control_machine_beat('00000000-0000-4000-8000-0000000000b1', true)->'revoked',
  jsonb_build_array((select value->'client'->>'id' from machine_context where name = 'issue')),
  'the next beat lists the revoked principal');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'reach-off', 'a caller with reach off is refused');
select public.control_machine_reach_set('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', true);
insert into machine_context values ('reissue', public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000b1'));
select ok((select value->>'outcome' = 'issued' from machine_context where name = 'reissue')
  and (select value->'client'->>'id' from machine_context where name = 'reissue')
    <> (select value->'client'->>'id' from machine_context where name = 'issue'), 're-enabling mints a new principal');

-- Directory.
select is(public.control_machine_directory('00000000-0000-4000-8000-0000000000ff'), '{"outcome":"gone"}'::jsonb, 'unknown Host lists nothing');
insert into machine_context values ('directory', public.control_machine_directory('00000000-0000-4000-8000-0000000000a1'));
select is((select value->'self' from machine_context where name = 'directory'), jsonb_build_object('id',
  '00000000-0000-4000-8000-0000000000a1', 'label', 'Alpha', 'machineReach', true), 'directory names the caller');
select is((select value->>'serverTime' from machine_context where name = 'directory'), control_private.iso(now()), 'directory server time');
select is((select value->'machines' from machine_context where name = 'directory'), jsonb_build_array(
  jsonb_build_object('id', '00000000-0000-4000-8000-0000000000b1', 'label', 'Bravo', 'hostVersion', null,
    'lastSeenAt', control_private.iso(now()), 'state', 'running', 'readiness', null, 'machineGrants', true,
    'machineReach', true, 'reachable', true),
  jsonb_build_object('id', '00000000-0000-4000-8000-0000000000c1', 'label', 'Charlie', 'hostVersion', null,
    'lastSeenAt', control_private.iso(now()), 'state', 'running', 'readiness', null, 'machineGrants', true,
    'machineReach', true, 'reachable', false)),
  'directory lists the owner''s other machines without hostname, key or endpoint');
select public.control_machine_reach_set('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', false);
select is(public.control_machine_directory('00000000-0000-4000-8000-0000000000a1')->'machines', '[]'::jsonb,
  'a caller with reach off sees no siblings');
select public.control_machine_reach_set('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', true);
select is(public.control_machine_reach_list('00000000-0000-4000-8000-000000000001'), jsonb_build_array(
  jsonb_build_object('id', '00000000-0000-4000-8000-0000000000a1', 'machineReach', true, 'machineGrants', true),
  jsonb_build_object('id', '00000000-0000-4000-8000-0000000000b1', 'machineReach', true, 'machineGrants', true),
  jsonb_build_object('id', '00000000-0000-4000-8000-0000000000c1', 'machineReach', true, 'machineGrants', true)),
  'reach list covers the owner''s machines only');

-- Principal cap and the bounded revocation list.
update public.remote_hosts set endpoint = 'https://charlie.ts.net' where id = '00000000-0000-4000-8000-0000000000c1';
insert into public.remote_machine_principals(host_id, owner_id, revoked_at)
  select '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001', now() - i * interval '1 second'
  from generate_series(1, 38) i;
select is((select count(*) from public.remote_machine_principals), 40::bigint, 'owner holds 40 live or recent principals');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'too-many-requests', 'a 41st principal is refused');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'issued', 'a live principal still renews at the cap');
-- Rows inserted directly, past what admission allows: the list itself stays bounded.
insert into public.remote_machine_principals(host_id, owner_id, revoked_at)
  select '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001', now() - interval '1 minute'
  from generate_series(1, 10);
select is(jsonb_array_length(public.control_machine_beat('00000000-0000-4000-8000-0000000000b1', true)->'revoked'), 40,
  'revoked principals capped at 40');
select is(public.control_machine_beat('00000000-0000-4000-8000-0000000000b1', true)->'revoked'->>0,
  (select value->'client'->>'id' from machine_context where name = 'issue'), 'most recent revocation first');
select is(jsonb_array_length(public.control_machine_beat('00000000-0000-4000-8000-0000000000d1', true)->'revoked'), 0,
  'another owner sees none of them');
update public.remote_machine_principals set revoked_at = now() - interval '10 minutes' where revoked_at is not null;
select is(jsonb_array_length(public.control_machine_beat('00000000-0000-4000-8000-0000000000b1', true)->'revoked'), 40,
  'exact ten-minute boundary included');
update public.remote_machine_principals set revoked_at = revoked_at - interval '1 microsecond' where revoked_at is not null;
select is(jsonb_array_length(public.control_machine_beat('00000000-0000-4000-8000-0000000000b1', true)->'revoked'), 0,
  'older revocations excluded');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'issued', 'revocations leaving the window free a slot');

-- Cleanup deletes only the caller owner's day-old rows.
insert into public.remote_machine_principals(host_id, owner_id, revoked_at) values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000002', now() - interval '2 days');
update public.remote_machine_principals set revoked_at = now() - interval '2 days'
  where owner_id = '00000000-0000-4000-8000-000000000001' and revoked_at is not null;
select public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1');
select is((select count(*) from public.remote_machine_principals where owner_id = '00000000-0000-4000-8000-000000000001'
  and revoked_at is not null), 0::bigint, 'day-old revoked principals are cleaned up');
select is((select count(*) from public.remote_machine_principals where owner_id = '00000000-0000-4000-8000-000000000002'),
  1::bigint, 'another owner''s rows are left alone');

-- A caller removed through the unchanged v1 path: its principal is listed through the join.
select is(public.control_machine_revoke('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1')->>'outcome',
  'revoked', 'v1 removal');
select is(public.control_machine_beat('00000000-0000-4000-8000-0000000000b1', true)->'revoked',
  jsonb_build_array((select value->'client'->>'id' from machine_context where name = 'reissue')),
  'a removed caller''s live principal is listed as revoked');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')->>'outcome',
  'gone', 'a removed caller is gone');
select is(public.control_machine_grant_issue('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1')->>'outcome',
  'not-found', 'a removed target is not found');
select is(public.control_machine_beat('00000000-0000-4000-8000-0000000000a1', true), '{"outcome":"gone"}'::jsonb,
  'a removed Host''s beat is gone');
select * from finish();
rollback;
