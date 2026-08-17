begin;

do $$
declare
  test_user_id constant uuid := '00000000-0000-0000-0000-00000000fff6';
  first_sync_id constant uuid := '00000000-0000-0000-0000-000000003001';
  second_sync_id constant uuid := '00000000-0000-0000-0000-000000003002';
  third_sync_id constant uuid := '00000000-0000-0000-0000-000000003003';
  first_lease_id constant uuid := '00000000-0000-0000-0000-000000004001';
  second_lease_id constant uuid := '00000000-0000-0000-0000-000000004002';
  atomic_lease_id constant uuid := '00000000-0000-0000-0000-000000004003';
  claimed_heartbeat timestamptz;
  renewed_heartbeat timestamptz;
  cleaned boolean;
  progress jsonb;
begin
  if to_regclass('public.reddit_connections') is null then
    raise exception 'reddit_connections is missing';
  end if;
  if to_regclass('public.reddit_connection_secrets') is null then
    raise exception 'reddit_connection_secrets is missing';
  end if;
  if to_regprocedure('public.save_reddit_connection(uuid,text,text,text,text,text,timestamptz)') is null then
    raise exception 'save_reddit_connection is missing';
  end if;
  if to_regprocedure('public.begin_reddit_sync(uuid,uuid)') is null then
    raise exception 'begin_reddit_sync is missing';
  end if;
  if to_regprocedure('public.claim_reddit_sync_page(uuid,uuid,integer,uuid)') is null then
    raise exception 'claim_reddit_sync_page is missing';
  end if;
  if to_regprocedure('public.heartbeat_reddit_sync_page(uuid,uuid,integer,uuid)') is null then
    raise exception 'heartbeat_reddit_sync_page is missing';
  end if;
  if to_regprocedure('public.apply_reddit_sync_page(uuid,uuid,uuid,integer,integer,text,integer,integer,jsonb)') is null then
    raise exception 'apply_reddit_sync_page is missing';
  end if;
  if to_regprocedure('public.fail_reddit_sync_page(uuid,uuid,integer,uuid,text,boolean)') is null then
    raise exception 'fail_reddit_sync_page is missing';
  end if;

  if not (
    select count(*) = 2 and bool_and(relrowsecurity)
    from pg_class
    where oid in (
      'public.reddit_connections'::regclass,
      'public.reddit_connection_secrets'::regclass
    )
  ) then
    raise exception 'Reddit connection tables must both have RLS enabled';
  end if;

  if not exists (
    select 1
    from pg_attribute
    where attrelid = 'public.reddit_connections'::regclass
      and attname = 'next_cursor'
      and atttypid = 'text'::regtype
      and not attisdropped
  ) or not exists (
    select 1
    from pg_attribute
    where attrelid = 'public.reddit_connections'::regclass
      and attname = 'page_lease_id'
      and atttypid = 'uuid'::regtype
      and not attisdropped
  ) then
    raise exception 'Reddit cursor and page lease columns are missing or have the wrong type';
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
      'public.reddit_connection_secrets'::regclass,
      table_privileges.privilege_name
    )
  ) then
    raise exception 'browser roles must not have effective privileges on reddit_connection_secrets';
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
      'public.reddit_connections'::regclass,
      table_privileges.privilege_name
    )
  ) then
    raise exception 'anon must not have effective privileges on reddit_connections';
  end if;

  if not has_table_privilege(
    'authenticated',
    'public.reddit_connections'::regclass,
    'select'
  ) or not has_table_privilege(
    'authenticated',
    'public.reddit_connections'::regclass,
    'update'
  ) then
    raise exception 'authenticated must be able to select and update reddit_connections';
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
      'public.reddit_connections'::regclass,
      table_privileges.privilege_name
    )
  ) then
    raise exception 'authenticated has unexpected effective privileges on reddit_connections';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'reddit_connection_secrets'
  ) then
    raise exception 'reddit_connection_secrets must not have browser policies';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'reddit_connections'
  ) <> 2 then
    raise exception 'reddit_connections must have exactly two owner policies';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'reddit_connections'
      and policyname = 'Users can read their Reddit connection'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and qual = '(( SELECT auth.uid() AS uid) = user_id)'
      and with_check is null
  ) then
    raise exception 'reddit_connections SELECT policy must enforce ownership';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'reddit_connections'
      and policyname = 'Users can update their Reddit connection metadata'
      and cmd = 'UPDATE'
      and roles = array['authenticated']::name[]
      and qual = '(( SELECT auth.uid() AS uid) = user_id)'
      and with_check = '(( SELECT auth.uid() AS uid) = user_id)'
  ) then
    raise exception 'reddit_connections UPDATE policy must enforce ownership in USING and WITH CHECK';
  end if;

  if exists (
    select 1
    from unnest(array[
      'public.save_reddit_connection(uuid,text,text,text,text,text,timestamptz)'::regprocedure,
      'public.begin_reddit_sync(uuid,uuid)'::regprocedure,
      'public.claim_reddit_sync_page(uuid,uuid,integer,uuid)'::regprocedure,
      'public.heartbeat_reddit_sync_page(uuid,uuid,integer,uuid)'::regprocedure,
      'public.apply_reddit_sync_page(uuid,uuid,uuid,integer,integer,text,integer,integer,jsonb)'::regprocedure,
      'public.fail_reddit_sync_page(uuid,uuid,integer,uuid,text,boolean)'::regprocedure
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
    raise exception 'Reddit RPCs must be service-role-only SECURITY DEFINER functions with an empty search_path';
  end if;

  if (
    select count(*)
    from pg_trigger
    where not tgisinternal
      and tgrelid in (
        'public.reddit_connections'::regclass,
        'public.reddit_connection_secrets'::regclass
      )
  ) <> 2 then
    raise exception 'Reddit connection tables must have exactly two updated_at triggers';
  end if;

  begin
    perform public.begin_reddit_sync('00000000-0000-0000-0000-000000000000', null);
    raise exception 'begin_reddit_sync must reject a null sync id';
  exception
    when null_value_not_allowed then
      null;
  end;

  insert into auth.users (id) values (test_user_id);
  insert into public.reddit_connections (
    user_id,
    reddit_user_id,
    reddit_username
  ) values (
    test_user_id,
    'zzz999',
    'sync-verifier'
  );

  if not public.begin_reddit_sync(test_user_id, first_sync_id) then
    raise exception 'begin_reddit_sync must start an idle connection';
  end if;
  if exists (
    select 1
    from public.reddit_connections
    where user_id = test_user_id
      and (next_page <> 1 or next_cursor is not null)
  ) then
    raise exception 'a new sync must restart at the newest saved item';
  end if;

  if not public.claim_reddit_sync_page(
    test_user_id,
    first_sync_id,
    1,
    first_lease_id
  ) then
    raise exception 'the expected page must be claimable';
  end if;
  if public.claim_reddit_sync_page(
    test_user_id,
    first_sync_id,
    1,
    second_lease_id
  ) then
    raise exception 'the same page must not be claimable twice';
  end if;
  select sync_started_at
  into claimed_heartbeat
  from public.reddit_connections
  where user_id = test_user_id;
  perform pg_catalog.pg_sleep(0.01);
  if not public.heartbeat_reddit_sync_page(
    test_user_id,
    first_sync_id,
    1,
    first_lease_id
  ) then
    raise exception 'the exact page lease heartbeat must renew';
  end if;
  select sync_started_at
  into renewed_heartbeat
  from public.reddit_connections
  where user_id = test_user_id;
  if renewed_heartbeat <= claimed_heartbeat then
    raise exception 'a page heartbeat must renew the stale-sync timestamp';
  end if;
  if public.heartbeat_reddit_sync_page(
    test_user_id,
    first_sync_id,
    1,
    second_lease_id
  ) then
    raise exception 'a heartbeat must reject a different page lease';
  end if;

  begin
    perform public.apply_reddit_sync_page(
      test_user_id,
      first_sync_id,
      first_lease_id,
      1,
      2,
      null,
      0,
      0,
      '[]'::jsonb
    );
    raise exception 'a running page must carry the cursor for its next request';
  exception
    when invalid_parameter_value then
      null;
  end;

  begin
    perform public.apply_reddit_sync_page(
      test_user_id,
      first_sync_id,
      first_lease_id,
      1,
      null,
      't3_orphan',
      0,
      0,
      '[]'::jsonb
    );
    raise exception 'a finished page must not carry a cursor';
  exception
    when invalid_parameter_value then
      null;
  end;

  progress := public.apply_reddit_sync_page(
    test_user_id,
    first_sync_id,
    first_lease_id,
    1,
    2,
    't3_page_one',
    2,
    1,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'user_id', test_user_id,
        'url', 'https://www.reddit.com/r/programming/comments/one/a_post',
        'normalized_url', 'https://www.reddit.com/r/programming/comments/one/a_post',
        'source', 'reddit',
        'title', 'A saved post',
        'description', 'original provider description',
        'notes', null,
        'content', null,
        'author', 'someone',
        'thumbnail_url', null,
        'tags', pg_catalog.jsonb_build_array('r/programming'),
        'metadata', pg_catalog.jsonb_build_object('reddit', pg_catalog.jsonb_build_object('id', 'one')),
        'searchable_text', 'Title: A saved post',
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
    or progress->>'next_cursor' <> 't3_page_one'
    or (progress->>'discovered_count')::integer <> 2
    or (progress->>'saved_count')::integer <> 1
    or (progress->>'skipped_count')::integer <> 1 then
    raise exception 'page apply must persist the item, count the skip and store the cursor';
  end if;
  if not exists (
    select 1
    from public.reddit_connections
    where user_id = test_user_id
      and next_page = 2
      and next_cursor = 't3_page_one'
  ) then
    raise exception 'the stored cursor must drive the next request';
  end if;

  if not public.claim_reddit_sync_page(
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
    and normalized_url = 'https://www.reddit.com/r/programming/comments/one/a_post';
  progress := public.apply_reddit_sync_page(
    test_user_id,
    first_sync_id,
    second_lease_id,
    2,
    null,
    null,
    1,
    0,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'user_id', test_user_id,
        'url', 'https://www.reddit.com/r/programming/comments/one/a_post',
        'normalized_url', 'https://www.reddit.com/r/programming/comments/one/a_post',
        'source', 'reddit',
        'title', 'A saved post',
        'description', 'stale provider refresh',
        'notes', null,
        'content', null,
        'author', 'someone',
        'thumbnail_url', null,
        'tags', pg_catalog.jsonb_build_array('r/programming'),
        'metadata', pg_catalog.jsonb_build_object('reddit', pg_catalog.jsonb_build_object('id', 'one')),
        'searchable_text', 'Title: A saved post',
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
  if not exists (
    select 1
    from public.reddit_connections
    where user_id = test_user_id
      and sync_status = 'idle'
      and active_sync_id is null
      and next_cursor is null
      and last_synced_at is not null
  ) then
    raise exception 'finishing a sync must clear the cursor and the active sync';
  end if;

  if not public.begin_reddit_sync(test_user_id, second_sync_id)
    or not public.claim_reddit_sync_page(
      test_user_id,
      second_sync_id,
      1,
      atomic_lease_id
    ) then
    raise exception 'the displaced-ownership scenario must acquire a page';
  end if;
  update public.reddit_connections
  set active_sync_id = third_sync_id
  where user_id = test_user_id;
  progress := public.apply_reddit_sync_page(
    test_user_id,
    second_sync_id,
    atomic_lease_id,
    1,
    null,
    null,
    0,
    0,
    '[]'::jsonb
  );
  if progress is not null then
    raise exception 'a displaced page lease must not report progress';
  end if;

  update public.reddit_connections
  set sync_status = 'failed',
      active_sync_id = null,
      page_lease_id = null,
      page_lease_started_at = null
  where user_id = test_user_id;
  if not public.begin_reddit_sync(test_user_id, third_sync_id)
    or not public.claim_reddit_sync_page(
      test_user_id,
      third_sync_id,
      1,
      atomic_lease_id
    ) then
    raise exception 'the atomic rollback scenario must acquire a page';
  end if;
  begin
    perform public.apply_reddit_sync_page(
      test_user_id,
      third_sync_id,
      atomic_lease_id,
      1,
      null,
      null,
      2,
      0,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'user_id', test_user_id,
          'url', 'https://www.reddit.com/r/programming/comments/two/a_post',
          'normalized_url', 'https://www.reddit.com/r/programming/comments/two/a_post',
          'source', 'reddit',
          'title', 'Another saved post',
          'searchable_text', 'Title: Another saved post',
          'tags', '[]'::jsonb,
          'metadata', '{}'::jsonb,
          'embedding', null,
          'indexing_status', 'keyword_only',
          'expected_updated_at', null
        ),
        pg_catalog.jsonb_build_object(
          'user_id', '00000000-0000-0000-0000-00000000ffff',
          'url', 'https://www.reddit.com/r/programming/comments/bad/a_post',
          'normalized_url', 'https://www.reddit.com/r/programming/comments/bad/a_post',
          'source', 'reddit',
          'searchable_text', 'invalid',
          'tags', '[]'::jsonb,
          'metadata', '{}'::jsonb,
          'embedding', null,
          'indexing_status', 'keyword_only',
          'expected_updated_at', null
        )
      )
    );
    raise exception 'an item belonging to another user must fail the atomic page apply';
  exception
    when invalid_parameter_value then
      null;
  end;
  if exists (
    select 1
    from public.saved_items
    where user_id = test_user_id
      and normalized_url = 'https://www.reddit.com/r/programming/comments/two/a_post'
  ) or exists (
    select 1
    from public.reddit_connections
    where user_id = test_user_id
      and (discovered_count <> 0 or saved_count <> 0 or skipped_count <> 0)
  ) then
    raise exception 'a failed page apply must roll back items and progress together';
  end if;

  cleaned := public.fail_reddit_sync_page(
    test_user_id,
    third_sync_id,
    1,
    atomic_lease_id,
    'Safe verifier failure.',
    false
  );
  if not cleaned or not exists (
    select 1
    from public.reddit_connections
    where user_id = test_user_id
      and sync_status = 'failed'
      and active_sync_id is null
      and page_lease_id is null
      and last_sync_error = 'Safe verifier failure.'
  ) then
    raise exception 'failure cleanup must release only its active page lease';
  end if;
end;
$$;

rollback;
