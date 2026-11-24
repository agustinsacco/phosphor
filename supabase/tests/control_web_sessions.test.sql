begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
select hasnt_function('public', 'control_web_client_status', 'the cookie-era status check is gone');
select ok(not prosecdef and proconfig = array['search_path=""'], proname || ' is a fixed-path invoker')
  from pg_proc where oid in ('public.control_web_session_create(uuid,text,uuid,text)'::regprocedure,
    'public.control_web_session_use(text)'::regprocedure, 'public.control_web_session_end(text)'::regprocedure,
    'public.control_nonce_claim(text,text,integer)'::regprocedure, 'public.control_web_clients_list(uuid)'::regprocedure);
select ok(not has_function_privilege(r, f, 'EXECUTE'), r || ' cannot execute ' || f)
  from (values ('anon'), ('authenticated')) roles(r),
    (values ('public.control_web_session_create(uuid,text,uuid,text)'), ('public.control_web_session_use(text)'),
      ('public.control_web_session_end(text)'), ('public.control_nonce_claim(text,text,integer)'),
      ('control_private.auth_session_alive(uuid,uuid)'), ('control_private.auth_session_end(uuid,uuid)')) funcs(f);
select ok(has_function_privilege('service_role', 'public.control_web_session_use(text)', 'EXECUTE'), 'service admits sessions');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.remote_web_sessions'::regclass,
  'public.remote_request_nonces'::regclass)), 'session and nonce tables have RLS');
set local role authenticated;
select throws_ok('select * from public.remote_web_sessions', '42501', null, 'authenticated cannot read sessions');
select throws_ok('select * from public.remote_request_nonces', '42501', null, 'authenticated cannot read nonces');
reset role;
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000001','web@example.test'),
  ('00000000-0000-4000-8000-000000000002','other@example.test');
insert into auth.sessions(id, user_id) select ('00000000-0000-4000-8000-0000000001' || lpad(i::text, 2, '0'))::uuid,
  '00000000-0000-4000-8000-000000000001' from generate_series(1, 6) i;
create temporary table web (name text primary key, value jsonb);
grant all on web to service_role;
set local role service_role;
-- Sign-in provisions the account, a browser client and its session in one call.
insert into web values ('a', public.control_web_session_create('00000000-0000-4000-8000-000000000001', 'web',
  '00000000-0000-4000-8000-000000000101', repeat('a', 64)));
select is((select value->>'outcome' from web where name = 'a'), 'created', 'sign-in creates a session');
select is((select (kind, label, revoked_at is null)::text from public.remote_clients
  where id = (select (value->>'clientId')::uuid from web where name = 'a')), '(web,"Web browser",t)', 'as a live browser client');
select is((select login from public.remote_access_accounts where user_id = '00000000-0000-4000-8000-000000000001'), 'web', 'the account is provisioned');
select is(public.control_web_session_use(repeat('a', 64)), jsonb_build_object('outcome', 'active',
  'userId', '00000000-0000-4000-8000-000000000001', 'login', 'web', 'clientId', (select value->>'clientId' from web where name = 'a'),
  'sid', '00000000-0000-4000-8000-000000000101', 'renewed', false), 'a fresh session is admitted as is');
select is(public.control_web_session_use(repeat('f', 64))->>'outcome', 'not-found', 'an unknown handle is refused');
-- Use slides the idle clock, at most hourly.
update public.remote_web_sessions set used_at = now() - interval '59 minutes' where handle_hash = repeat('a', 64);
select is(public.control_web_session_use(repeat('a', 64))->>'renewed', 'false', 'no renewal within the hour');
update public.remote_web_sessions set used_at = now() - interval '89 days' where handle_hash = repeat('a', 64);
select is(public.control_web_session_use(repeat('a', 64))->>'renewed', 'true', 'use after an hour renews');
select is((select used_at from public.remote_web_sessions where handle_hash = repeat('a', 64)), now(), 'the idle clock restarts');
-- A suspended account is refused without ending the session.
update public.remote_access_accounts set enabled = false where user_id = '00000000-0000-4000-8000-000000000001';
select is(public.control_web_session_use(repeat('a', 64))->>'outcome', 'account-disabled', 'a suspended account is refused');
select is(public.control_web_session_create('00000000-0000-4000-8000-000000000001', 'web',
  '00000000-0000-4000-8000-000000000102', repeat('b', 64))->>'outcome', 'account-disabled', 'and cannot sign in');
