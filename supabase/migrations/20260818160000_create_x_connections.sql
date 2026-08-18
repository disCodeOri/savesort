-- X (Twitter) bookmark sync.
--
-- Bookmarks become ordinary saved_items with source = 'x', so they join the
-- existing hybrid search with no query changes.
--
-- Two things drive the design:
--
-- 1. The X API gives no "when did the user bookmark this" timestamp, so
--    x_bookmarks records first_seen_at — the first time GRAPPlin observed the
--    post in the user's bookmarks. It is never presented as a bookmark time.
--
-- 2. Removing a bookmark on X must not delete the user's GRAPPlin item. The
--    bookmark relationship is deactivated; the saved_item, notes and tags all
--    survive. Reconciliation only ever runs after a provably complete
--    traversal, so a partial or rate-limited sync can never deactivate
--    anything.

create table public.x_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  x_user_id text not null check (
    pg_catalog.btrim(x_user_id) <> '' and pg_catalog.length(x_user_id) <= 64
  ),
  username text not null default '',
  display_name text,
  profile_image_url text,
  connection_status text not null default 'connected'
    check (connection_status in ('connected', 'reconnect_required')),
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'running', 'failed', 'rate_limited')),
  active_sync_id uuid,
  next_page integer not null default 1 check (next_page > 0),
  pagination_token text check (
    pagination_token <> '' and length(pagination_token) <= 512
  ),
  discovered_count integer not null default 0 check (discovered_count >= 0),
  saved_count integer not null default 0 check (saved_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  sync_started_at timestamptz,
  last_synced_at timestamptz,
  last_sync_error text,
  -- Persisted so the UI can tell the user when syncing may resume instead of
  -- hammering X with retries.
  rate_limit_reset_at timestamptz,
  page_lease_id uuid,
  page_lease_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint x_connections_page_lease_pair check (
    (page_lease_id is null and page_lease_started_at is null)
    or (page_lease_id is not null and page_lease_started_at is not null)
  ),
  unique (x_user_id)
);

