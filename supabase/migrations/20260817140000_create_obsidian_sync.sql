-- Obsidian vault sync.
--
-- A note lives in saved_items like every other saved thing, so the existing
-- hybrid search finds it with no query changes. Identity is the client-assigned
-- file id rather than the vault path, so renaming or moving a note is an update
-- instead of a delete followed by a re-create.
--
-- The desktop client authenticates with an opaque device token rather than a
-- Supabase session: it can be revoked for one device without ending the user's
-- browser sessions, and it cannot be used to change account credentials.

alter table public.saved_items
  drop constraint saved_items_source_check;

alter table public.saved_items
  add constraint saved_items_source_check check (
    source in (
      'github',
      'instagram',
      'youtube',
      'reddit',
      'x',
      'website',
      'other',
      'obsidian'
    )
  );

create table public.desktop_devices (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_name text not null check (
    pg_catalog.btrim(device_name) <> '' and pg_catalog.length(device_name) <= 120
  ),
  platform text not null default 'windows',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create index desktop_devices_user_idx on public.desktop_devices (user_id);

-- Only hashes are stored, so a database leak cannot be replayed against the API.
create table public.desktop_device_tokens (
  id uuid primary key default extensions.gen_random_uuid(),
  device_id uuid not null references public.desktop_devices(id) on delete cascade,
  access_token_hash text not null unique,
  refresh_token_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index desktop_device_tokens_device_idx
  on public.desktop_device_tokens (device_id);

create table public.desktop_auth_codes (
  code_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_challenge text not null check (pg_catalog.length(code_challenge) between 32 and 256),
  redirect_uri text not null check (pg_catalog.length(redirect_uri) <= 512),
  device_name text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.obsidian_vaults (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.desktop_devices(id) on delete set null,
  client_vault_id text not null check (
    pg_catalog.btrim(client_vault_id) <> ''
    and pg_catalog.length(client_vault_id) <= 128
  ),
  name text not null check (pg_catalog.length(name) <= 200),
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'initial_sync', 'syncing', 'paused', 'error')),
  note_count integer not null default 0 check (note_count >= 0),
  last_seen_at timestamptz,
  last_synced_at timestamptz,
  last_full_scan_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_vault_id)
);

comment on table public.obsidian_vaults is
  'One registered Obsidian vault per user per client-generated vault id.';

create table public.obsidian_notes (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vault_id uuid not null references public.obsidian_vaults(id) on delete cascade,
  client_file_id text not null check (
    pg_catalog.btrim(client_file_id) <> ''
    and pg_catalog.length(client_file_id) <= 128
  ),
  saved_item_id uuid references public.saved_items(id) on delete set null,
  relative_path text not null check (pg_catalog.length(relative_path) <= 1024),
  content_hash text not null check (pg_catalog.length(content_hash) between 32 and 128),
  -- Bumped on every accepted content or path change. The client sends the
  -- revision it based its edit on so the server can refuse a stale overwrite.
  revision integer not null default 1 check (revision > 0),
  deleted_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vault_id, client_file_id)
);

create index obsidian_notes_user_idx on public.obsidian_notes (user_id, vault_id);
create index obsidian_notes_updated_idx
  on public.obsidian_notes (vault_id, updated_at desc);
create index obsidian_notes_saved_item_idx
  on public.obsidian_notes (saved_item_id);

alter table public.desktop_devices enable row level security;
alter table public.desktop_device_tokens enable row level security;
alter table public.desktop_auth_codes enable row level security;
alter table public.obsidian_vaults enable row level security;
alter table public.obsidian_notes enable row level security;

-- The browser may list and revoke its own devices and vaults. Everything the
-- sync client writes goes through service-role RPCs instead.
create policy "Users can read their desktop devices"
on public.desktop_devices for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can revoke their desktop devices"
on public.desktop_devices for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can read their Obsidian vaults"
on public.obsidian_vaults for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can update their Obsidian vaults"
on public.obsidian_vaults for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can read their Obsidian notes"
on public.obsidian_notes for select to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.desktop_devices from anon, authenticated;
revoke all on table public.desktop_device_tokens from anon, authenticated;
revoke all on table public.desktop_auth_codes from anon, authenticated;
revoke all on table public.obsidian_vaults from anon, authenticated;
revoke all on table public.obsidian_notes from anon, authenticated;

grant select, update on table public.desktop_devices to authenticated;
grant select, update on table public.obsidian_vaults to authenticated;
grant select on table public.obsidian_notes to authenticated;

