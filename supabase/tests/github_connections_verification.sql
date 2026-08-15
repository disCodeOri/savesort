begin;

do $$
declare
  test_user_id constant uuid := '00000000-0000-0000-0000-00000000fff7';
  first_sync_id constant uuid := '00000000-0000-0000-0000-000000001001';
  second_sync_id constant uuid := '00000000-0000-0000-0000-000000001002';
  third_sync_id constant uuid := '00000000-0000-0000-0000-000000001003';
  fourth_sync_id constant uuid := '00000000-0000-0000-0000-000000001004';
  first_lease_id constant uuid := '00000000-0000-0000-0000-000000002001';
  second_lease_id constant uuid := '00000000-0000-0000-0000-000000002002';
  displaced_lease_id constant uuid := '00000000-0000-0000-0000-000000002003';
  atomic_lease_id constant uuid := '00000000-0000-0000-0000-000000002004';
  first_heartbeat timestamptz;
  claimed_heartbeat timestamptz;
  renewed_heartbeat timestamptz;
  cleaned boolean;
  progress jsonb;
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
  if to_regprocedure('public.claim_github_sync_page(uuid,uuid,integer,uuid)') is null then
    raise exception 'claim_github_sync_page is missing';
  end if;
  if to_regprocedure('public.apply_github_sync_page(uuid,uuid,uuid,integer,integer,integer,integer,jsonb)') is null then
    raise exception 'apply_github_sync_page is missing';
  end if;
  if to_regprocedure('public.fail_github_sync_page(uuid,uuid,integer,uuid,text,boolean)') is null then
    raise exception 'page-scoped fail_github_sync_page is missing';
  end if;
  if to_regprocedure('public.fail_github_sync_page(uuid,uuid,uuid,text,boolean)') is not null then
    raise exception 'the insecure fail_github_sync_page overload must be removed';
  end if;
  if to_regprocedure('public.heartbeat_github_sync_page(uuid,uuid,integer,uuid)') is null then
    raise exception 'heartbeat_github_sync_page is missing';
  end if;
  if to_regprocedure('public.save_github_connection(uuid,bigint,text,text,text,text,timestamptz,timestamptz)') is null then
    raise exception 'save_github_connection is missing';
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

  if not exists (
    select 1
    from pg_attribute
    where attrelid = 'public.github_connections'::regclass
      and attname = 'page_lease_id'
      and atttypid = 'uuid'::regtype
      and not attisdropped
  ) or not exists (
    select 1
    from pg_attribute
    where attrelid = 'public.github_connections'::regclass
      and attname = 'page_lease_started_at'
      and atttypid = 'timestamp with time zone'::regtype
      and not attisdropped
  ) then
    raise exception 'GitHub page lease columns are missing or have the wrong type';
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
    from pg_proc
    where oid = 'public.save_github_connection(uuid,bigint,text,text,text,text,timestamptz,timestamptz)'::regprocedure
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
    raise exception 'save_github_connection must be service-role-only SECURITY DEFINER with an empty search_path';
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

  if exists (
    select 1
    from unnest(array[
      'public.claim_github_sync_page(uuid,uuid,integer,uuid)'::regprocedure,
      'public.heartbeat_github_sync_page(uuid,uuid,integer,uuid)'::regprocedure,
      'public.apply_github_sync_page(uuid,uuid,uuid,integer,integer,integer,integer,jsonb)'::regprocedure,
      'public.fail_github_sync_page(uuid,uuid,integer,uuid,text,boolean)'::regprocedure
    ]) as required_function(function_oid)
    join pg_proc on pg_proc.oid = required_function.function_oid
    where not pg_proc.prosecdef
      or not pg_proc.proconfig @> array['search_path=""']
      or has_function_privilege('anon', pg_proc.oid, 'execute')
      or has_function_privilege('authenticated', pg_proc.oid, 'execute')
      or not has_function_privilege('service_role', pg_proc.oid, 'execute')
      or exists (
        select 1
        from aclexplode(coalesce(pg_proc.proacl, acldefault('f', pg_proc.proowner))) as acl
        where acl.privilege_type = 'EXECUTE'
          and acl.grantee not in (pg_proc.proowner, 'service_role'::regrole)
      )
  ) then
    raise exception 'GitHub page RPCs must be service-role-only SECURITY DEFINER functions with an empty search_path';
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

  begin
    perform public.claim_github_sync_page(
      '00000000-0000-0000-0000-000000000000',
      '00000000-0000-0000-0000-000000000001',
      1,
      null
    );
    raise exception 'claim_github_sync_page must reject a null lease id';
  exception
    when null_value_not_allowed then
      null;
  end;

  insert into auth.users (id) values (test_user_id);
  insert into public.github_connections (
    user_id,
    github_user_id,
    github_login
  ) values (
    test_user_id,
    -9223372036854775000,
    'sync-verifier'
  );

  if not public.begin_github_sync(test_user_id, first_sync_id) then
    raise exception 'begin_github_sync must start an idle connection';
  end if;
  select sync_started_at
  into first_heartbeat
  from public.github_connections
  where user_id = test_user_id;
  perform pg_catalog.pg_sleep(0.01);

  if not public.claim_github_sync_page(
    test_user_id,
    first_sync_id,
    1,
    first_lease_id
  ) then
    raise exception 'the expected page must be claimable';
  end if;
  if public.claim_github_sync_page(
    test_user_id,
    first_sync_id,
    1,
    second_lease_id
  ) then
    raise exception 'the same page must not be claimable twice';
  end if;
  select sync_started_at
  into claimed_heartbeat
  from public.github_connections
  where user_id = test_user_id;
  if claimed_heartbeat <= first_heartbeat then
    raise exception 'claiming a page must renew the sync heartbeat';
  end if;
  perform pg_catalog.pg_sleep(0.01);
  if not public.heartbeat_github_sync_page(
    test_user_id,
    first_sync_id,
    1,
    first_lease_id
  ) then
    raise exception 'the exact page lease heartbeat must renew';
  end if;
  select sync_started_at
  into renewed_heartbeat
  from public.github_connections
  where user_id = test_user_id;
  if renewed_heartbeat <= claimed_heartbeat then
    raise exception 'a page heartbeat must renew the stale-sync timestamp';
  end if;
  if public.heartbeat_github_sync_page(
    test_user_id,
    first_sync_id,
    1,
    second_lease_id
  ) then
    raise exception 'a heartbeat must reject a different page lease';
  end if;

  progress := public.apply_github_sync_page(
    test_user_id,
    first_sync_id,
    first_lease_id,
    1,
    2,
    1,
    0,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'user_id', test_user_id,
        'url', 'https://github.com/acme/one',
        'normalized_url', 'https://github.com/acme/one',
        'source', 'github',
        'title', 'acme/one',
        'description', 'original provider description',
        'notes', null,
        'content', null,
        'author', 'acme',
        'thumbnail_url', null,
        'tags', pg_catalog.jsonb_build_array('search'),
        'metadata', pg_catalog.jsonb_build_object('github', pg_catalog.jsonb_build_object('id', 1)),
        'searchable_text', 'Title: acme/one',
        'embedding', '[' || pg_catalog.array_to_string(
          pg_catalog.array_fill('0.001'::text, array[768]),
          ','
        ) || ']',
        'indexing_status', 'ready',
        'indexing_error', null,
        'expected_updated_at', null
      )
    )
  );
  if progress->>'status' <> 'running'
    or (progress->>'next_page')::integer <> 2
    or (progress->>'discovered_count')::integer <> 1
    or (progress->>'saved_count')::integer <> 1 then
    raise exception 'page apply must atomically persist the item and advance progress';
  end if;

  if not public.claim_github_sync_page(
    test_user_id,
    first_sync_id,
    2,
    second_lease_id
  ) then
    raise exception 'the next page must be claimable after advancement';
  end if;
  update public.saved_items
  set notes = 'concurrent user note'
  where user_id = test_user_id
    and normalized_url = 'https://github.com/acme/one';
  progress := public.apply_github_sync_page(
    test_user_id,
    first_sync_id,
    second_lease_id,
    2,
    null,
    1,
    0,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'user_id', test_user_id,
        'url', 'https://github.com/acme/one',
        'normalized_url', 'https://github.com/acme/one',
        'source', 'github',
        'title', 'acme/one',
        'description', 'stale provider refresh',
        'notes', null,
        'content', null,
        'author', 'acme',
        'thumbnail_url', null,
        'tags', pg_catalog.jsonb_build_array('search'),
        'metadata', pg_catalog.jsonb_build_object('github', pg_catalog.jsonb_build_object('id', 1)),
        'searchable_text', 'Title: acme/one',
        'embedding', null,
        'indexing_status', 'keyword_only',
        'indexing_error', 'Semantic indexing is temporarily unavailable.',
        'expected_updated_at', '2000-01-01T00:00:00Z'
      )
    )
  );
  if progress->>'status' <> 'complete'
    or not exists (
      select 1
      from public.saved_items
      where user_id = test_user_id
        and notes = 'concurrent user note'
        and description = 'original provider description'
    ) then
    raise exception 'a stale row version must preserve the concurrent user edit';
  end if;

  if not public.begin_github_sync(test_user_id, second_sync_id)
    or not public.claim_github_sync_page(
      test_user_id,
      second_sync_id,
      1,
      displaced_lease_id
    ) then
    raise exception 'the displaced-ownership scenario must acquire a page';
  end if;
  update public.github_connections
  set active_sync_id = third_sync_id
  where user_id = test_user_id;
  progress := public.apply_github_sync_page(
    test_user_id,
    second_sync_id,
    displaced_lease_id,
    1,
    null,
    0,
    0,
    '[]'::jsonb
  );
  if progress is not null then
    raise exception 'a displaced page lease must not report progress';
  end if;

  update public.github_connections
  set sync_status = 'failed',
      active_sync_id = null,
      page_lease_id = null,
      page_lease_started_at = null
  where user_id = test_user_id;
  if not public.begin_github_sync(test_user_id, third_sync_id)
    or not public.claim_github_sync_page(
      test_user_id,
      third_sync_id,
      1,
      atomic_lease_id
    ) then
    raise exception 'the atomic rollback scenario must acquire a page';
  end if;
  begin
    perform public.apply_github_sync_page(
      test_user_id,
      third_sync_id,
      atomic_lease_id,
      1,
      null,
      2,
      0,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'user_id', test_user_id,
          'url', 'https://github.com/acme/two',
          'normalized_url', 'https://github.com/acme/two',
          'source', 'github',
          'title', 'acme/two',
          'searchable_text', 'Title: acme/two',
          'tags', '[]'::jsonb,
          'metadata', '{}'::jsonb,
          'embedding', null,
          'indexing_status', 'keyword_only',
          'expected_updated_at', null
        ),
        pg_catalog.jsonb_build_object(
          'user_id', '00000000-0000-0000-0000-00000000ffff',
          'url', 'https://github.com/acme/invalid',
          'normalized_url', 'https://github.com/acme/invalid',
          'source', 'github',
          'searchable_text', 'invalid',
          'tags', '[]'::jsonb,
          'metadata', '{}'::jsonb,
          'embedding', null,
          'indexing_status', 'keyword_only',
          'expected_updated_at', null
        )
      )
    );
    raise exception 'an invalid item must fail the atomic page apply';
  exception
    when invalid_parameter_value then
      null;
  end;
  if exists (
    select 1
    from public.saved_items
    where user_id = test_user_id
      and normalized_url = 'https://github.com/acme/two'
  ) or exists (
    select 1
    from public.github_connections
    where user_id = test_user_id
      and (discovered_count <> 0 or saved_count <> 0 or skipped_count <> 0)
  ) then
    raise exception 'a failed page apply must roll back items and progress together';
  end if;

  cleaned := public.fail_github_sync_page(
    test_user_id,
    third_sync_id,
    1,
    atomic_lease_id,
    'Safe verifier failure.',
    false
  );
  if not cleaned or not exists (
    select 1
    from public.github_connections
    where user_id = test_user_id
      and sync_status = 'failed'
      and active_sync_id is null
      and page_lease_id is null
      and last_sync_error = 'Safe verifier failure.'
  ) then
    raise exception 'failure cleanup must release only its active page lease';
  end if;

  if not public.begin_github_sync(test_user_id, fourth_sync_id) then
    raise exception 'the advanced-page cleanup scenario must start';
  end if;
  update public.github_connections
  set next_page = 2,
      discovered_count = 100,
      saved_count = 100,
      page_lease_id = null,
      page_lease_started_at = null
  where user_id = test_user_id;
  if public.fail_github_sync_page(
    test_user_id,
    fourth_sync_id,
    1,
    null,
    'Stale page failure.',
    false
  ) or not exists (
    select 1
    from public.github_connections
    where user_id = test_user_id
      and sync_status = 'running'
      and active_sync_id = fourth_sync_id
      and next_page = 2
      and discovered_count = 100
      and saved_count = 100
      and last_sync_error is null
  ) then
    raise exception 'null-lease cleanup must not fail an advanced page';
  end if;
end;
$$;

rollback;
