-- YouTube playlist sync.
--
-- Two-stage pipeline. Stage one imports official playlist metadata quickly so
-- videos appear in the library right away. Stage two enriches each video with
-- a Gemini analysis of the public video URL, which is slow and can fail, so it
-- runs separately and never blocks the import.
--
-- Sync state walks a snapshot of the selected playlists taken at sync start
-- (sync_playlist_queue), so changing the selection mid-run cannot corrupt an
-- in-flight sync.

create table public.youtube_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  google_user_id text not null check (
    pg_catalog.btrim(google_user_id) <> '' and pg_catalog.length(google_user_id) <= 128
  ),
  channel_id text,
  channel_title text,
  channel_thumbnail_url text,
  connection_status text not null default 'connected'
    check (connection_status in ('connected', 'reconnect_required')),
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'running', 'failed')),
  active_sync_id uuid,
  next_page integer not null default 1 check (next_page > 0),
  -- Remaining playlists for the active sync; the first element is the one
  -- currently being paged through.
  sync_playlist_queue text[] not null default '{}',
  next_page_token text check (next_page_token <> '' and length(next_page_token) <= 512),
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
  constraint youtube_connections_page_lease_pair check (
    (page_lease_id is null and page_lease_started_at is null)
    or (page_lease_id is not null and page_lease_started_at is not null)
  ),
  unique (google_user_id)
);

comment on column public.youtube_connections.sync_playlist_queue is
  'Snapshot of selected playlists for the active sync; head is the playlist currently paging.';

create table public.youtube_connection_secrets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.youtube_playlists (
  user_id uuid not null references auth.users(id) on delete cascade,
  playlist_id text not null check (pg_catalog.length(playlist_id) <= 128),
  title text not null default '',
  item_count integer not null default 0 check (item_count >= 0),
  thumbnail_url text,
  selected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, playlist_id)
);

comment on table public.youtube_playlists is
  'Playlists discovered for the connected channel, with the user''s sync selection.';