create trigger set_desktop_devices_updated_at
before update on public.desktop_devices
for each row execute function public.set_saved_items_updated_at();

create trigger set_obsidian_vaults_updated_at
before update on public.obsidian_vaults
for each row execute function public.set_saved_items_updated_at();

create trigger set_obsidian_notes_updated_at
before update on public.obsidian_notes
for each row execute function public.set_saved_items_updated_at();

-- Exchanges a consumed authorization code for a device and its first token
-- pair. The PKCE challenge is verified in the application layer before this
-- runs; this function enforces single use so a replayed code cannot mint a
-- second device.
create function public.redeem_desktop_auth_code(
  p_code_hash text,
  p_access_token_hash text,
  p_refresh_token_hash text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  code_row public.desktop_auth_codes%rowtype;
  device_id uuid;
begin
  if p_code_hash is null or p_access_token_hash is null
    or p_refresh_token_hash is null then
    raise exception 'Desktop token identifiers must not be null'
      using errcode = '22004';
  end if;

  update public.desktop_auth_codes
  set consumed_at = pg_catalog.now()
  where code_hash = p_code_hash
    and consumed_at is null
    and expires_at > pg_catalog.now()
  returning * into code_row;

  if not found then
    return null;
  end if;

  insert into public.desktop_devices (user_id, device_name)
  values (code_row.user_id, code_row.device_name)
  returning id into device_id;

  insert into public.desktop_device_tokens (
    device_id,
    access_token_hash,
    refresh_token_hash,
    access_expires_at,
    refresh_expires_at
  ) values (
    device_id,
    p_access_token_hash,
    p_refresh_token_hash,
    p_access_expires_at,
    p_refresh_expires_at
  );

  return pg_catalog.jsonb_build_object(
    'user_id', code_row.user_id,
    'device_id', device_id
  );
end;
$$;

-- Rotates a refresh token. The old row is consumed in the same statement that
-- issues the new one, so a stolen refresh token is usable at most once and the
-- rotation is visible to the legitimate client as an immediate auth failure.
create function public.rotate_desktop_device_token(
  p_refresh_token_hash text,
  p_access_token_hash text,
  p_next_refresh_token_hash text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  token_row public.desktop_device_tokens%rowtype;
  owner_id uuid;
begin
  update public.desktop_device_tokens
  set consumed_at = pg_catalog.now()
  where refresh_token_hash = p_refresh_token_hash
    and consumed_at is null
    and refresh_expires_at > pg_catalog.now()
  returning * into token_row;

  if not found then
    return null;
  end if;

  select device.user_id
  into owner_id
  from public.desktop_devices as device
  where device.id = token_row.device_id
    and device.revoked_at is null;

  if not found then
    return null;
  end if;

  insert into public.desktop_device_tokens (
    device_id,
    access_token_hash,
    refresh_token_hash,
    access_expires_at,
    refresh_expires_at
  ) values (
    token_row.device_id,
    p_access_token_hash,
    p_next_refresh_token_hash,
    p_access_expires_at,
    p_refresh_expires_at
  );

  update public.desktop_devices
  set last_seen_at = pg_catalog.now()
  where id = token_row.device_id;

  return pg_catalog.jsonb_build_object(
    'user_id', owner_id,
    'device_id', token_row.device_id
  );
end;
$$;

create function public.register_obsidian_vault(
  p_user_id uuid,
  p_device_id uuid,
  p_client_vault_id text,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  vault_row public.obsidian_vaults%rowtype;
begin
  if p_user_id is null or p_client_vault_id is null or p_name is null then
    raise exception 'Vault registration fields must not be null'
      using errcode = '22004';
  end if;

  insert into public.obsidian_vaults (
    user_id,
    device_id,
    client_vault_id,
    name,
    last_seen_at
  ) values (
    p_user_id,
    p_device_id,
    p_client_vault_id,
    p_name,
    pg_catalog.now()
  )
  on conflict (user_id, client_vault_id) do update
  set name = excluded.name,
      device_id = excluded.device_id,
      last_seen_at = pg_catalog.now()
  returning * into vault_row;

  return pg_catalog.jsonb_build_object(
    'vault_id', vault_row.id,
    'name', vault_row.name,
    'sync_status', vault_row.sync_status,
    'note_count', vault_row.note_count,
    'last_synced_at', vault_row.last_synced_at,
    'last_full_scan_at', vault_row.last_full_scan_at
  );
end;
$$;

-- Applies one note. Returns one of: unchanged, created, updated, conflict.
--
-- 'unchanged' is what makes a retried upload safe: an identical content hash
-- never bumps the revision and never rewrites the row, so the client can retry
-- an upload whose response it never saw without creating a duplicate.
create function public.apply_obsidian_note(
  p_user_id uuid,
  p_vault_id uuid,
  p_client_file_id text,
  p_relative_path text,
  p_title text,
  p_content text,
  p_content_hash text,
  p_base_revision integer,
  p_searchable_text text,
  p_embedding text,
  p_indexing_status text,
  p_indexing_error text,
  p_open_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  note_row public.obsidian_notes%rowtype;
  item_id uuid;
  identity_url constant text := 'obsidian://note/' || p_client_file_id;
  next_revision integer;
begin
  if p_user_id is null or p_vault_id is null or p_client_file_id is null
    or p_content_hash is null or p_relative_path is null then
    raise exception 'Note fields must not be null' using errcode = '22004';
  end if;
  if p_indexing_status not in ('ready', 'keyword_only', 'pending', 'failed') then
    raise exception 'Invalid indexing status' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.obsidian_vaults as vault
    where vault.id = p_vault_id and vault.user_id = p_user_id
  ) then
    raise exception 'Vault does not belong to this user' using errcode = '42501';
  end if;

  select * into note_row
  from public.obsidian_notes
  where vault_id = p_vault_id and client_file_id = p_client_file_id
  for update;

  if found and note_row.deleted_at is null then
    if note_row.content_hash = p_content_hash
      and note_row.relative_path = p_relative_path then
      return pg_catalog.jsonb_build_object(
        'status', 'unchanged',
        'revision', note_row.revision,
        'savedItemId', note_row.saved_item_id
      );
    end if;

    -- A client that based its upload on an older revision must not clobber a
    -- change it has not seen. Report the server state and let it reconcile.
    if p_base_revision is null or p_base_revision <> note_row.revision then
      return pg_catalog.jsonb_build_object(
        'status', 'conflict',
        'revision', note_row.revision,
        'serverContentHash', note_row.content_hash,
        'serverRelativePath', note_row.relative_path,
        'savedItemId', note_row.saved_item_id
      );
    end if;
  end if;

  insert into public.saved_items (
    user_id,
    url,
    normalized_url,
    source,
    title,
    description,
    content,
    author,
    tags,
    metadata,
    searchable_text,
    embedding,
    indexing_status,
    indexing_error
  ) values (
    p_user_id,
    p_open_url,
    identity_url,
    'obsidian',
    p_title,
    null,
    p_content,
    null,
    '{}',
    pg_catalog.jsonb_build_object(
      'obsidian',
      pg_catalog.jsonb_build_object(
        'vaultId', p_vault_id,
        'clientFileId', p_client_file_id,
        'relativePath', p_relative_path
      )
    ),
    p_searchable_text,
    case
      when p_embedding is null then null
      else p_embedding::extensions.vector
    end,
    p_indexing_status,
    p_indexing_error
  )
  on conflict (user_id, normalized_url) do update
  set url = excluded.url,
      title = excluded.title,
      content = excluded.content,
      metadata = excluded.metadata,
      searchable_text = excluded.searchable_text,
      embedding = excluded.embedding,
      indexing_status = excluded.indexing_status,
      indexing_error = excluded.indexing_error
  returning id into item_id;

  if note_row.id is null then
    insert into public.obsidian_notes (
      user_id,
      vault_id,
      client_file_id,
      saved_item_id,
      relative_path,
      content_hash
    ) values (
      p_user_id,
      p_vault_id,
      p_client_file_id,
      item_id,
      p_relative_path,
      p_content_hash
    )
    returning revision into next_revision;

    update public.obsidian_vaults
    set note_count = note_count + 1,
        last_synced_at = pg_catalog.now()
    where id = p_vault_id;

    return pg_catalog.jsonb_build_object(
      'status', 'created',
      'revision', next_revision,
      'savedItemId', item_id
    );
  end if;

  update public.obsidian_notes
  set saved_item_id = item_id,
      relative_path = p_relative_path,
      content_hash = p_content_hash,
      revision = revision + 1,
      deleted_at = null,
      synced_at = pg_catalog.now()
  where id = note_row.id
  returning revision into next_revision;

  if note_row.deleted_at is not null then
    update public.obsidian_vaults
    set note_count = note_count + 1,
        last_synced_at = pg_catalog.now()
    where id = p_vault_id;
  else
    update public.obsidian_vaults
    set last_synced_at = pg_catalog.now()
    where id = p_vault_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'status', 'updated',
    'revision', next_revision,
    'savedItemId', item_id
  );
end;
$$;

-- Deleting locally removes the cloud copy but keeps a tombstone, so a repeated
-- delete is a no-op rather than an error and the client can retry safely.
create function public.delete_obsidian_note(
  p_user_id uuid,
  p_vault_id uuid,
  p_client_file_id text,
  p_base_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  note_row public.obsidian_notes%rowtype;
begin
  select * into note_row
  from public.obsidian_notes
  where vault_id = p_vault_id
    and client_file_id = p_client_file_id
    and user_id = p_user_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'unchanged', 'revision', 0);
  end if;
  if note_row.deleted_at is not null then
    return pg_catalog.jsonb_build_object(
      'status', 'unchanged',
      'revision', note_row.revision
    );
  end if;
  if p_base_revision is not null and p_base_revision <> note_row.revision then
    return pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'revision', note_row.revision,
      'serverContentHash', note_row.content_hash
    );
  end if;

  delete from public.saved_items
  where id = note_row.saved_item_id and user_id = p_user_id;

  update public.obsidian_notes
  set deleted_at = pg_catalog.now(),
      saved_item_id = null,
      revision = revision + 1,
      synced_at = pg_catalog.now()
  where id = note_row.id;

  update public.obsidian_vaults
  set note_count = greatest(note_count - 1, 0),
      last_synced_at = pg_catalog.now()
  where id = p_vault_id;

  return pg_catalog.jsonb_build_object(
    'status', 'deleted',
    'revision', note_row.revision + 1
  );
end;
$$;

create function public.move_obsidian_note(
  p_user_id uuid,
  p_vault_id uuid,
  p_client_file_id text,
  p_relative_path text,
  p_title text,
  p_open_url text,
  p_base_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  note_row public.obsidian_notes%rowtype;
begin
  select * into note_row
  from public.obsidian_notes
  where vault_id = p_vault_id
    and client_file_id = p_client_file_id
    and user_id = p_user_id
    and deleted_at is null
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('status', 'missing', 'revision', 0);
  end if;
  if note_row.relative_path = p_relative_path then
    return pg_catalog.jsonb_build_object(
      'status', 'unchanged',
      'revision', note_row.revision
    );
  end if;
  if p_base_revision is not null and p_base_revision <> note_row.revision then
    return pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'revision', note_row.revision,
      'serverRelativePath', note_row.relative_path
    );
  end if;

  update public.saved_items
  set url = p_open_url,
      title = p_title,
      metadata = pg_catalog.jsonb_set(
        metadata,
        '{obsidian,relativePath}',
        pg_catalog.to_jsonb(p_relative_path),
        true
      )
  where id = note_row.saved_item_id and user_id = p_user_id;

  update public.obsidian_notes
  set relative_path = p_relative_path,
      revision = revision + 1,
      synced_at = pg_catalog.now()
  where id = note_row.id;

  update public.obsidian_vaults
  set last_synced_at = pg_catalog.now()
  where id = p_vault_id;

  return pg_catalog.jsonb_build_object(
    'status', 'moved',
    'revision', note_row.revision + 1
  );
end;
$$;

revoke all on function public.redeem_desktop_auth_code(text, text, text, timestamptz, timestamptz)
from public, anon, authenticated;
grant execute on function public.redeem_desktop_auth_code(text, text, text, timestamptz, timestamptz)
to service_role;

revoke all on function public.rotate_desktop_device_token(text, text, text, timestamptz, timestamptz)
from public, anon, authenticated;
grant execute on function public.rotate_desktop_device_token(text, text, text, timestamptz, timestamptz)
to service_role;

revoke all on function public.register_obsidian_vault(uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.register_obsidian_vault(uuid, uuid, text, text)
to service_role;

revoke all on function public.apply_obsidian_note(
  uuid, uuid, text, text, text, text, text, integer, text, text, text, text, text
)
from public, anon, authenticated;
grant execute on function public.apply_obsidian_note(
  uuid, uuid, text, text, text, text, text, integer, text, text, text, text, text
)
to service_role;

revoke all on function public.delete_obsidian_note(uuid, uuid, text, integer)
from public, anon, authenticated;
grant execute on function public.delete_obsidian_note(uuid, uuid, text, integer)
to service_role;

revoke all on function public.move_obsidian_note(
  uuid, uuid, text, text, text, text, integer
)
from public, anon, authenticated;
grant execute on function public.move_obsidian_note(
  uuid, uuid, text, text, text, text, integer
)
to service_role;
