begin;

do $$
declare
  test_user_id constant uuid := '00000000-0000-0000-0000-00000000fff5';
  other_user_id constant uuid := '00000000-0000-0000-0000-00000000fff4';
  device_id uuid;
  vault_id uuid;
  other_vault_id uuid;
  result jsonb;
  note_revision integer;
begin
  if to_regclass('public.obsidian_vaults') is null
    or to_regclass('public.obsidian_notes') is null
    or to_regclass('public.desktop_devices') is null
    or to_regclass('public.desktop_device_tokens') is null
    or to_regclass('public.desktop_auth_codes') is null then
    raise exception 'Obsidian sync tables are missing';
  end if;

  if not (
    select count(*) = 5 and bool_and(relrowsecurity)
    from pg_class
    where oid in (
      'public.obsidian_vaults'::regclass,
      'public.obsidian_notes'::regclass,
      'public.desktop_devices'::regclass,
      'public.desktop_device_tokens'::regclass,
      'public.desktop_auth_codes'::regclass
    )
  ) then
    raise exception 'Every Obsidian sync table must have RLS enabled';
  end if;

  -- Device credentials and authorization codes are server-only. A browser role
  -- with any privilege on them would defeat the point of hashing the tokens.
  if exists (
    select 1
    from (values ('anon'::name), ('authenticated'::name)) as browser_roles(role_name)
    cross join (
      values ('select'::text), ('insert'::text), ('update'::text),
             ('delete'::text), ('truncate'::text), ('references'::text),
             ('trigger'::text), ('maintain'::text)
    ) as table_privileges(privilege_name)
    cross join (
      values
        ('public.desktop_device_tokens'::regclass),
        ('public.desktop_auth_codes'::regclass)
    ) as secret_tables(table_oid)
    where has_table_privilege(
      browser_roles.role_name,
      secret_tables.table_oid,
      table_privileges.privilege_name
    )
  ) then
    raise exception 'browser roles must not have privileges on desktop credential tables';
  end if;

  if exists (
    select 1
    from (values ('select'::text), ('insert'::text), ('update'::text),
                 ('delete'::text), ('truncate'::text), ('references'::text),
                 ('trigger'::text), ('maintain'::text))
      as table_privileges(privilege_name)
    cross join (
      values
        ('public.obsidian_vaults'::regclass),
        ('public.obsidian_notes'::regclass),
        ('public.desktop_devices'::regclass)
    ) as user_tables(table_oid)
    where has_table_privilege('anon', user_tables.table_oid, table_privileges.privilege_name)
  ) then
    raise exception 'anon must not have privileges on Obsidian sync tables';
  end if;

  if has_table_privilege('authenticated', 'public.obsidian_notes'::regclass, 'update')
    or has_table_privilege('authenticated', 'public.obsidian_notes'::regclass, 'insert')
    or has_table_privilege('authenticated', 'public.obsidian_notes'::regclass, 'delete') then
    raise exception 'the browser must not write obsidian_notes directly';
  end if;

  if exists (
    select 1
    from unnest(array[
      'public.redeem_desktop_auth_code(text,text,text,timestamptz,timestamptz)'::regprocedure,
      'public.rotate_desktop_device_token(text,text,text,timestamptz,timestamptz)'::regprocedure,
      'public.register_obsidian_vault(uuid,uuid,text,text)'::regprocedure,
      'public.apply_obsidian_note(uuid,uuid,text,text,text,text,text,integer,text,text,text,text,text)'::regprocedure,
      'public.delete_obsidian_note(uuid,uuid,text,integer)'::regprocedure,
      'public.move_obsidian_note(uuid,uuid,text,text,text,text,integer)'::regprocedure
    ]) as required_function(function_oid)
    join pg_proc on pg_proc.oid = required_function.function_oid
    where not pg_proc.prosecdef
      or not pg_proc.proconfig @> array['search_path=""']
      or has_function_privilege('anon', pg_proc.oid, 'execute')
      or has_function_privilege('authenticated', pg_proc.oid, 'execute')
      or not has_function_privilege('service_role', pg_proc.oid, 'execute')
  ) then
    raise exception 'Obsidian sync RPCs must be service-role-only SECURITY DEFINER with an empty search_path';
  end if;

  -- saved_items must accept the new source, or every note upload would fail.
  insert into auth.users (id) values (test_user_id), (other_user_id);
  insert into public.saved_items (user_id, url, normalized_url, source, title, searchable_text)
  values (
    test_user_id,
    'obsidian://open?vault=V&file=Probe',
    'obsidian://note/probe',
    'obsidian',
    'Probe',
    'Title: Probe'
  );

  result := public.register_obsidian_vault(test_user_id, null, 'vault-local-1', 'My Vault');
  vault_id := (result->>'vault_id')::uuid;
  if vault_id is null then
    raise exception 'vault registration must return a vault id';
  end if;

  -- Registering twice is how the client reconnects after a restart; it must
  -- return the same vault rather than create a second one.
  result := public.register_obsidian_vault(test_user_id, null, 'vault-local-1', 'My Vault Renamed');
  if (result->>'vault_id')::uuid <> vault_id then
    raise exception 're-registering a vault must be idempotent';
  end if;

  result := public.apply_obsidian_note(
    test_user_id, vault_id, 'file-1', 'Projects/Notes.md', 'Notes',
    '# Notes', pg_catalog.repeat('a', 64), null, 'Title: Notes',
    null, 'keyword_only', null, 'obsidian://open?vault=V&file=Projects/Notes'
  );
  if result->>'status' <> 'created' or (result->>'revision')::integer <> 1 then
    raise exception 'a new note must be created at revision 1';
  end if;

  -- A retried upload of identical content must not bump the revision.
  result := public.apply_obsidian_note(
    test_user_id, vault_id, 'file-1', 'Projects/Notes.md', 'Notes',
    '# Notes', pg_catalog.repeat('a', 64), null, 'Title: Notes',
    null, 'keyword_only', null, 'obsidian://open?vault=V&file=Projects/Notes'
  );
  if result->>'status' <> 'unchanged' or (result->>'revision')::integer <> 1 then
    raise exception 'a retried identical upload must be a no-op';
  end if;
  if (select count(*) from public.saved_items
      where user_id = test_user_id and normalized_url = 'obsidian://note/file-1') <> 1 then
    raise exception 'a retried upload must not duplicate the saved item';
  end if;

  result := public.apply_obsidian_note(
    test_user_id, vault_id, 'file-1', 'Projects/Notes.md', 'Notes',
    '# Notes edited', pg_catalog.repeat('b', 64), 1, 'Title: Notes',
    null, 'keyword_only', null, 'obsidian://open?vault=V&file=Projects/Notes'
  );
  if result->>'status' <> 'updated' or (result->>'revision')::integer <> 2 then
    raise exception 'an edit based on the current revision must be accepted';
  end if;

  -- The heart of the conflict strategy: a stale base revision is refused and
  -- the stored content is left exactly as it was.
  result := public.apply_obsidian_note(
    test_user_id, vault_id, 'file-1', 'Projects/Notes.md', 'Notes',
    '# Stale overwrite', pg_catalog.repeat('c', 64), 1, 'Title: Notes',
    null, 'keyword_only', null, 'obsidian://open?vault=V&file=Projects/Notes'
  );
  if result->>'status' <> 'conflict' or (result->>'revision')::integer <> 2 then
    raise exception 'a stale revision must be reported as a conflict';
  end if;
  if not exists (
    select 1 from public.obsidian_notes
    where vault_id = vault_id and client_file_id = 'file-1'
      and content_hash = pg_catalog.repeat('b', 64)
  ) then
    raise exception 'a conflict must never overwrite the stored note';
  end if;

  result := public.move_obsidian_note(
    test_user_id, vault_id, 'file-1', 'Archive/Notes.md', 'Notes',
    'obsidian://open?vault=V&file=Archive/Notes', 2
  );
  if result->>'status' <> 'moved' or (result->>'revision')::integer <> 3 then
    raise exception 'a move based on the current revision must be accepted';
  end if;
  if not exists (
    select 1 from public.saved_items
    where user_id = test_user_id
      and normalized_url = 'obsidian://note/file-1'
      and metadata->'obsidian'->>'relativePath' = 'Archive/Notes.md'
  ) then
    raise exception 'a move must keep the saved item identity and update its path';
  end if;

  result := public.delete_obsidian_note(test_user_id, vault_id, 'file-1', 3);
  if result->>'status' <> 'deleted' then
    raise exception 'a delete based on the current revision must be accepted';
  end if;
  if exists (
    select 1 from public.saved_items
    where user_id = test_user_id and normalized_url = 'obsidian://note/file-1'
  ) then
    raise exception 'deleting a note locally must remove the synced item';
  end if;

  result := public.delete_obsidian_note(test_user_id, vault_id, 'file-1', null);
  if result->>'status' <> 'unchanged' then
    raise exception 'a repeated delete must be a safe no-op';
  end if;

  -- Re-creating a note with the same client id must revive it, not error.
  result := public.apply_obsidian_note(
    test_user_id, vault_id, 'file-1', 'Projects/Notes.md', 'Notes',
    '# Back again', pg_catalog.repeat('d', 64), null, 'Title: Notes',
    null, 'keyword_only', null, 'obsidian://open?vault=V&file=Projects/Notes'
  );
  if result->>'status' <> 'updated' then
    raise exception 'restoring a deleted note must succeed';
  end if;

  -- Cross-tenant safety: one user's device must not be able to name another
  -- user's vault id and write into it.
  result := public.register_obsidian_vault(other_user_id, null, 'vault-local-1', 'Other Vault');
  other_vault_id := (result->>'vault_id')::uuid;
  if other_vault_id = vault_id then
    raise exception 'vault ids must not be shared across users';
  end if;

  begin
    perform public.apply_obsidian_note(
      other_user_id, vault_id, 'file-2', 'Projects/Steal.md', 'Steal',
      '# Steal', pg_catalog.repeat('e', 64), null, 'Title: Steal',
      null, 'keyword_only', null, 'obsidian://open?vault=V&file=Projects/Steal'
    );
    raise exception 'writing into another user''s vault must be refused';
  exception
    when insufficient_privilege then
      null;
  end;

  select revision into note_revision
  from public.obsidian_notes
  where vault_id = vault_id and client_file_id = 'file-1';
  if note_revision is null then
    raise exception 'the restored note must still exist';
  end if;
end;
$$;

rollback;
