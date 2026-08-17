-- Reddit saved posts are private to the account that saved them, so a sync can
-- only ever read the connected user's own listing through their OAuth grant.
-- Reddit paginates listings with an opaque `after` fullname instead of numbered
-- pages, so this schema keeps `next_page` purely for lease ordering and stores
-- the provider cursor the next page must be requested with in `next_cursor`.

create table public.reddit_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reddit_user_id text not null,
  reddit_username text not null,
  reddit_icon_url text,
  connection_status text not null default 'connected'
    check (connection_status in ('connected', 'reconnect_required')),
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'running', 'failed')),
  active_sync_id uuid,
  next_page integer not null default 1 check (next_page > 0),
  next_cursor text check (next_cursor <> '' and length(next_cursor) <= 256),
  discovered_count integer not null default 0 check (discovered_count >= 0),
  saved_count integer not null default 0 check (saved_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  sync_started_at timestamptz,
  last_synced_at timestamptz,
  last_sync_error text,
  page_lease_id uuid,
  page_lease_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reddit_connections_page_lease_pair check (
    (page_lease_id is null and page_lease_started_at is null)
    or (page_lease_id is not null and page_lease_started_at is not null)
  ),
  unique (reddit_user_id)
);

comment on table public.reddit_connections is
  'One Reddit account link per SaveSort user, with saved-listing sync progress.';
comment on column public.reddit_connections.next_cursor is
  'Reddit listing `after` fullname for the next page. Null means start from the newest saved item.';

create table public.reddit_connection_secrets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reddit_connections enable row level security;
alter table public.reddit_connection_secrets enable row level security;

create policy "Users can read their Reddit connection"
on public.reddit_connections for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can update their Reddit connection metadata"
on public.reddit_connections for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

revoke all on table public.reddit_connections from anon, authenticated;
grant select, update on table public.reddit_connections to authenticated;
revoke all on table public.reddit_connection_secrets from anon, authenticated;

create trigger set_reddit_connections_updated_at
before update on public.reddit_connections
for each row execute function public.set_saved_items_updated_at();

create trigger set_reddit_connection_secrets_updated_at
before update on public.reddit_connection_secrets
for each row execute function public.set_saved_items_updated_at();

