-- Browser identity remains bound to the client registered by the OAuth callback.
-- No credentials or browser session contents are stored in the directory.
create function public.control_web_client_status(p_user uuid, p_client uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select case when exists (
    select 1 from public.remote_clients c join public.remote_access_accounts a on a.user_id = c.owner_id
    where c.id = p_client and c.owner_id = p_user and c.kind = 'web'
      and c.revoked_at is null and a.enabled
  ) then '{"outcome":"active"}'::jsonb else '{"outcome":"not-found"}'::jsonb end;
$$;
create function public.control_web_clients_list(p_user uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object('clients', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'label', c.label, 'kind', c.kind,
      'revokedAt', case when c.revoked_at is null then null else control_private.iso(c.revoked_at) end)
      order by c.revoked_at nulls first, c.id)
    from (select c.id, c.label, c.kind, c.revoked_at from public.remote_clients c
      join public.remote_access_accounts a on a.user_id = c.owner_id
      where c.owner_id = p_user and a.enabled
      order by c.revoked_at nulls first, c.id limit 100) c
  ), '[]'::jsonb));
$$;
revoke all on function public.control_web_client_status(uuid, uuid), public.control_web_clients_list(uuid)
  from public, anon, authenticated;
grant execute on function public.control_web_client_status(uuid, uuid), public.control_web_clients_list(uuid)
  to service_role;