update public.remote_access_accounts set enabled = true where user_id = '00000000-0000-4000-8000-000000000001';
select is(public.control_web_session_use(repeat('a', 64))->>'outcome', 'active', 'reinstated, the session resumes');
-- Ninety idle days end the session, its client and its Supabase session.
update public.remote_web_sessions set used_at = now() - interval '90 days 1 second' where handle_hash = repeat('a', 64);
select is(public.control_web_session_use(repeat('a', 64))->>'outcome', 'not-found', 'ninety idle days end a session');
select ok((select revoked_at is not null from public.remote_clients where id = (select (value->>'clientId')::uuid from web where name = 'a')), 'its client is revoked');
select is((select count(*) from public.remote_web_sessions where handle_hash = repeat('a', 64)), 0::bigint, 'its row is gone');
select ok(not control_private.auth_session_alive('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101'), 'its Supabase session is ended');
-- An ended Supabase session ends the browser session.
select public.control_web_session_create('00000000-0000-4000-8000-000000000001', 'web', '00000000-0000-4000-8000-000000000102', repeat('b', 64));
reset role;
delete from auth.sessions where id = '00000000-0000-4000-8000-000000000102';
set local role service_role;
select is(public.control_web_session_use(repeat('b', 64))->>'outcome', 'not-found', 'Supabase sign-out ends the browser session');
-- Sign-out and device revocation.
insert into web values ('c', public.control_web_session_create('00000000-0000-4000-8000-000000000001', 'web',
  '00000000-0000-4000-8000-000000000103', repeat('c', 64)));
select is(public.control_web_session_end(repeat('c', 64))->>'outcome', 'ended', 'sign-out ends a session');
select is(public.control_web_session_end(repeat('c', 64))->>'outcome', 'not-found', 'and only once');
select is(public.control_web_session_use(repeat('c', 64))->>'outcome', 'not-found', 'a signed-out handle is refused');
select ok(not control_private.auth_session_alive('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000103'), 'sign-out ends the Supabase session');
insert into web values ('d', public.control_web_session_create('00000000-0000-4000-8000-000000000001', 'web',
  '00000000-0000-4000-8000-000000000104', repeat('d', 64)));
select is(public.control_client_revoke('00000000-0000-4000-8000-000000000002', (select (value->>'clientId')::uuid from web where name = 'd'))->>'outcome', 'not-found', 'another owner cannot revoke it');
select is(public.control_client_revoke('00000000-0000-4000-8000-000000000001', (select (value->>'clientId')::uuid from web where name = 'd'))->>'outcome', 'revoked', 'the owner revokes the browser');
select is(public.control_web_session_use(repeat('d', 64))->>'outcome', 'not-found', 'a revoked browser is refused');
-- Sign-in sweeps: browser clients without a session go, and so do clients revoked over a day ago.
insert into public.remote_clients(id, owner_id, kind, label, revoked_at) values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'web', 'Old cookie', null),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'desktop', 'Gone', now() - interval '25 hours'),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001', 'desktop', 'Recent', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000001', 'desktop', 'Desktop', null);
select public.control_web_session_create('00000000-0000-4000-8000-000000000001', 'web', '00000000-0000-4000-8000-000000000105', repeat('e', 64));
select is(array(select label from public.remote_clients where id in ('00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000014') order by label),
  array['Desktop', 'Recent'], 'orphaned browsers and day-old revocations are swept, the rest kept');
select is(public.control_web_session_use(repeat('e', 64))->>'outcome', 'active', 'the new session works');
select is(jsonb_array_length(public.control_web_clients_list('00000000-0000-4000-8000-000000000002')->'clients'), 0, 'another owner lists nothing');
select throws_ok($$insert into public.remote_web_sessions(client_id, owner_id, handle_hash, sid)
  values ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000001', 'not-a-hash', gen_random_uuid())$$,
  '23514', null, 'only a SHA-256 hex digest is a handle hash');
-- Signed Host request nonces: once each, across every replica and restart.
select is(public.control_nonce_claim(repeat('k', 42) || 'A', repeat('n', 22), 121)->>'outcome', 'claimed', 'a fresh nonce is claimed');
select is(public.control_nonce_claim(repeat('k', 42) || 'A', repeat('n', 22), 121)->>'outcome', 'replayed', 'a replay is refused');
select is(public.control_nonce_claim('00000000-0000-4000-8000-000000000001', repeat('n', 22), 121)->>'outcome', 'claimed', 'nonces are per identity');
select throws_ok($$select public.control_nonce_claim('x', repeat('n', 22), 121)$$, '23514', null, 'identities are keys or host ids');
select throws_ok($$select public.control_nonce_claim(repeat('k', 42) || 'A', 'short', 121)$$, '23514', null, 'nonces are 16 bytes');
select throws_ok($$select public.control_nonce_claim(repeat('k', 42) || 'A', repeat('m', 22), 0)$$, 'P0001', null, 'a ttl is required');
update public.remote_request_nonces set expires_at = now() - interval '1 second';
select public.control_nonce_claim(repeat('k', 42) || 'A', repeat('o', 22), 121);
select is((select count(*) from public.remote_request_nonces), 1::bigint, 'expired nonces are swept');
select * from finish();
rollback;
