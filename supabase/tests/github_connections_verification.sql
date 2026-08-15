begin;

do $$
begin
  if to_regclass('public.github_connections') is null then
    raise exception 'github_connections is missing';
  end if;
  if to_regclass('public.github_connection_secrets') is null then
    raise exception 'github_connection_secrets is missing';
  end if;
  if to_regprocedure('public.begin_github_sync(uuid,uuid)') is null then
    raise exception 'begin_github_sync(uuid, uuid) is missing';
  end if;

  if not (
    select count(*) = 2 and bool_and(relrowsecurity)
    from pg_class
    where oid in (
      'public.github_connections'::regclass,
      'public.github_connection_secrets'::regclass
    )
  ) then
    raise exception 'GitHub connection tables must both have RLS enabled';
  end if;

  if exists (
    select 1
    from (values ('anon'::name), ('authenticated'::name)) as browser_roles(role_name)
    cross join (
      values
        ('select'::text),
        ('insert'::text),
        ('update'::text),
        ('delete'::text),
        ('truncate'::text),
        ('references'::text),
        ('trigger'::text),
        ('maintain'::text)
    ) as table_privileges(privilege_name)
    where has_table_privilege(
      browser_roles.role_name,
      'public.github_connection_secrets'::regclass,
      table_privileges.privilege_name
    )
  ) then
    raise exception 'browser roles must not have effective privileges on github_connection_secrets';
  end if;

  if exists (
    select 1
    from (
      values
        ('select'::text),
        ('insert'::text),
        ('update'::text),
        ('delete'::text),
        ('truncate'::text),
        ('references'::text),
        ('trigger'::text),
        ('maintain'::text)
    ) as table_privileges(privilege_name)
    where has_table_privilege(
      'anon',
      'public.github_connections'::regclass,
      table_privileges.privilege_name
    )
  ) then
    raise exception 'anon must not have effective privileges on github_connections';
  end if;

  if not has_table_privilege(
    'authenticated',
    'public.github_connections'::regclass,
    'select'
  ) or not has_table_privilege(
    'authenticated',
    'public.github_connections'::regclass,
    'update'
  ) then
    raise exception 'authenticated must be able to select and update github_connections';
  end if;

  if exists (
    select 1
    from (
      values
        ('insert'::text),
        ('delete'::text),
        ('truncate'::text),
        ('references'::text),
        ('trigger'::text),
        ('maintain'::text)
    ) as table_privileges(privilege_name)
    where has_table_privilege(
      'authenticated',
      'public.github_connections'::regclass,
      table_privileges.privilege_name
    )
  ) then
    raise exception 'authenticated has unexpected effective privileges on github_connections';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'github_connection_secrets'
  ) then
    raise exception 'github_connection_secrets must not have browser policies';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'github_connections'
  ) <> 2 then
    raise exception 'github_connections must have exactly two owner policies';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'github_connections'
      and policyname = 'Users can read their GitHub connection'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and qual = '(( SELECT auth.uid() AS uid) = user_id)'
      and with_check is null
  ) then
    raise exception 'github_connections SELECT policy must enforce ownership';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'github_connections'
      and policyname = 'Users can update their GitHub connection metadata'
      and cmd = 'UPDATE'
      and roles = array['authenticated']::name[]
      and qual = '(( SELECT auth.uid() AS uid) = user_id)'
      and with_check = '(( SELECT auth.uid() AS uid) = user_id)'
  ) then
    raise exception 'github_connections UPDATE policy must enforce ownership in USING and WITH CHECK';
  end if;

  if not exists (
    select 1
    from pg_proc
    where oid = 'public.begin_github_sync(uuid,uuid)'::regprocedure
      and prosecdef
      and proconfig @> array['search_path=""']
      and not has_function_privilege('anon', oid, 'execute')
      and not has_function_privilege('authenticated', oid, 'execute')
      and has_function_privilege('service_role', oid, 'execute')
      and not exists (
        select 1
        from aclexplode(coalesce(proacl, acldefault('f', proowner))) as acl
        where acl.privilege_type = 'EXECUTE'
          and acl.grantee not in (proowner, 'service_role'::regrole)
      )
  ) then
    raise exception 'begin_github_sync must be service-role-only SECURITY DEFINER with an empty search_path';
  end if;

  if (
    select count(*)
    from pg_trigger
    where not tgisinternal
      and tgrelid in (
        'public.github_connections'::regclass,
        'public.github_connection_secrets'::regclass
      )
  ) <> 2 then
    raise exception 'GitHub connection tables must have exactly two updated_at triggers';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where not tgisinternal
      and tgname = 'set_github_connections_updated_at'
      and tgrelid = 'public.github_connections'::regclass
      and tgfoid = 'public.set_saved_items_updated_at()'::regprocedure
  ) or not exists (
    select 1
    from pg_trigger
    where not tgisinternal
      and tgname = 'set_github_connection_secrets_updated_at'
      and tgrelid = 'public.github_connection_secrets'::regclass
      and tgfoid = 'public.set_saved_items_updated_at()'::regprocedure
  ) then
    raise exception 'GitHub connection updated_at triggers must reuse set_saved_items_updated_at';
  end if;

  begin
    perform public.begin_github_sync('00000000-0000-0000-0000-000000000000', null);
    raise exception 'begin_github_sync must reject a null sync id';
  exception
    when null_value_not_allowed then
      null;
  end;
end;
$$;

rollback;
