begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000001', 'grant-owner@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'grant-other@example.test');
insert into public.remote_access_accounts(user_id) values
  ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
insert into public.remote_hosts(id, owner_id, label, hostname, public_key, key_fingerprint, platform, arch, endpoint, epoch) values
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'Bee', 'bee', repeat('a',42)||'A', 'abcd-abcd-abcd-abcd', 'linux', 'x64', 'https://bee.ts.net', 2),
  ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002', 'Other', 'other', repeat('b',42)||'A', 'abcd-abcd-abcd-abcd', 'linux', 'x64', null, 1);
create temporary table grant_context (name text primary key, value jsonb);
grant all on grant_context to service_role, anon, authenticated;
insert into grant_context select p.proname, to_jsonb(format('select public.%I(%s)', p.proname,
  (select string_agg('null::' || format_type(t, null), ', ' order by ord)
    from unnest(p.proargtypes::oid[]) with ordinality a(t, ord))))
  from pg_proc p where p.oid in ('public.control_client_register(uuid,text,text)'::regprocedure,
    'public.control_client_revoke(uuid,uuid)'::regprocedure, 'public.control_grant_issue(uuid,uuid,uuid,uuid)'::regprocedure,
    'public.control_host_revocations(uuid)'::regprocedure);
select ok((select relrowsecurity from pg_class where oid='public.remote_grant_sessions'::regclass), 'session table has RLS');
select is((select count(*) from pg_policy where polrelid='public.remote_grant_sessions'::regclass), 0::bigint, 'session table has no policies');
set local role anon;
select throws_ok(value #>> '{}', '42501', null, 'anon cannot call ' || name) from grant_context;
select throws_ok('select * from public.remote_grant_sessions', '42501', null, 'anon cannot read sessions');
set local role authenticated;
select throws_ok(value #>> '{}', '42501', null, 'authenticated cannot call ' || name) from grant_context;
select throws_ok('select * from public.remote_grant_sessions', '42501', null, 'authenticated cannot read sessions');
select throws_ok('insert into public.remote_grant_sessions default values', '42501', null, 'authenticated cannot write sessions');
set local role service_role;
select throws_ok('select id from auth.sessions limit 0', '42501', null, 'service role cannot read auth session ids: definer is necessary');
insert into grant_context values ('client', public.control_client_register('00000000-0000-4000-8000-000000000001','Desktop','desktop'));
select is((select value->>'outcome' from grant_context where name='client'), 'registered', 'register succeeds');
select is((select value->'client'->>'label' from grant_context where name='client'), 'Desktop', 'registered label returned');
select is((select kind from public.remote_clients), 'desktop', 'kind recorded');
select is(public.control_client_register('00000000-0000-4000-8000-000000000001', 'Desktop ' || i, 'desktop')->>'outcome', 'registered', 'registration accepted through cap ' || i)
  from generate_series(2,20) i;
select is(public.control_client_register('00000000-0000-4000-8000-000000000001','Extra','desktop')->>'outcome', 'too-many-requests', '21st client refused');
select is((select count(*) from public.remote_clients where revoked_at is null),20::bigint,'cap does not insert');
select is(public.control_client_revoke('00000000-0000-4000-8000-000000000002', (select (value->'client'->>'id')::uuid from grant_context where name='client'))->>'outcome','not-found','other owner cannot revoke');
select is(public.control_grant_issue('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004',
  (select (value->'client'->>'id')::uuid from grant_context where name='client'), '00000000-0000-4000-8000-000000000010')->>'outcome','not-found','other host refused');
select is(public.control_grant_issue('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000004',
  (select (value->'client'->>'id')::uuid from grant_context where name='client'), '00000000-0000-4000-8000-000000000010')->>'outcome','not-found','other client refused');
select is((select count(*) from public.remote_grant_sessions),0::bigint,'denials do not track sessions');
insert into grant_context values ('grant', public.control_grant_issue('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
  (select (value->'client'->>'id')::uuid from grant_context where name='client'), '00000000-0000-4000-8000-000000000010'));
select is((select value from grant_context where name='grant'),jsonb_build_object('outcome','issued','epoch',2,
  'publicKey',repeat('a',42)||'A','endpoint','https://bee.ts.net','client',(select value->'client' from grant_context where name='client')), 'issue returns validated identity metadata');
select is((select owner_id from public.remote_grant_sessions where sid='00000000-0000-4000-8000-000000000010'), '00000000-0000-4000-8000-000000000001'::uuid,'session tracked for owner');
update public.remote_grant_sessions set last_issued_at=now()-interval '5 minutes';
select public.control_grant_issue('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',
  (select (value->'client'->>'id')::uuid from grant_context where name='client'),'00000000-0000-4000-8000-000000000010');
select is((select last_issued_at from public.remote_grant_sessions where sid='00000000-0000-4000-8000-000000000010'),now(),'upsert refreshes issuance');
select is(public.control_client_revoke('00000000-0000-4000-8000-000000000001', (select (value->'client'->>'id')::uuid from grant_context where name='client'))->>'outcome','revoked','owner revokes client');
select is(public.control_grant_issue('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',
  (select (value->'client'->>'id')::uuid from grant_context where name='client'),'00000000-0000-4000-8000-000000000011')->>'outcome','not-found','revoked client refused');
insert into grant_context values ('replacement',public.control_client_register('00000000-0000-4000-8000-000000000001','Replacement','desktop'));
select is((select value->>'outcome' from grant_context where name='replacement'),'registered','revocation frees a cap slot');
select throws_ok($$update public.remote_clients set label=repeat('x',81)$$,'23514',null,'81-unit label rejected');
select lives_ok($$update public.remote_clients set label=repeat('x',80)$$,'80-unit label accepted');
select throws_ok($$update public.remote_clients set label=U&'bad\2028label'$$,'23514',null,'line-separator label rejected');
select throws_ok($$update public.remote_clients set label=' untrimmed'$$,'23514',null,'untrimmed label rejected');
update public.remote_hosts set revoked_at=now() where id='00000000-0000-4000-8000-000000000003';
select is(public.control_grant_issue('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',
  (select (value->'client'->>'id')::uuid from grant_context where name='replacement'),'00000000-0000-4000-8000-000000000011')->>'outcome','not-found','revoked host refused');
select is(public.control_host_revocations('00000000-0000-4000-8000-000000000003')->>'outcome','gone','revoked host receives no metadata');
update public.remote_hosts set revoked_at=null where id='00000000-0000-4000-8000-000000000003';
reset role;
insert into auth.sessions(id,user_id) values ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001');
set local role service_role;
select is(public.control_host_revocations('00000000-0000-4000-8000-000000000003')->'revoked'->'sessions','[]'::jsonb,'live auth session not revoked');
reset role;
delete from auth.sessions where id='00000000-0000-4000-8000-000000000010';
set local role service_role;
select is(public.control_host_revocations('00000000-0000-4000-8000-000000000003')->'revoked'->'sessions', '["00000000-0000-4000-8000-000000000010"]'::jsonb,'deleted auth session listed');
select is(public.control_host_revocations('00000000-0000-4000-8000-000000000003')->>'ownerId','00000000-0000-4000-8000-000000000001','owner returned');
select is(public.control_host_revocations('00000000-0000-4000-8000-000000000003')->>'epoch','2','epoch returned');
update public.remote_grant_sessions set last_issued_at=now()-interval '10 minutes';
update public.remote_clients set revoked_at=now()-interval '10 minutes' where revoked_at is not null;
select is(jsonb_array_length(public.control_host_revocations('00000000-0000-4000-8000-000000000003')->'revoked'->'sessions'),1,'exact ten-minute session boundary included');
select is(jsonb_array_length(public.control_host_revocations('00000000-0000-4000-8000-000000000003')->'revoked'->'clients'),1,'exact ten-minute client boundary included');
update public.remote_grant_sessions set last_issued_at=last_issued_at-interval '1 microsecond';
update public.remote_clients set revoked_at=revoked_at-interval '1 microsecond' where revoked_at is not null;
select is(jsonb_array_length(public.control_host_revocations('00000000-0000-4000-8000-000000000003')->'revoked'->'sessions'),0,'older session excluded');
select is(jsonb_array_length(public.control_host_revocations('00000000-0000-4000-8000-000000000003')->'revoked'->'clients'),0,'older client excluded');
insert into public.remote_grant_sessions(sid,owner_id,last_issued_at)
  select ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid, '00000000-0000-4000-8000-000000000001', now()-i*interval '1 second' from generate_series(100,200) i;
insert into public.remote_clients(id,owner_id,label,kind,revoked_at)
  select ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid, '00000000-0000-4000-8000-000000000001', 'Revoked', 'desktop', now()-i*interval '1 second' from generate_series(100,200) i;
insert into public.remote_grant_sessions(sid,owner_id) values ('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000002');
insert into public.remote_clients(owner_id,label,kind,revoked_at) values ('00000000-0000-4000-8000-000000000002','Other','desktop',now());
insert into grant_context values ('revocations',public.control_host_revocations('00000000-0000-4000-8000-000000000003'));
select is(jsonb_array_length((select value->'revoked'->'sessions' from grant_context where name='revocations')),100,'session list capped at 100');
select is(jsonb_array_length((select value->'revoked'->'clients' from grant_context where name='revocations')),100,'client list capped at 100');
select is((select value->'revoked'->'sessions'->>0 from grant_context where name='revocations'),'00000000-0000-4000-8000-000000000100','sessions most recent first, other users excluded');
select is((select value->'revoked'->'clients'->>0 from grant_context where name='revocations'),'00000000-0000-4000-8000-000000000100','clients most recent first, other users excluded');
select ok(not ((select value->'revoked'->'sessions' from grant_context where name='revocations') ? '00000000-0000-4000-8000-000000000200'),'oldest over cap excluded');
select is(jsonb_array_length(public.control_host_revocations('00000000-0000-4000-8000-000000000004')->'revoked'->'sessions'),1,'other owner sees only own session');
select * from finish();
rollback;
