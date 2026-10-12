begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(20);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'alice@example.test'),
  ('00000000-0000-0000-0000-000000000002', 'bob@example.test');
insert into public.remote_access_accounts (user_id, enabled)
  select id, true from auth.users where email like '%@example.test';
insert into public.remote_hosts (owner_id, label, endpoint, hostname, public_key, key_fingerprint, platform, arch) values
  ('00000000-0000-0000-0000-000000000001', 'Alice host', 'https://alice.example.ts.net', 'alice', (repeat('a',42) || 'A'), 'abcd-abcd-abcd-abcd', 'linux', 'x64'),
  ('00000000-0000-0000-0000-000000000002', 'Bob host', 'https://bob.example.ts.net', 'bob', (repeat('b',42) || 'A'), 'abcd-abcd-abcd-abcd', 'linux', 'x64');
insert into public.remote_clients (owner_id, label, kind) values
  ('00000000-0000-0000-0000-000000000001', 'Alice client', 'desktop'),
  ('00000000-0000-0000-0000-000000000002', 'Bob client', 'web');

select is((select count(*) from pg_class where oid in (
  'public.remote_access_accounts'::regclass, 'public.remote_hosts'::regclass,
  'public.remote_clients'::regclass
) and relrowsecurity), 3::bigint, 'every directory table has RLS');

set local role anon;
select throws_ok('select * from public.remote_hosts', '42501', null, 'anonymous host reads denied');
select throws_ok('select * from public.remote_clients', '42501', null, 'anonymous client reads denied');
select throws_ok('select * from public.remote_access_accounts', '42501', null, 'anonymous eligibility reads denied');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.remote_hosts), 1::bigint, 'owner sees only own host');
select is((select label from public.remote_hosts), 'Alice host', 'correct host visible');
select is((select count(*) from public.remote_clients), 1::bigint, 'owner sees only own client');
select is((select count(*) from public.remote_access_accounts), 1::bigint, 'eligibility is owner scoped');
select throws_ok($$update public.remote_hosts set label = 'changed'$$, '42501', null, 'direct host edits denied');
select throws_ok($$delete from public.remote_hosts$$, '42501', null, 'direct host deletion denied');
select throws_ok($$update public.remote_access_accounts set enabled = true$$, '42501', null, 'self enable denied');
select throws_ok($$insert into public.remote_clients(owner_id, label, kind)
  values (auth.uid(), 'forged client', 'desktop')$$, '42501', null, 'unapproved client registration denied');
select throws_ok($$update public.remote_clients set owner_id = '00000000-0000-0000-0000-000000000002'$$,
  '42501', null, 'client reassignment denied');
select throws_ok($$insert into public.remote_hosts(owner_id, label, endpoint)
  values (auth.uid(), 'forged host', 'https://forged.example.ts.net')$$,
  '42501', null, 'unapproved host enrollment denied');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is((select label from public.remote_hosts), 'Bob host', 'second owner cannot read Alice host');

reset role;
update public.remote_access_accounts set enabled = false
  where user_id = '00000000-0000-0000-0000-000000000002';
set local role authenticated;
select is((select count(*) from public.remote_hosts), 0::bigint, 'disabled account loses directory access');
select is((select count(*) from public.remote_clients), 0::bigint, 'disabled account loses client directory');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select is((select count(*) from public.remote_hosts), 0::bigint, 'uninvited account sees no hosts');

set local role service_role;
select lives_ok($$update public.remote_hosts set revoked_at = now()$$, 'server can revoke enrollment');
select is((select count(*) from public.remote_hosts where revoked_at is not null),
  2::bigint, 'server can manage both accounts after endpoint authorization');

select * from finish();
rollback;