create table public.youtube_videos (
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null check (pg_catalog.length(video_id) <= 32),
  saved_item_id uuid references public.saved_items(id) on delete set null,
  playlist_id text,
  -- 'pending' means imported but not yet analysed. Enrichment only ever picks
  -- up pending rows, which is what stops a re-sync from re-analysing videos.
  enrichment_status text not null default 'pending'
    check (enrichment_status in ('pending', 'ready', 'failed', 'unsupported')),
  enrichment_error text,
  enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

create index youtube_videos_pending_idx
  on public.youtube_videos (user_id, enrichment_status)
  where enrichment_status = 'pending';

alter table public.youtube_connections enable row level security;
alter table public.youtube_connection_secrets enable row level security;
alter table public.youtube_playlists enable row level security;
alter table public.youtube_videos enable row level security;

create policy "Users can read their YouTube connection"
on public.youtube_connections for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can update their YouTube connection metadata"
on public.youtube_connections for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can read their YouTube playlists"
on public.youtube_playlists for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can read their YouTube videos"
on public.youtube_videos for select to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.youtube_connections from anon, authenticated;
revoke all on table public.youtube_connection_secrets from anon, authenticated;
revoke all on table public.youtube_playlists from anon, authenticated;
revoke all on table public.youtube_videos from anon, authenticated;

grant select, update on table public.youtube_connections to authenticated;
grant select on table public.youtube_playlists to authenticated;
grant select on table public.youtube_videos to authenticated;

create trigger set_youtube_connections_updated_at
before update on public.youtube_connections
for each row execute function public.set_saved_items_updated_at();

create trigger set_youtube_connection_secrets_updated_at
before update on public.youtube_connection_secrets
for each row execute function public.set_saved_items_updated_at();

create trigger set_youtube_playlists_updated_at
before update on public.youtube_playlists
for each row execute function public.set_saved_items_updated_at();

create trigger set_youtube_videos_updated_at
before update on public.youtube_videos
for each row execute function public.set_saved_items_updated_at();

create function public.save_youtube_connection(
  p_user_id uuid,
  p_google_user_id text,
  p_channel_id text,
  p_channel_title text,
  p_channel_thumbnail_url text,
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
  if p_google_user_id is null or pg_catalog.btrim(p_google_user_id) = '' then
    raise exception 'p_google_user_id must not be blank' using errcode = '22023';
  end if;
  if p_access_token_ciphertext is null
    or pg_catalog.btrim(p_access_token_ciphertext) = '' then
    raise exception 'p_access_token_ciphertext must not be blank'
      using errcode = '22023';
  end if;

  insert into public.youtube_connection_secrets (
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
      -- Google only returns a refresh token on the first consent, so keep the
      -- stored one when a later exchange omits it.
      refresh_token_ciphertext = coalesce(
        excluded.refresh_token_ciphertext,
        public.youtube_connection_secrets.refresh_token_ciphertext
      ),
      access_token_expires_at = excluded.access_token_expires_at;

  insert into public.youtube_connections (
    user_id,
    google_user_id,
    channel_id,
    channel_title,
    channel_thumbnail_url,
    connection_status,
    sync_status
  )
  values (
    p_user_id,
    p_google_user_id,
    p_channel_id,
    p_channel_title,
    p_channel_thumbnail_url,
    'connected',
    'idle'
  )
  on conflict (user_id) do update
  set google_user_id = excluded.google_user_id,
      channel_id = excluded.channel_id,
      channel_title = excluded.channel_title,
      channel_thumbnail_url = excluded.channel_thumbnail_url,
      connection_status = excluded.connection_status;
end;
$$;

-- Refreshes the discovered playlist list while preserving which ones the user
-- had already selected.
create function public.replace_youtube_playlists(
  p_user_id uuid,
  p_playlists jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  playlist jsonb;
  seen_ids text[] := '{}';
begin
  if p_user_id is null or p_playlists is null
    or pg_catalog.jsonb_typeof(p_playlists) <> 'array' then
    raise exception 'Playlist payload is invalid' using errcode = '22023';
  end if;

  for playlist in
    select value from pg_catalog.jsonb_array_elements(p_playlists) as entry(value)
  loop
    if playlist->>'playlistId' is null then
      raise exception 'Playlist id must not be null' using errcode = '22023';
    end if;
    seen_ids := seen_ids || (playlist->>'playlistId');

    insert into public.youtube_playlists (
      user_id, playlist_id, title, item_count, thumbnail_url
    ) values (
      p_user_id,
      playlist->>'playlistId',
      coalesce(playlist->>'title', ''),
      coalesce((playlist->>'itemCount')::integer, 0),
      playlist->>'thumbnailUrl'
    )
    on conflict (user_id, playlist_id) do update
    set title = excluded.title,
        item_count = excluded.item_count,
        thumbnail_url = excluded.thumbnail_url;
  end loop;

  delete from public.youtube_playlists
  where user_id = p_user_id
    and not (playlist_id = any(seen_ids));
end;
$$;

create function public.set_youtube_playlist_selection(
  p_user_id uuid,
  p_playlist_ids text[]
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

  update public.youtube_playlists
  set selected = (playlist_id = any(coalesce(p_playlist_ids, '{}')))
  where user_id = p_user_id;
end;
$$;

create function public.begin_youtube_sync(
  p_user_id uuid,
  p_sync_id uuid,
  p_playlist_queue text[]
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
    raise exception 'YouTube sync identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_playlist_queue is null or pg_catalog.array_length(p_playlist_queue, 1) is null then
    raise exception 'At least one playlist must be selected' using errcode = '22023';
  end if;

  update public.youtube_connections
  set sync_status = 'running',
      active_sync_id = p_sync_id,
      next_page = 1,
      sync_playlist_queue = p_playlist_queue,
      next_page_token = null,
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

create function public.claim_youtube_sync_page(
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
    raise exception 'YouTube sync page identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'YouTube sync page must be positive' using errcode = '22023';
  end if;

  update public.youtube_connections
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

create function public.heartbeat_youtube_sync_page(
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
    raise exception 'YouTube sync page identifiers must not be null'
      using errcode = '22004';
  end if;

  update public.youtube_connections
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

-- Persists one page of videos and advances the sync cursor. The caller decides
-- the next queue/token; this validates and applies atomically alongside the
-- item writes so a crash cannot leave progress ahead of the data.
create function public.apply_youtube_sync_page(
  p_user_id uuid,
  p_sync_id uuid,
  p_lease_id uuid,
  p_page integer,
  p_next_page integer,
  p_next_playlist_queue text[],
  p_next_page_token text,
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
  connection_row public.youtube_connections%rowtype;
  item jsonb;
  item_id uuid;
  changed_count integer;
  inserted_count integer := 0;
  final_status text;
begin
  if p_user_id is null or p_sync_id is null or p_lease_id is null then
    raise exception 'YouTube sync page identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'YouTube sync page must be positive' using errcode = '22023';
  end if;
  if p_next_page is not null and p_next_page <> p_page + 1 then
    raise exception 'YouTube next page must advance by one' using errcode = '22023';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
    or pg_catalog.jsonb_array_length(p_items) > 50
    or pg_catalog.jsonb_array_length(p_items) + p_skipped_count <> p_discovered_count then
    raise exception 'YouTube page items do not match the page counts'
      using errcode = '22023';
  end if;

  select connection.* into connection_row
  from public.youtube_connections as connection
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
      or item->>'normalized_url' is null
      or item->>'video_id' is null
      or item->>'searchable_text' is null then
      raise exception 'YouTube page item is invalid' using errcode = '22023';
    end if;

    insert into public.saved_items (
      user_id, url, normalized_url, source, title, description, content,
      author, thumbnail_url, tags, metadata, searchable_text, embedding,
      indexing_status, indexing_error
    ) values (
      p_user_id,
      item->>'url',
      item->>'normalized_url',
      'youtube',
      item->>'title',
      item->>'description',
      item->>'content',
      item->>'author',
      item->>'thumbnail_url',
      array(
        select tag.value
        from pg_catalog.jsonb_array_elements_text(coalesce(item->'tags', '[]'::jsonb)) as tag(value)
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
    -- Refresh only what YouTube owns. Notes and user tags are never touched
    -- here, and content is left alone so a re-sync cannot wipe a Gemini
    -- analysis that enrichment already wrote.
    set title = excluded.title,
        description = excluded.description,
        author = excluded.author,
        thumbnail_url = excluded.thumbnail_url,
        metadata = public.saved_items.metadata || excluded.metadata
    returning id into item_id;

    get diagnostics changed_count = row_count;
    if not exists (
      select 1 from public.youtube_videos
      where user_id = p_user_id and video_id = item->>'video_id'
    ) then
      inserted_count := inserted_count + 1;
    end if;

    insert into public.youtube_videos (
      user_id, video_id, saved_item_id, playlist_id
    ) values (
      p_user_id,
      item->>'video_id',
      item_id,
      item->>'playlist_id'
    )
    on conflict (user_id, video_id) do update
    set saved_item_id = excluded.saved_item_id,
        playlist_id = excluded.playlist_id;
  end loop;

  final_status := case when p_next_page is null then 'complete' else 'running' end;
  update public.youtube_connections
  set discovered_count = discovered_count + p_discovered_count,
      saved_count = saved_count + inserted_count,
      skipped_count = skipped_count + p_skipped_count,
      next_page = coalesce(p_next_page, next_page),
      sync_playlist_queue = coalesce(p_next_playlist_queue, '{}'),
      next_page_token = p_next_page_token,
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
    raise exception 'YouTube page lease changed during apply' using errcode = '40001';
  end if;

  return pg_catalog.jsonb_build_object(
    'status', final_status,
    'next_page', p_next_page,
    'discovered_count', connection_row.discovered_count,
    'saved_count', connection_row.saved_count,
    'skipped_count', connection_row.skipped_count
  );
end;
$$;

create function public.fail_youtube_sync_page(
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
    raise exception 'YouTube sync identifiers must not be null' using errcode = '22004';
  end if;
  if p_error is null or p_error = '' or pg_catalog.length(p_error) > 200
    or p_reconnect_required is null then
    raise exception 'YouTube sync failure metadata is invalid' using errcode = '22023';
  end if;

  update public.youtube_connections
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

-- Writes one video's Gemini analysis. Only ever moves a row off 'pending', so
-- a repeated enrichment run cannot re-analyse or double-charge for a video.
create function public.apply_youtube_enrichment(
  p_user_id uuid,
  p_video_id text,
  p_content text,
  p_searchable_text text,
  p_embedding text,
  p_indexing_status text,
  p_status text,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  video_row public.youtube_videos%rowtype;
begin
  if p_user_id is null or p_video_id is null then
    raise exception 'Enrichment identifiers must not be null' using errcode = '22004';
  end if;
  if p_status not in ('ready', 'failed', 'unsupported') then
    raise exception 'Invalid enrichment status' using errcode = '22023';
  end if;

  select * into video_row
  from public.youtube_videos
  where user_id = p_user_id and video_id = p_video_id
  for update;

  if not found then
    return false;
  end if;

  if p_status = 'ready' and video_row.saved_item_id is not null then
    update public.saved_items
    set content = p_content,
        searchable_text = p_searchable_text,
        embedding = case
          when p_embedding is null then embedding
          else p_embedding::extensions.vector
        end,
        indexing_status = coalesce(p_indexing_status, indexing_status)
    where id = video_row.saved_item_id and user_id = p_user_id;
  end if;

  update public.youtube_videos
  set enrichment_status = p_status,
      enrichment_error = p_error,
      enriched_at = pg_catalog.clock_timestamp()
  where user_id = p_user_id and video_id = p_video_id;

  return true;
end;
$$;

revoke all on function public.save_youtube_connection(
  uuid, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.save_youtube_connection(
  uuid, text, text, text, text, text, text, timestamptz
) to service_role;

revoke all on function public.replace_youtube_playlists(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.replace_youtube_playlists(uuid, jsonb) to service_role;

revoke all on function public.set_youtube_playlist_selection(uuid, text[])
from public, anon, authenticated;
grant execute on function public.set_youtube_playlist_selection(uuid, text[]) to service_role;

revoke all on function public.begin_youtube_sync(uuid, uuid, text[])
from public, anon, authenticated;
grant execute on function public.begin_youtube_sync(uuid, uuid, text[]) to service_role;

revoke all on function public.claim_youtube_sync_page(uuid, uuid, integer, uuid)
from public, anon, authenticated;
grant execute on function public.claim_youtube_sync_page(uuid, uuid, integer, uuid) to service_role;

revoke all on function public.heartbeat_youtube_sync_page(uuid, uuid, integer, uuid)
from public, anon, authenticated;
grant execute on function public.heartbeat_youtube_sync_page(uuid, uuid, integer, uuid) to service_role;

revoke all on function public.apply_youtube_sync_page(
  uuid, uuid, uuid, integer, integer, text[], text, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_youtube_sync_page(
  uuid, uuid, uuid, integer, integer, text[], text, integer, integer, jsonb
) to service_role;

revoke all on function public.fail_youtube_sync_page(
  uuid, uuid, integer, uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.fail_youtube_sync_page(
  uuid, uuid, integer, uuid, text, boolean
) to service_role;

revoke all on function public.apply_youtube_enrichment(
  uuid, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.apply_youtube_enrichment(
  uuid, text, text, text, text, text, text, text
) to service_role;
