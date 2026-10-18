begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
select ok(not prosecdef and proconfig = array['search_path=""'], proname || ' is a fixed-path invoker')
  from pg_proc where oid in ('public.control_web_client_status(uuid,uuid)'::regprocedure,
    'public.control_web_clients_list(uuid)'::regprocedure);
select ok(not has_function_privilege(r, f, 'EXECUTE'), r || ' cannot execute ' || f)
  from (values ('anon'), ('authenticated')) roles(r),
    (values ('public.control_web_client_status(uuid,uuid)'), ('public.control_web_clients_list(uuid)')) funcs(f);
select ok(has_function_privilege('service_role', f, 'EXECUTE'), 'service can execute ' || f)
  from (values ('public.control_web_client_status(uuid,uuid)'), ('public.control_web_clients_list(uuid)')) funcs(f);
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000001','web@example.test'),
  ('00000000-0000-4000-8000-000000000002','other@example.test');
set local role service_role;
select public.control_account('00000000-0000-4000-8000-000000000001','web');
select public.control_account('00000000-0000-4000-8000-000000000002','other');
insert into public.remote_clients(id, owner_id, kind, label) values
  ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','web','Browser'),
  ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001','desktop','Desktop');
select is(public.control_web_client_status('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011')->>'outcome','active','owner browser active');
select is(public.control_web_client_status('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000011')->>'outcome','not-found','other owner refused');
select is(public.control_web_client_status('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000012')->>'outcome','not-found','desktop not a browser session');
select is(jsonb_array_length(public.control_web_clients_list('00000000-0000-4000-8000-000000000002')->'clients'),0,'other owner list empty');
select is(jsonb_array_length(public.control_web_clients_list('00000000-0000-4000-8000-000000000001')->'clients'),2,'owner list includes own clients');
select public.control_client_revoke('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011');
select is(public.control_web_client_status('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011')->>'outcome','not-found','revoked browser refused');
select ok((public.control_web_clients_list('00000000-0000-4000-8000-000000000001')->'clients'->1->>'revokedAt') is not null,'revoked status exposed');
update public.remote_access_accounts set enabled = false where user_id='00000000-0000-4000-8000-000000000001';
select is(jsonb_array_length(public.control_web_clients_list('00000000-0000-4000-8000-000000000001')->'clients'),0,'disabled account hidden');
update public.remote_clients set revoked_at = null where id='00000000-0000-4000-8000-000000000011';
select is(public.control_web_client_status('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011')->>'outcome','not-found','disabled account refused');
update public.remote_access_accounts set enabled = true where user_id='00000000-0000-4000-8000-000000000001';
insert into public.remote_clients(owner_id, kind, label, revoked_at)
  select '00000000-0000-4000-8000-000000000001','web','Old',now() - interval '1 day' from generate_series(1,110);
select is(jsonb_array_length(public.control_web_clients_list('00000000-0000-4000-8000-000000000001')->'clients'),100,'list bounded');
select is(public.control_web_clients_list('00000000-0000-4000-8000-000000000001')->'clients'->0->>'revokedAt',null,'active clients prioritized');
select * from finish();
rollback;