create table public.x_connection_secrets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  granted_scopes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.x_bookmarks (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id text not null check (pg_catalog.length(post_id) <= 32),
  saved_item_id uuid references public.saved_items(id) on delete set null,
  -- First time GRAPPlin saw this post in the user's bookmarks. NOT the moment
  -- the user bookmarked it, which X does not expose.
  first_seen_at timestamptz not null default now(),
  -- The sync that most recently observed this post. Reconciliation compares
  -- against the completed sync id to find bookmarks that disappeared.
  last_seen_sync_id uuid,
  active boolean not null default true,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create index x_bookmarks_active_idx
  on public.x_bookmarks (user_id, active);
create index x_bookmarks_saved_item_idx
  on public.x_bookmarks (saved_item_id);

alter table public.x_connections enable row level security;
alter table public.x_connection_secrets enable row level security;
alter table public.x_bookmarks enable row level security;

create policy "Users can read their X connection"
on public.x_connections for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can update their X connection metadata"
on public.x_connections for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can read their X bookmarks"
on public.x_bookmarks for select to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.x_connections from anon, authenticated;
revoke all on table public.x_connection_secrets from anon, authenticated;
revoke all on table public.x_bookmarks from anon, authenticated;

grant select, update on table public.x_connections to authenticated;
grant select on table public.x_bookmarks to authenticated;

create trigger set_x_connections_updated_at
before update on public.x_connections
for each row execute function public.set_saved_items_updated_at();

create trigger set_x_connection_secrets_updated_at
before update on public.x_connection_secrets
for each row execute function public.set_saved_items_updated_at();

create trigger set_x_bookmarks_updated_at
before update on public.x_bookmarks
for each row execute function public.set_saved_items_updated_at();

create function public.save_x_connection(
  p_user_id uuid,
  p_x_user_id text,
  p_username text,
  p_display_name text,
  p_profile_image_url text,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_granted_scopes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'p_user_id must not be null' using errcode = '22004';
  end if;
  if p_x_user_id is null or pg_catalog.btrim(p_x_user_id) = '' then
    raise exception 'p_x_user_id must not be blank' using errcode = '22023';
  end if;
  if p_access_token_ciphertext is null
    or pg_catalog.btrim(p_access_token_ciphertext) = '' then
    raise exception 'p_access_token_ciphertext must not be blank'
      using errcode = '22023';
  end if;

  insert into public.x_connection_secrets (
    user_id,
    access_token_ciphertext,
    refresh_token_ciphertext,
    access_token_expires_at,
    granted_scopes
  ) values (
    p_user_id,
    p_access_token_ciphertext,
    p_refresh_token_ciphertext,
    p_access_token_expires_at,
    p_granted_scopes
  )
  on conflict (user_id) do update
  set access_token_ciphertext = excluded.access_token_ciphertext,
      refresh_token_ciphertext = coalesce(
        excluded.refresh_token_ciphertext,
        public.x_connection_secrets.refresh_token_ciphertext
      ),
      access_token_expires_at = excluded.access_token_expires_at,
      granted_scopes = excluded.granted_scopes;

  insert into public.x_connections (
    user_id, x_user_id, username, display_name, profile_image_url,
    connection_status, sync_status
  ) values (
    p_user_id,
    p_x_user_id,
    coalesce(p_username, ''),
    p_display_name,
    p_profile_image_url,
    'connected',
    'idle'
  )
  on conflict (user_id) do update
  set x_user_id = excluded.x_user_id,
      username = excluded.username,
      display_name = excluded.display_name,
      profile_image_url = excluded.profile_image_url,
      connection_status = 'connected',
      last_sync_error = null,
      rate_limit_reset_at = null;
end;
$$;

create function public.begin_x_sync(
  p_user_id uuid,
  p_sync_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  if p_user_id is null or p_sync_id is null then
    raise exception 'X sync identifiers must not be null' using errcode = '22004';
  end if;

  -- The stale-sync window is what stops a crashed sync from blocking the user
  -- forever, while still preventing two concurrent imports.
  update public.x_connections
  set sync_status = 'running',
      active_sync_id = p_sync_id,
      next_page = 1,
      pagination_token = null,
      discovered_count = 0,
      saved_count = 0,
      updated_count = 0,
      skipped_count = 0,
      sync_started_at = pg_catalog.clock_timestamp(),
      last_sync_error = null,
      rate_limit_reset_at = null,
      page_lease_id = null,
      page_lease_started_at = null,
      updated_at = pg_catalog.now()
  where user_id = p_user_id
    and connection_status = 'connected'
    and (
      sync_status <> 'running'
      or sync_started_at < pg_catalog.now() - interval '10 minutes'
    );
  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

create function public.claim_x_sync_page(
  p_user_id uuid,
  p_sync_id uuid,
  p_page integer,
  p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  if p_user_id is null or p_sync_id is null or p_lease_id is null then
    raise exception 'X sync page identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'X sync page must be positive' using errcode = '22023';
  end if;

  update public.x_connections
  set page_lease_id = p_lease_id,
      page_lease_started_at = pg_catalog.clock_timestamp(),
      sync_started_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.now()
  where user_id = p_user_id
    and connection_status = 'connected'
    and sync_status = 'running'
    and active_sync_id = p_sync_id
    and next_page = p_page
    and (
      page_lease_id is null
      or page_lease_started_at < pg_catalog.now() - interval '10 minutes'
    );
  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

create function public.heartbeat_x_sync_page(
  p_user_id uuid,
  p_sync_id uuid,
  p_page integer,
  p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  if p_user_id is null or p_sync_id is null or p_lease_id is null then
    raise exception 'X sync page identifiers must not be null'
      using errcode = '22004';
  end if;

  update public.x_connections
  set page_lease_started_at = pg_catalog.clock_timestamp(),
      sync_started_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.now()
  where user_id = p_user_id
    and connection_status = 'connected'
    and sync_status = 'running'
    and active_sync_id = p_sync_id
    and next_page = p_page
    and page_lease_id = p_lease_id;
  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

-- Applies one page of bookmarks and advances the cursor atomically with the
-- item writes, so progress can never run ahead of persisted data.
create function public.apply_x_sync_page(
  p_user_id uuid,
  p_sync_id uuid,
  p_lease_id uuid,
  p_page integer,
  p_next_page integer,
  p_pagination_token text,
  p_discovered_count integer,
  p_skipped_count integer,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection_row public.x_connections%rowtype;
  item jsonb;
  item_id uuid;
  existing_bookmark public.x_bookmarks%rowtype;
  created_count integer := 0;
  refreshed_count integer := 0;
  final_status text;
begin
  if p_user_id is null or p_sync_id is null or p_lease_id is null then
    raise exception 'X sync page identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'X sync page must be positive' using errcode = '22023';
  end if;
  if p_next_page is not null and p_next_page <> p_page + 1 then
    raise exception 'X next page must advance by one' using errcode = '22023';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
    or pg_catalog.jsonb_array_length(p_items) > 100
    or pg_catalog.jsonb_array_length(p_items) + p_skipped_count
      <> p_discovered_count then
    raise exception 'X page items do not match the page counts'
      using errcode = '22023';
  end if;

  select connection.* into connection_row
  from public.x_connections as connection
  where connection.user_id = p_user_id
    and connection.connection_status = 'connected'
    and connection.sync_status = 'running'
    and connection.active_sync_id = p_sync_id
    and connection.next_page = p_page
    and connection.page_lease_id = p_lease_id
  for update;

  if not found then
    return null;
  end if;

  for item in
    select value from pg_catalog.jsonb_array_elements(p_items) as entry(value)
  loop
    if item->>'user_id' is null
      or (item->>'user_id')::uuid <> p_user_id
      or item->>'post_id' is null
      or item->>'normalized_url' is null
      or item->>'searchable_text' is null then
      raise exception 'X page item is invalid' using errcode = '22023';
    end if;

    select * into existing_bookmark
    from public.x_bookmarks
    where user_id = p_user_id and post_id = item->>'post_id';

    insert into public.saved_items (
      user_id, url, normalized_url, source, title, description, content,
      author, thumbnail_url, tags, metadata, searchable_text, embedding,
      indexing_status, indexing_error
    ) values (
      p_user_id,
      item->>'url',
      item->>'normalized_url',
      'x',
      item->>'title',
      item->>'description',
      item->>'content',
      item->>'author',
      item->>'thumbnail_url',
      array(
        select tag.value
        from pg_catalog.jsonb_array_elements_text(
          coalesce(item->'tags', '[]'::jsonb)
        ) as tag(value)
      ),
      coalesce(item->'metadata', '{}'::jsonb),
      item->>'searchable_text',
      case
        when item->'embedding' is null
          or pg_catalog.jsonb_typeof(item->'embedding') = 'null' then null
        else (item->>'embedding')::extensions.vector
      end,
      item->>'indexing_status',
      item->>'indexing_error'
    )
    on conflict (user_id, normalized_url) do update
    -- Only provider-owned columns are refreshed. notes and tags belong to the
    -- user and are never touched by a sync.
    set title = excluded.title,
        description = excluded.description,
        content = excluded.content,
        author = excluded.author,
        thumbnail_url = excluded.thumbnail_url,
        metadata = public.saved_items.metadata || excluded.metadata,
        searchable_text = excluded.searchable_text,
        embedding = coalesce(excluded.embedding, public.saved_items.embedding),
        indexing_status = excluded.indexing_status,
        indexing_error = excluded.indexing_error
    returning id into item_id;

    if existing_bookmark.post_id is null then
      created_count := created_count + 1;
    else
      refreshed_count := refreshed_count + 1;
    end if;

    insert into public.x_bookmarks (
      user_id, post_id, saved_item_id, last_seen_sync_id, active, removed_at
    ) values (
      p_user_id, item->>'post_id', item_id, p_sync_id, true, null
    )
    on conflict (user_id, post_id) do update
    set saved_item_id = excluded.saved_item_id,
        last_seen_sync_id = excluded.last_seen_sync_id,
        -- Re-bookmarking on X revives the relationship without disturbing
        -- first_seen_at.
        active = true,
        removed_at = null;
  end loop;

  final_status := case when p_next_page is null then 'complete' else 'running' end;
  update public.x_connections
  set discovered_count = discovered_count + p_discovered_count,
      saved_count = saved_count + created_count,
      updated_count = updated_count + refreshed_count,
      skipped_count = skipped_count + p_skipped_count,
      next_page = coalesce(p_next_page, next_page),
      pagination_token = p_pagination_token,
      sync_status = case when p_next_page is null then 'idle' else 'running' end,
      active_sync_id = case when p_next_page is null then null else active_sync_id end,
      page_lease_id = null,
      page_lease_started_at = null,
      sync_started_at = pg_catalog.clock_timestamp(),
      last_synced_at = case
        when p_next_page is null then pg_catalog.clock_timestamp()
        else last_synced_at
      end,
      last_sync_error = null,
      updated_at = pg_catalog.now()
  where user_id = p_user_id
    and sync_status = 'running'
    and active_sync_id = p_sync_id
    and next_page = p_page
    and page_lease_id = p_lease_id
  returning * into connection_row;

  if not found then
    raise exception 'X page lease changed during apply' using errcode = '40001';
  end if;

  return pg_catalog.jsonb_build_object(
    'status', final_status,
    'next_page', p_next_page,
    'discovered_count', connection_row.discovered_count,
    'saved_count', connection_row.saved_count,
    'updated_count', connection_row.updated_count,
    'skipped_count', connection_row.skipped_count
  );
end;
$$;

-- Deactivates bookmarks the completed traversal never saw. Callable ONLY with
-- the id of a sync that genuinely reached the end of the listing; a partial,
-- failed, or rate-limited sync must never invoke this, or it would wrongly
-- deactivate everything it had not yet reached.
--
-- Saved items are deliberately left untouched: unbookmarking on X removes the
-- relationship, not the user's library entry.
create function public.reconcile_x_bookmarks(
  p_user_id uuid,
  p_sync_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deactivated_count integer;
begin
  if p_user_id is null or p_sync_id is null then
    raise exception 'X reconciliation identifiers must not be null'
      using errcode = '22004';
  end if;

  update public.x_bookmarks
  set active = false,
      removed_at = pg_catalog.clock_timestamp()
  where user_id = p_user_id
    and active = true
    and (last_seen_sync_id is null or last_seen_sync_id <> p_sync_id);
  get diagnostics deactivated_count = row_count;
  return deactivated_count;
end;
$$;

create function public.fail_x_sync_page(
  p_user_id uuid,
  p_sync_id uuid,
  p_page integer,
  p_lease_id uuid,
  p_error text,
  p_reconnect_required boolean,
  p_rate_limited boolean,
  p_rate_limit_reset_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  if p_user_id is null or p_sync_id is null then
    raise exception 'X sync identifiers must not be null' using errcode = '22004';
  end if;
  if p_error is null or p_error = '' or pg_catalog.length(p_error) > 200 then
    raise exception 'X sync failure metadata is invalid' using errcode = '22023';
  end if;

  -- The pagination cursor is deliberately preserved so a rate-limited or
  -- failed sync can resume from where it stopped rather than paying to
  -- re-read pages that already persisted.
  update public.x_connections
  set connection_status = case
        when p_reconnect_required then 'reconnect_required'
        else connection_status
      end,
      sync_status = case when p_rate_limited then 'rate_limited' else 'failed' end,
      active_sync_id = null,
      page_lease_id = null,
      page_lease_started_at = null,
      sync_started_at = pg_catalog.clock_timestamp(),
      last_sync_error = p_error,
      rate_limit_reset_at = p_rate_limit_reset_at,
      updated_at = pg_catalog.now()
  where user_id = p_user_id
    and sync_status = 'running'
    and active_sync_id = p_sync_id
    and next_page = p_page
    and (
      page_lease_id = p_lease_id
      or (page_lease_id is null and p_lease_id is null)
    );
  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

revoke all on function public.save_x_connection(
  uuid, text, text, text, text, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.save_x_connection(
  uuid, text, text, text, text, text, text, timestamptz, text
) to service_role;

revoke all on function public.begin_x_sync(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.begin_x_sync(uuid, uuid) to service_role;

revoke all on function public.claim_x_sync_page(uuid, uuid, integer, uuid)
from public, anon, authenticated;
grant execute on function public.claim_x_sync_page(uuid, uuid, integer, uuid)
to service_role;

revoke all on function public.heartbeat_x_sync_page(uuid, uuid, integer, uuid)
from public, anon, authenticated;
grant execute on function public.heartbeat_x_sync_page(uuid, uuid, integer, uuid)
to service_role;

revoke all on function public.apply_x_sync_page(
  uuid, uuid, uuid, integer, integer, text, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_x_sync_page(
  uuid, uuid, uuid, integer, integer, text, integer, integer, jsonb
) to service_role;

revoke all on function public.reconcile_x_bookmarks(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.reconcile_x_bookmarks(uuid, uuid) to service_role;

revoke all on function public.fail_x_sync_page(
  uuid, uuid, integer, uuid, text, boolean, boolean, timestamptz
) from public, anon, authenticated;
grant execute on function public.fail_x_sync_page(
  uuid, uuid, integer, uuid, text, boolean, boolean, timestamptz
) to service_role;
