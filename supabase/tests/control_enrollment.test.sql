begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'other@example.test');
create temporary table test_context (name text primary key, value jsonb);
grant all on test_context to service_role, authenticated, anon;
insert into test_context select 'call-' || n.nspname || '.' || p.proname, to_jsonb(format('select %I.%I(%s)', n.nspname, p.proname,
  (select string_agg('null::' || format_type(t, null), ', ' order by ord)
    from unnest(p.proargtypes::oid[]) with ordinality a(t, ord))))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'control_private' or (n.nspname = 'public' and p.proname like 'control\_%');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'control_private' or (n.nspname = 'public' and p.proname like 'control\_%'))
  and not p.prosecdef and p.proconfig = array['search_path=""']), 14::bigint,
  'all twelve RPCs and two helpers are invokers with empty search_path');
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
  and schemaname = 'public' and tablename = 'remote_hosts'), 'hosts published to Realtime');
select is((select count(*) from pg_class where oid in ('public.remote_enrollments'::regclass,
  'public.remote_audit_events'::regclass) and relrowsecurity), 2::bigint, 'new tables have RLS');
select ok(not has_schema_privilege('anon','control_private','USAGE'), 'anon cannot use helper schema');
select ok(not has_schema_privilege('authenticated','control_private','USAGE'), 'authenticated cannot use helper schema');
select is((select count(*) from pg_policy where polrelid='public.remote_enrollments'::regclass),0::bigint,'enrollments have no client policies');
set local role anon;
select ok(not has_function_privilege('anon', p.oid, 'EXECUTE'), 'anon has no execute grant on ' || p.proname)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='control_private' or (n.nspname='public' and p.proname like 'control\_%');
select throws_ok(value #>> '{}', '42501', null, 'anon cannot call ' || name) from test_context where name like 'call-%';
select throws_ok('select * from public.remote_enrollments', '42501', null, 'anon cannot read enrollments');
select throws_ok('select * from public.remote_audit_events', '42501', null, 'anon cannot read audits');
set local role authenticated;
select ok(not has_function_privilege('authenticated', p.oid, 'EXECUTE'), 'authenticated has no execute grant on ' || p.proname)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='control_private' or (n.nspname='public' and p.proname like 'control\_%');
select throws_ok(value #>> '{}', '42501', null, 'authenticated cannot call ' || name) from test_context where name like 'call-%';
select throws_ok('select * from public.remote_enrollments', '42501', null, 'authenticated cannot read enrollments');
select throws_ok(format('update public.%I set %I = %I', tab, col, col), '42501', null, tab || ' update forbidden')
  from (values ('remote_access_accounts', 'enabled'), ('remote_hosts', 'label'), ('remote_clients', 'label'),
    ('remote_enrollments', 'hostname'), ('remote_audit_events', 'kind')) t(tab, col);
select throws_ok(format('delete from public.%I', tab), '42501', null, tab || ' delete forbidden')
  from (values ('remote_access_accounts'), ('remote_hosts'), ('remote_clients'), ('remote_enrollments'), ('remote_audit_events')) t(tab);
select throws_ok(format('insert into public.%I default values', tab), '42501', null, tab || ' insert forbidden')
  from (values ('remote_access_accounts'), ('remote_hosts'), ('remote_clients'), ('remote_enrollments'), ('remote_audit_events')) t(tab);
set local role service_role;
select is(public.control_account('00000000-0000-4000-8000-000000000001', 'alice'),
  '{"enabled":true,"maxHosts":20}'::jsonb, 'new account enabled by default');
select is(public.control_account('00000000-0000-4000-8000-000000000002', null)->>'enabled', 'true', 'null login allowed');
select is(public.control_account('00000000-0000-4000-8000-000000000001', 'alice-updated')->>'enabled', 'true', 'account refresh');
select is((select login from public.remote_access_accounts where user_id = '00000000-0000-4000-8000-000000000001'), 'alice-updated', 'login refreshed');
insert into test_context values ('enrollment', public.control_enrollment_create((repeat('a',42) || 'A'), 'abcd-abcd-abcd-abcd', repeat('a',64), 'bee1', 'linux', 'arm64', '1.2.3'));
select is((select value->>'outcome' from test_context where name = 'enrollment'), 'created', 'enrollment created');
select is((select expires_at - created_at from public.remote_enrollments), interval '600 seconds', 'enrollment TTL is 600 seconds');
select is(public.control_enrollment_create((repeat('b',42) || 'A'), 'abcd-abcd-abcd-abcd', repeat('a',64), 'bee2', 'darwin', 'x64', '1.2.3')->>'outcome', 'code-collision', 'pending code collision');
select is(public.control_enrollment_poll((select (value->>'enrollmentId')::uuid from test_context where name='enrollment'), (repeat('a',42) || 'A'))->>'outcome', 'pending', 'poll pending');
select is(public.control_enrollment_lookup('00000000-0000-4000-8000-000000000001', repeat('a',64)),
  jsonb_build_object('outcome','found','hostname','bee1','platform','linux','arch','arm64','hostVersion','1.2.3',
    'keyFingerprint','abcd-abcd-abcd-abcd','expiresAt',(select value->>'expiresAt' from test_context where name='enrollment')), 'lookup returns complete metadata');
update public.remote_enrollments set expires_at = now() + interval '5 seconds' where code_hash = repeat('a',64);
insert into test_context values ('approval', public.control_enrollment_approve('00000000-0000-4000-8000-000000000001', repeat('a',64), 'Bee'));
select is((select expires_at from public.remote_enrollments where code_hash = repeat('a',64)), now() + interval '120 seconds', 'approval leaves the Host two minutes to poll');
select is((select value->>'outcome' from test_context where name='approval'), 'approved', 'approval succeeds');
select is((select value->'machine' from test_context where name='approval'),
  jsonb_build_object('id',(select id from public.remote_hosts),'label','Bee','hostname','bee1','platform','linux',
    'arch','arm64','hostVersion','1.2.3','keyFingerprint','abcd-abcd-abcd-abcd',
    'enrolledAt',control_private.iso(now()),'lastSeenAt',null,'state',null,'readiness',null,'lanes',null,'endpoint',null), 'MachineView has every field');
select ok((select owner_id='00000000-0000-4000-8000-000000000001' and public_key=(repeat('a',42) || 'A')
  and last_seq=0 and epoch=1 and uptime_sec is null and revoked_at is null from public.remote_hosts), 'host ownership, key and defaults set');
select ok((select status='approved' and owner_id='00000000-0000-4000-8000-000000000001'
  and host_id=(select id from public.remote_hosts) and approved_at=now() from public.remote_enrollments), 'approval persists atomically');
select is(public.control_enrollment_poll((select (value->>'enrollmentId')::uuid from test_context where name='enrollment'), (repeat('a',42) || 'A')),
  jsonb_build_object('outcome','approved','hostId',(select id from public.remote_hosts),'label','Bee','owner',jsonb_build_object('login','alice-updated')), 'poll approved with correct identity');
select is(public.control_enrollment_poll((select (value->>'enrollmentId')::uuid from test_context where name='enrollment'), (repeat('b',42) || 'A'))->>'outcome', 'not-found', 'wrong key cannot poll');
select is(public.control_enrollment_lookup('00000000-0000-4000-8000-000000000001', repeat('a',64))->>'outcome', 'not-found', 'approved lookup hidden');
select is(public.control_enrollment_approve('00000000-0000-4000-8000-000000000001', repeat('a',64), 'Again')->>'outcome', 'not-found', 'approval cannot replay');
select is(public.control_enrollment_create((repeat('a',42) || 'A'), 'abcd-abcd-abcd-abcd', repeat('b',64), 'bee1','linux','arm64','1.2.3')->>'outcome', 'key-in-use', 'active key cannot enroll');
insert into test_context values ('expired', public.control_enrollment_create((repeat('b',42) || 'A'), 'abcd-abcd-abcd-abcd', repeat('b',64), 'bee2','linux','x64','1.2.3'));
update public.remote_enrollments set expires_at=now() where code_hash=repeat('b',64);
select is(public.control_enrollment_lookup('00000000-0000-4000-8000-000000000001', repeat('b',64))->>'outcome', 'not-found', 'exact expiry lookup hidden');
select is(public.control_enrollment_approve('00000000-0000-4000-8000-000000000001', repeat('b',64), 'Expired')->>'outcome', 'not-found', 'exact expiry approval refused');
select is(public.control_enrollment_poll((select (value->>'enrollmentId')::uuid from test_context where name='expired'),(repeat('b',42) || 'A'))->>'outcome', 'expired', 'exact expiry poll expired');
select is(public.control_enrollment_poll('00000000-0000-4000-8000-000000000099',(repeat('b',42) || 'A'))->>'outcome','not-found','unknown enrollment hidden');
select is(public.control_enrollment_create((repeat('c',42) || 'A'), 'abcd-abcd-abcd-abcd', lpad(i::text,64,'0'), 'bee3','linux','x64','1.2.3')->>'outcome', 'created', 'pending at limit ' || i) from generate_series(1,3) i;
select is(public.control_enrollment_create((repeat('c',42) || 'A'), 'abcd-abcd-abcd-abcd', lpad('4',64,'0'), 'bee3','linux','x64','1.2.3')->>'outcome', 'busy', 'fourth pending rejected');
select is(public.control_host_key((select id from public.remote_hosts)), jsonb_build_object('outcome','active','publicKey',(repeat('a',42) || 'A')), 'active host key');
select is(public.control_host_self((select id from public.remote_hosts)), jsonb_build_object('outcome','active','hostId',(select id from public.remote_hosts),'label','Bee','owner',jsonb_build_object('login','alice-updated'),'enrolledAt',control_private.iso(now()),'lastSeenAt',null), 'host self view');
insert into test_context values ('host', to_jsonb((select id from public.remote_hosts)::text));
select is(public.control_host_heartbeat((select id from public.remote_hosts),1,'running','1.2.4',10,'{"pi":"ok","claude":"signed-out","tailscale":"no-https"}',10000,0,'https://bee1.ts.net:443')->>'outcome','accepted','first heartbeat accepted at lane limit');
select ok((select last_seen_at=now() and last_seq=1 and state='running' and host_version='1.2.4' and uptime_sec=10
  and running_lanes=10000 and waiting_lanes=0 and endpoint='https://bee1.ts.net:443'
  and readiness='{"pi":"ok","claude":"signed-out","tailscale":"no-https"}'::jsonb from public.remote_hosts), 'heartbeat stores complete state');
select is(public.control_host_heartbeat((select id from public.remote_hosts),1,'running','1.2.4',10,'{"pi":"ok","claude":"ok","tailscale":"ok"}',0,0,null)->>'outcome','stale','same seq stale');
select is(public.control_host_heartbeat((select id from public.remote_hosts),2,'running','1.2.4',10,'{"pi":"ok","claude":"ok","tailscale":"ok"}',0,0,null)->>'outcome','too-soon','higher seq too soon');
select is((select last_seq from public.remote_hosts),1::bigint,'rejected beats do not change seq');
select is(public.control_host_heartbeat((select id from public.remote_hosts),2,'stopping','1.2.4',10,'{"pi":"ok","claude":"ok","tailscale":"ok"}',0,0,null)->>'outcome','accepted','stopping bypasses interval');
select is(public.control_host_heartbeat((select id from public.remote_hosts),1,'stopping','1.2.4',10,'{"pi":"ok","claude":"ok","tailscale":"ok"}',0,0,null)->>'outcome','stale','stopping cannot replay a lower sequence');
select is((select last_seq from public.remote_hosts),2::bigint,'stopping replay leaves seq unchanged');
update public.remote_hosts set last_seen_at=now()-interval '10 seconds';
select is(public.control_host_heartbeat((select id from public.remote_hosts),3,'running','1.2.4',10,'{"pi":"ok","claude":"ok","tailscale":"ok"}',0,0,null)->>'outcome','accepted','exact minimum interval accepted');
select throws_ok($$update public.remote_hosts set label=E'bad\nlabel'$$,'23514',null,'control character label rejected');
select throws_ok($$update public.remote_hosts set label=''$$,'23514',null,'empty label rejected');
select lives_ok($$update public.remote_hosts set label=repeat('x',80)$$,'80 character label accepted');
select throws_ok($$update public.remote_hosts set label=repeat('x',81)$$,'23514',null,'81 character label rejected');
select throws_ok(format('update public.remote_hosts set label = %L', 'bad' || chr(cp) || 'label'),
  '23514', null, 'invisible label character rejected U+' || to_hex(cp))
  from (values (1564),(8206),(8207),(8232),(8233),(8234),(8235),(8236),(8237),(8238),(8294),(8295),(8296),(8297)) t(cp);
select lives_ok($$update public.remote_hosts set endpoint='https://bee1.ts.net:1'$$,'port 1 accepted');
select lives_ok($$update public.remote_hosts set endpoint='https://bee1.ts.net:65535'$$,'port 65535 accepted');
select throws_ok($$update public.remote_hosts set endpoint='https://bee1.ts.net:65536'$$,'23514',null,'port 65536 rejected');
select throws_ok($$update public.remote_hosts set endpoint='https://bee1.ts.net:0'$$,'23514',null,'port zero rejected');
select throws_ok($$update public.remote_hosts set endpoint='https://bee1.ts.net:999999999999999999999999999'$$,'23514',null,'oversized port rejected safely');
select lives_ok($$update public.remote_hosts set public_key=repeat('a',42) || 'Q'$$,'canonical key ending Q accepted');
select throws_ok($$update public.remote_hosts set public_key=repeat('a',42) || 'R'$$,'23514',null,'public key alias ending R rejected');
select throws_ok($$update public.remote_enrollments set public_key=repeat('a',42) || 'R'$$,'23514',null,'enrollment key alias ending R rejected');
update public.remote_hosts set public_key=repeat('a',42) || 'A';
select throws_ok($$update public.remote_hosts set endpoint='https://bee1.ts.net/path'$$,'23514',null,'endpoint path rejected');
select throws_ok($$update public.remote_hosts set readiness='{"pi":"ok","claude":"ok","tailscale":"ok","extra":true}'$$,'23514',null,'extra readiness key rejected');
select throws_ok($$update public.remote_hosts set readiness='{"pi":null,"claude":"ok","tailscale":"ok"}'$$,'23514',null,'null readiness value rejected');
select throws_ok($$update public.remote_hosts set readiness='{"pi":"ok"}'$$,'23514',null,'missing readiness keys rejected');
select throws_ok($$update public.remote_hosts set readiness='[]'$$,'23514',null,'non-object readiness rejected');
select throws_ok($$update public.remote_hosts set running_lanes=-1$$,'23514',null,'negative lanes rejected');
select throws_ok($$update public.remote_hosts set waiting_lanes=10001$$,'23514',null,'lanes one past limit rejected');
select throws_ok($$update public.remote_hosts set hostname='-invalid'$$,'23514',null,'invalid hostname rejected');
select lives_ok($$update public.remote_hosts set hostname=repeat('h',253)$$,'253 character hostname accepted');
select throws_ok($$update public.remote_hosts set hostname=repeat('h',254)$$,'23514',null,'254 character hostname rejected');
select throws_ok($$update public.remote_hosts set platform='other'$$,'23514',null,'invalid platform rejected');
select throws_ok($$update public.remote_hosts set arch='other'$$,'23514',null,'invalid arch rejected');
select throws_ok($$update public.remote_hosts set host_version='v1.0.0'$$,'23514',null,'invalid version rejected');
select lives_ok($$update public.remote_hosts set host_version='999999.999999.999999+' || repeat('v',64)$$,'maximum version accepted');
select throws_ok($$update public.remote_hosts set host_version='1000000.1.1'$$,'23514',null,'version component past limit rejected');
select throws_ok($$update public.remote_hosts set host_version='1.1.1+' || repeat('v',65)$$,'23514',null,'version suffix past limit rejected');
select lives_ok($$update public.remote_hosts set uptime_sec=316224000$$,'uptime at limit accepted');
select throws_ok($$update public.remote_hosts set uptime_sec=-1$$,'23514',null,'negative uptime rejected');
select lives_ok($$update public.remote_hosts set last_seq=9007199254740991$$,'seq at safe integer limit accepted');
select throws_ok($$update public.remote_hosts set public_key=repeat('a',42)$$,'23514',null,'short public key rejected');
select throws_ok($$update public.remote_hosts set key_fingerprint='ABCD-abcd-abcd-abcd'$$,'23514',null,'invalid fingerprint rejected');
select throws_ok($$update public.remote_enrollments set code_hash=repeat('A',64)$$,'23514',null,'invalid code hash rejected');
select throws_ok($$update public.remote_hosts set last_seq=9007199254740992$$,'23514',null,'unsafe seq rejected');
select throws_ok($$update public.remote_hosts set uptime_sec=316224001$$,'23514',null,'uptime past limit rejected');
select throws_ok($$update public.remote_access_accounts set login='invalid_login'$$,'23514',null,'invalid login rejected');
-- Restore heartbeat metadata changed by successful constraint-boundary checks.
update public.remote_hosts set last_seq=3, uptime_sec=10, host_version='1.2.4';
select is(public.control_machine_rename('00000000-0000-4000-8000-000000000002',(select id from public.remote_hosts),'Stolen')->>'outcome','not-found','non-owner cannot rename');
select is(public.control_machine_revoke('00000000-0000-4000-8000-000000000002',(select id from public.remote_hosts))->>'outcome','not-found','non-owner cannot revoke');
select is(public.control_machine_rename('00000000-0000-4000-8000-000000000001',(select id from public.remote_hosts),'Bee renamed')->>'outcome','renamed','owner rename');
select is((select count(*) from public.remote_audit_events where kind='host-renamed'),1::bigint,'rename audited');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select is((select count(*) from public.remote_hosts),1::bigint,'owner reads own host');
select is((select count(*) from public.remote_audit_events),2::bigint,'owner reads own audit');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
select is((select count(*) from public.remote_hosts),0::bigint,'second user reads no other hosts');
select is((select count(*) from public.remote_audit_events),0::bigint,'second user reads no other audits');
set local role service_role;
update public.remote_access_accounts set enabled=false where user_id='00000000-0000-4000-8000-000000000001';
select is(public.control_account('00000000-0000-4000-8000-000000000001','alice')->>'enabled','false','refresh does not unsuspend');
select is(public.control_enrollment_approve('00000000-0000-4000-8000-000000000001',lpad('1',64,'0'),'Disabled')->>'outcome','account-disabled','disabled approval denied');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select is((select count(*) from public.remote_hosts),0::bigint,'suspended owner reads no hosts');
select is((select count(*) from public.remote_audit_events),0::bigint,'suspended owner reads no audits');
set local role service_role;
update public.remote_access_accounts set enabled=true where user_id='00000000-0000-4000-8000-000000000001';
select is(public.control_machine_revoke('00000000-0000-4000-8000-000000000001',(select id from public.remote_hosts))->>'outcome','revoked','owner revoke');
select ok((select revoked_at=now() and epoch=2 from public.remote_hosts),'revoke sets timestamp and bumps epoch');
select is((select count(*) from public.remote_audit_events where kind='host-revoked'),1::bigint,'revoke audited');
select is(public.control_machines('00000000-0000-4000-8000-000000000001')->'machines','[]'::jsonb,'revoked host not listed');
select is(public.control_host_key((select id from public.remote_hosts))->>'outcome','gone','revoked key gone');
select is(public.control_host_self((select id from public.remote_hosts))->>'outcome','gone','revoked self gone');
select is(public.control_host_heartbeat((select id from public.remote_hosts),4,'stopping','1.2.4',10,'{"pi":"ok","claude":"ok","tailscale":"ok"}',0,0,null)->>'outcome','gone','revoked heartbeat gone');
select is(public.control_host_heartbeat('00000000-0000-4000-8000-000000000099',4,'running','1.2.4',10,'{"pi":"ok","claude":"ok","tailscale":"ok"}',0,0,null)->>'outcome','gone','unknown heartbeat gone');
select is(public.control_host_key('00000000-0000-4000-8000-000000000099')->>'outcome','gone','unknown key gone');
select is(public.control_host_self('00000000-0000-4000-8000-000000000099')->>'outcome','gone','unknown self gone');
select is(public.control_host_revoke_self((select id from public.remote_hosts))->>'outcome','gone','revoked self revoke gone');
select is(public.control_enrollment_create((repeat('a',42) || 'A'),'abcd-abcd-abcd-abcd',repeat('d',64),'bee1','linux','arm64','1.2.3')->>'outcome','created','revoked key can enroll again');
select is(public.control_enrollment_approve('00000000-0000-4000-8000-000000000001',repeat('d',64),'Bee again')->>'outcome','approved','revoked key can approve again');
select is(public.control_host_revoke_self((select id from public.remote_hosts where revoked_at is null))->>'outcome','revoked','self revoke');
select is((select count(*) from public.remote_audit_events where kind='host-self-revoked'),1::bigint,'self revoke audited');
-- Distinct pending codes for one key test the unique-index approval path.
select is(public.control_enrollment_approve('00000000-0000-4000-8000-000000000002',lpad('1',64,'0'),'Other')->>'outcome','approved','first pending key approved');
select is(public.control_enrollment_approve('00000000-0000-4000-8000-000000000001',lpad('2',64,'0'),'Duplicate')->>'outcome','key-in-use','second pending key cannot approve');
-- Seed nineteen more active hosts, then prove the exact cap through real approval.
insert into public.remote_hosts(owner_id,label,hostname,public_key,key_fingerprint,platform,arch)
  select '00000000-0000-4000-8000-000000000002', 'Host ' || i, 'host' || i, (lpad(i::text,42,'z') || 'A'), 'abcd-abcd-abcd-abcd','linux','x64' from generate_series(1,19) i;
select is((select count(*) from public.remote_hosts where owner_id='00000000-0000-4000-8000-000000000002' and revoked_at is null),20::bigint,'twenty active hosts allowed');
select is(public.control_enrollment_approve('00000000-0000-4000-8000-000000000002',repeat('d',64),'Already approved')->>'outcome','not-found','approved code remains hidden');
select is(public.control_enrollment_create((repeat('e',42) || 'A'),'abcd-abcd-abcd-abcd',repeat('e',64),'cap','linux','x64','1.2.3')->>'outcome','created','cap candidate created');
select is(public.control_enrollment_approve('00000000-0000-4000-8000-000000000002',repeat('e',64),'Cap')->>'outcome','host-limit','twenty-first host rejected');
select is(jsonb_array_length(public.control_machines('00000000-0000-4000-8000-000000000002')->'machines'),20,'machine list at cap');
select is(control_private.iso('2026-10-12 13:14:15.123+02'), '2026-10-12T11:14:15.123Z','timestamps format UTC milliseconds');
select matches(value, '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$', 'exact wire timestamp ' || name)
  from (values
    ('enrollment expiry', (select value->>'expiresAt' from test_context where name='enrollment')),
    ('machine enrollment', (select value->'machine'->>'enrolledAt' from test_context where name='approval')),
    ('list server time', public.control_machines('00000000-0000-4000-8000-000000000002')->>'serverTime'),
    ('host enrollment', public.control_host_self((select id from public.remote_hosts where revoked_at is null limit 1))->>'enrolledAt'),
    ('heartbeat last seen', (select control_private.machine(h)->>'lastSeenAt' from public.remote_hosts h where h.id=(select (value #>> '{}')::uuid from test_context where name='host')))
  ) t(name, value);
-- Global pending cap and bounded cleanup.
insert into public.remote_enrollments(code_hash,public_key,key_fingerprint,hostname,platform,arch,host_version)
  select '012345' || lpad(to_hex(i),58,'0'),(lpad(i::text,42,'y') || 'A'),'abcd-abcd-abcd-abcd','pending','linux','x64','1.2.3'
  from generate_series(1,9997) i;
select is((select count(*) from public.remote_enrollments where status='pending' and expires_at>now()),10000::bigint,'global cap boundary');
select is(public.control_enrollment_create((repeat('g',42) || 'A'),'abcd-abcd-abcd-abcd',repeat('f',64),'busy','linux','x64','1.2.3')->>'outcome','busy','global cap refuses more');
update public.remote_enrollments set expires_at=now()-interval '2 days' where hostname='pending';
insert into public.remote_audit_events(owner_id,host_id,kind,created_at)
  select '00000000-0000-4000-8000-000000000001',(select (value #>> '{}')::uuid from test_context where name='host'),'host-renamed',now()-interval '181 days' from generate_series(1,1001);
select is(public.control_enrollment_create((repeat('g',42) || 'A'),'abcd-abcd-abcd-abcd',repeat('f',64),'cleanup','linux','x64','1.2.3')->>'outcome','created','expired pending do not count');
select is((select count(*) from public.remote_enrollments where hostname='pending'),8997::bigint,'enrollment cleanup bounded to 1000');
select is((select count(*) from public.remote_audit_events where created_at < now()-interval '180 days'),1::bigint,'audit cleanup bounded to 1000');
select * from finish();
rollback;