create function public.save_reddit_connection(
  p_user_id uuid,
  p_reddit_user_id text,
  p_reddit_username text,
  p_reddit_icon_url text,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_access_token_expires_at timestamptz
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

  if p_reddit_user_id is null or pg_catalog.btrim(p_reddit_user_id) = '' then
    raise exception 'p_reddit_user_id must not be blank' using errcode = '22023';
  end if;

  if p_reddit_username is null or pg_catalog.btrim(p_reddit_username) = '' then
    raise exception 'p_reddit_username must not be blank' using errcode = '22023';
  end if;

  if p_access_token_ciphertext is null
    or pg_catalog.btrim(p_access_token_ciphertext) = '' then
    raise exception 'p_access_token_ciphertext must not be blank'
      using errcode = '22023';
  end if;

  insert into public.reddit_connection_secrets (
    user_id,
    access_token_ciphertext,
    refresh_token_ciphertext,
    access_token_expires_at
  )
  values (
    p_user_id,
    p_access_token_ciphertext,
    p_refresh_token_ciphertext,
    p_access_token_expires_at
  )
  on conflict (user_id) do update
  set access_token_ciphertext = excluded.access_token_ciphertext,
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      access_token_expires_at = excluded.access_token_expires_at;

  insert into public.reddit_connections (
    user_id,
    reddit_user_id,
    reddit_username,
    reddit_icon_url,
    connection_status,
    sync_status
  )
  values (
    p_user_id,
    p_reddit_user_id,
    p_reddit_username,
    p_reddit_icon_url,
    'connected',
    'idle'
  )
  on conflict (user_id) do update
  set reddit_user_id = excluded.reddit_user_id,
      reddit_username = excluded.reddit_username,
      reddit_icon_url = excluded.reddit_icon_url,
      connection_status = excluded.connection_status,
      sync_status = excluded.sync_status;
end;
$$;

create function public.begin_reddit_sync(
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
    raise exception 'Reddit sync identifiers must not be null'
      using errcode = '22004';
  end if;

  update public.reddit_connections
  set sync_status = 'running',
      active_sync_id = p_sync_id,
      next_page = 1,
      next_cursor = null,
      discovered_count = 0,
      saved_count = 0,
      skipped_count = 0,
      sync_started_at = pg_catalog.clock_timestamp(),
      last_sync_error = null,
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

create function public.claim_reddit_sync_page(
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
    raise exception 'Reddit sync page identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'Reddit sync page must be positive'
      using errcode = '22023';
  end if;

  update public.reddit_connections
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

create function public.heartbeat_reddit_sync_page(
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
    raise exception 'Reddit sync page identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'Reddit sync page must be positive'
      using errcode = '22023';
  end if;

  update public.reddit_connections
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

create function public.apply_reddit_sync_page(
  p_user_id uuid,
  p_sync_id uuid,
  p_lease_id uuid,
  p_page integer,
  p_next_page integer,
  p_next_cursor text,
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
  connection_row public.reddit_connections%rowtype;
  item jsonb;
  expected_updated_at timestamptz;
  changed_count integer;
  inserted_count integer := 0;
  final_status text;
begin
  if p_user_id is null or p_sync_id is null or p_lease_id is null then
    raise exception 'Reddit sync page identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'Reddit sync page must be positive'
      using errcode = '22023';
  end if;
  if p_next_page is not null and p_next_page <> p_page + 1 then
    raise exception 'Reddit next page must advance by one'
      using errcode = '22023';
  end if;
  -- A running sync always carries the cursor for its next request, and a
  -- finished sync never carries one, so the two must appear together.
  if (p_next_page is null) <> (p_next_cursor is null) then
    raise exception 'Reddit next page and cursor must agree'
      using errcode = '22023';
  end if;
  if p_next_cursor is not null
    and (p_next_cursor = '' or pg_catalog.length(p_next_cursor) > 256) then
    raise exception 'Reddit next cursor is invalid'
      using errcode = '22023';
  end if;
  if p_discovered_count is null or p_discovered_count < 0
    or p_skipped_count is null or p_skipped_count < 0 then
    raise exception 'Reddit page counts must be non-negative'
      using errcode = '22023';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
    or pg_catalog.jsonb_array_length(p_items) > 100
    or pg_catalog.jsonb_array_length(p_items) + p_skipped_count
      <> p_discovered_count then
    raise exception 'Reddit page items do not match the page counts'
      using errcode = '22023';
  end if;

  select connection.*
  into connection_row
  from public.reddit_connections as connection
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
    select page_item.value
    from pg_catalog.jsonb_array_elements(p_items) as page_item(value)
  loop
    if item->>'user_id' is null
      or (item->>'user_id')::uuid <> p_user_id
      or item->>'normalized_url' is null
      or item->>'url' is null
      or item->>'source' is null
      or item->>'searchable_text' is null then
      raise exception 'Reddit page item is invalid'
        using errcode = '22023';
    end if;

    expected_updated_at := (item->>'expected_updated_at')::timestamptz;
    if expected_updated_at is null then
      insert into public.saved_items (
        user_id,
        url,
        normalized_url,
        source,
        title,
        description,
        notes,
        content,
        author,
        thumbnail_url,
        tags,
        metadata,
        searchable_text,
        embedding,
        indexing_status,
        indexing_error
      ) values (
        p_user_id,
        item->>'url',
        item->>'normalized_url',
        item->>'source',
        item->>'title',
        item->>'description',
        item->>'notes',
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
          when pg_catalog.jsonb_typeof(item->'embedding') = 'string'
            then (item->>'embedding')::extensions.vector
          else (item->'embedding')::text::extensions.vector
        end,
        item->>'indexing_status',
        item->>'indexing_error'
      )
      on conflict (user_id, normalized_url) do nothing;
      get diagnostics changed_count = row_count;
      inserted_count := inserted_count + changed_count;
    else
      update public.saved_items
      set url = item->>'url',
          source = item->>'source',
          title = item->>'title',
          description = item->>'description',
          notes = item->>'notes',
          content = item->>'content',
          author = item->>'author',
          thumbnail_url = item->>'thumbnail_url',
          tags = array(
            select tag.value
            from pg_catalog.jsonb_array_elements_text(
              coalesce(item->'tags', '[]'::jsonb)
            ) as tag(value)
          ),
          metadata = coalesce(item->'metadata', '{}'::jsonb),
          searchable_text = item->>'searchable_text',
          embedding = case
            when item->'embedding' is null
              or pg_catalog.jsonb_typeof(item->'embedding') = 'null' then null
            when pg_catalog.jsonb_typeof(item->'embedding') = 'string'
              then (item->>'embedding')::extensions.vector
            else (item->'embedding')::text::extensions.vector
          end,
          indexing_status = item->>'indexing_status',
          indexing_error = item->>'indexing_error'
      where user_id = p_user_id
        and normalized_url = item->>'normalized_url'
        and updated_at = expected_updated_at;
    end if;
  end loop;

  final_status := case when p_next_page is null then 'complete' else 'running' end;
  update public.reddit_connections
  set discovered_count = discovered_count + p_discovered_count,
      saved_count = saved_count + inserted_count,
      skipped_count = skipped_count + p_skipped_count,
      next_page = coalesce(p_next_page, next_page),
      next_cursor = p_next_cursor,
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
    and connection_status = 'connected'
    and sync_status = 'running'
    and active_sync_id = p_sync_id
    and next_page = p_page
    and page_lease_id = p_lease_id
  returning * into connection_row;

  if not found then
    raise exception 'Reddit page lease changed during apply'
      using errcode = '40001';
  end if;

  return pg_catalog.jsonb_build_object(
    'status', final_status,
    'next_page', p_next_page,
    'next_cursor', p_next_cursor,
    'discovered_count', connection_row.discovered_count,
    'saved_count', connection_row.saved_count,
    'skipped_count', connection_row.skipped_count
  );
end;
$$;

create function public.fail_reddit_sync_page(
  p_user_id uuid,
  p_sync_id uuid,
  p_page integer,
  p_lease_id uuid,
  p_error text,
  p_reconnect_required boolean
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
    raise exception 'Reddit sync identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'Reddit sync page must be positive'
      using errcode = '22023';
  end if;
  if p_error is null or p_error = '' or pg_catalog.length(p_error) > 200
    or p_reconnect_required is null then
    raise exception 'Reddit sync failure metadata is invalid'
      using errcode = '22023';
  end if;

  update public.reddit_connections
  set connection_status = case
        when p_reconnect_required then 'reconnect_required'
        else connection_status
      end,
      sync_status = 'failed',
      active_sync_id = null,
      page_lease_id = null,
      page_lease_started_at = null,
      sync_started_at = pg_catalog.clock_timestamp(),
      last_sync_error = p_error,
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

revoke all on function public.save_reddit_connection(
  uuid, text, text, text, text, text, timestamptz
)
from public, anon, authenticated;
grant execute on function public.save_reddit_connection(
  uuid, text, text, text, text, text, timestamptz
)
to service_role;

revoke all on function public.begin_reddit_sync(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.begin_reddit_sync(uuid, uuid) to service_role;

revoke all on function public.claim_reddit_sync_page(uuid, uuid, integer, uuid)
from public, anon, authenticated;
grant execute on function public.claim_reddit_sync_page(uuid, uuid, integer, uuid)
to service_role;

revoke all on function public.heartbeat_reddit_sync_page(uuid, uuid, integer, uuid)
from public, anon, authenticated;
grant execute on function public.heartbeat_reddit_sync_page(
  uuid, uuid, integer, uuid
)
to service_role;

revoke all on function public.apply_reddit_sync_page(
  uuid, uuid, uuid, integer, integer, text, integer, integer, jsonb
)
from public, anon, authenticated;
grant execute on function public.apply_reddit_sync_page(
  uuid, uuid, uuid, integer, integer, text, integer, integer, jsonb
)
to service_role;

revoke all on function public.fail_reddit_sync_page(
  uuid, uuid, integer, uuid, text, boolean
)
from public, anon, authenticated;
grant execute on function public.fail_reddit_sync_page(
  uuid, uuid, integer, uuid, text, boolean
)
to service_role;
