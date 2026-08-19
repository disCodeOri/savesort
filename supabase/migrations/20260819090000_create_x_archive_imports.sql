-- X historical archive import.
--
-- A second, independent ingestion path alongside the live X API sync. The two
-- meet only at the normalized content layer: this importer never calls the X
-- API, and the API sync never knows the archive exists.
--
-- Content identity is `x + post_id`, resolved to the canonical permalink that
-- saved_items already keys on. A post that arrives from both the archive and
-- the API therefore collapses onto one saved_items row automatically, with
-- provenance recorded for each source.
--
-- x_post_relationships is the content/relationship split: one post can be
-- simultaneously bookmarked, liked and reposted without duplicating content.

create table public.x_archive_imports (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'uploading'
    check (status in (
      'uploading', 'validating', 'processing', 'classifying',
      'completed', 'completed_with_warnings', 'failed', 'cancelled'
    )),
  -- Coarse stage for the progress UI. Percentages are deliberately avoided
  -- because total work is unknown until the archive has been inventoried.
  stage text not null default 'waiting',
  archive_name text,
  archive_size_bytes bigint check (archive_size_bytes >= 0),
  -- Identity of the X account the archive belongs to, when the archive says.
  archive_x_user_id text,
  archive_username text,

  files_detected integer not null default 0 check (files_detected >= 0),
  files_processed integer not null default 0 check (files_processed >= 0),
  files_skipped integer not null default 0 check (files_skipped >= 0),

  records_discovered integer not null default 0 check (records_discovered >= 0),
  records_processed integer not null default 0 check (records_processed >= 0),
  content_created integer not null default 0 check (content_created >= 0),
  content_updated integer not null default 0 check (content_updated >= 0),
  relationships_created integer not null default 0 check (relationships_created >= 0),
  duplicates_merged integer not null default 0 check (duplicates_merged >= 0),

  classification_completed integer not null default 0,
  classification_skipped integer not null default 0,
  embedding_completed integer not null default 0,
  embedding_skipped integer not null default 0,

  -- Per-file problems, never raw archive content.
  warnings jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,

  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index x_archive_imports_user_idx
  on public.x_archive_imports (user_id, started_at desc);

comment on table public.x_archive_imports is
  'One uploaded X archive import: job state, progress and audit counts.';

create table public.x_post_relationships (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id text not null check (pg_catalog.length(post_id) <= 32),
  -- What the user did with the post. Kept distinct rather than flattened to
  -- "saved" because the interest signal differs per action.
  relationship_type text not null check (relationship_type in (
    'bookmark', 'like', 'own_post', 'repost', 'reply', 'quote_post'
  )),
  saved_item_id uuid references public.saved_items(id) on delete set null,
  -- Only set when the archive genuinely supplies it. Never derived from the
  -- post's creation time, which means something entirely different.
  relationship_timestamp timestamptz,
  first_seen_at timestamptz not null default now(),
  import_method text not null default 'x_archive'
    check (import_method in ('x_archive', 'x_api')),
  import_id uuid references public.x_archive_imports(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, post_id, relationship_type)
);

create index x_post_relationships_import_idx
  on public.x_post_relationships (import_id);
create index x_post_relationships_item_idx
  on public.x_post_relationships (saved_item_id);

comment on table public.x_post_relationships is
  'What a user did with an X post. One post may carry several relationships.';

-- How much of the post the archive actually gave us. Drives whether the item
-- is eligible for classification and embedding at all.
alter table public.x_bookmarks
  add column content_availability text not null default 'full'
    check (content_availability in ('full', 'partial', 'reference_only'));

alter table public.x_archive_imports enable row level security;
alter table public.x_post_relationships enable row level security;

create policy "Users can read their X archive imports"
on public.x_archive_imports for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can read their X post relationships"
on public.x_post_relationships for select to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.x_archive_imports from anon, authenticated;
revoke all on table public.x_post_relationships from anon, authenticated;

grant select on table public.x_archive_imports to authenticated;
grant select on table public.x_post_relationships to authenticated;

create trigger set_x_archive_imports_updated_at
before update on public.x_archive_imports
for each row execute function public.set_saved_items_updated_at();

create trigger set_x_post_relationships_updated_at
before update on public.x_post_relationships
for each row execute function public.set_saved_items_updated_at();

create function public.begin_x_archive_import(
  p_user_id uuid,
  p_archive_name text,
  p_archive_size_bytes bigint,
  p_files_detected integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  import_id uuid;
begin
  if p_user_id is null then
    raise exception 'p_user_id must not be null' using errcode = '22004';
  end if;

  -- One active import per user at a time. A second upload cannot race the
  -- first into a half-merged state.
  update public.x_archive_imports
  set status = 'cancelled',
      stage = 'superseded',
      completed_at = pg_catalog.clock_timestamp()
  where user_id = p_user_id
    and status in ('uploading', 'validating', 'processing', 'classifying');

  insert into public.x_archive_imports (
    user_id, status, stage, archive_name, archive_size_bytes, files_detected
  ) values (
    p_user_id, 'processing', 'analyzing',
    p_archive_name, p_archive_size_bytes, coalesce(p_files_detected, 0)
  )
  returning id into import_id;

  return import_id;
end;
$$;

-- Applies one batch of normalized archive records.
--
-- Idempotent by construction: content is upserted on (user_id, normalized_url)
-- and relationships on their primary key, so re-uploading the same archive
-- updates rather than duplicates.
create function public.apply_x_archive_batch(
  p_user_id uuid,
  p_import_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  relationship jsonb;
  item_id uuid;
  existing_item public.saved_items%rowtype;
  created_count integer := 0;
  updated_count integer := 0;
  merged_count integer := 0;
  relationships_count integer := 0;
  availability text;
begin
  if p_user_id is null or p_import_id is null then
    raise exception 'Archive batch identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
    or pg_catalog.jsonb_array_length(p_items) > 500 then
    raise exception 'Archive batch is invalid' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.x_archive_imports
    where id = p_import_id and user_id = p_user_id
      and status in ('processing', 'classifying')
  ) then
    raise exception 'Archive import is not active' using errcode = '42501';
  end if;

  for item in
    select value from pg_catalog.jsonb_array_elements(p_items) as entry(value)
  loop
    if item->>'post_id' is null or item->>'normalized_url' is null then
      raise exception 'Archive item is invalid' using errcode = '22023';
    end if;
    availability := coalesce(item->>'content_availability', 'reference_only');

    select * into existing_item
    from public.saved_items
    where user_id = p_user_id and normalized_url = item->>'normalized_url';

    if not found then
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
        '{}',
        coalesce(item->'metadata', '{}'::jsonb),
        coalesce(item->>'searchable_text', ''),
        case
          when item->'embedding' is null
            or pg_catalog.jsonb_typeof(item->'embedding') = 'null' then null
          else (item->>'embedding')::extensions.vector
        end,
        coalesce(item->>'indexing_status', 'pending'),
        item->>'indexing_error'
      )
      returning id into item_id;
      created_count := created_count + 1;
    else
      item_id := existing_item.id;
      -- Never downgrade. An API-sourced full post keeps its text when the
      -- archive only knows the id, and user notes/tags are never touched.
      update public.saved_items
      set title = coalesce(
            nullif(item->>'title', ''), public.saved_items.title),
          description = coalesce(
            nullif(item->>'description', ''), public.saved_items.description),
          content = case
            when public.saved_items.content is not null
              and pg_catalog.length(public.saved_items.content)
                >= pg_catalog.length(coalesce(item->>'content', ''))
            then public.saved_items.content
            else coalesce(nullif(item->>'content', ''), public.saved_items.content)
          end,
          author = coalesce(
            nullif(item->>'author', ''), public.saved_items.author),
          thumbnail_url = coalesce(
            nullif(item->>'thumbnail_url', ''), public.saved_items.thumbnail_url),
          metadata = public.saved_items.metadata
            || coalesce(item->'metadata', '{}'::jsonb),
          searchable_text = case
            when pg_catalog.length(coalesce(item->>'searchable_text', ''))
              > pg_catalog.length(coalesce(public.saved_items.searchable_text, ''))
            then item->>'searchable_text'
            else public.saved_items.searchable_text
          end,
          -- An existing embedding is never discarded; re-embedding an item the
          -- API already processed would be duplicated AI spend.
          embedding = coalesce(public.saved_items.embedding, case
            when item->'embedding' is null
              or pg_catalog.jsonb_typeof(item->'embedding') = 'null' then null
            else (item->>'embedding')::extensions.vector
          end),
          indexing_status = case
            when public.saved_items.indexing_status = 'ready' then 'ready'
            else coalesce(item->>'indexing_status', public.saved_items.indexing_status)
          end
      where id = item_id;
      updated_count := updated_count + 1;
      merged_count := merged_count + 1;
    end if;

    -- The bookmark table is shared with the API sync, so record availability
    -- without claiming the post is currently bookmarked on X.
    if availability <> 'full' then
      insert into public.x_bookmarks (
        user_id, post_id, saved_item_id, active, content_availability
      ) values (
        p_user_id, item->>'post_id', item_id, false, availability
      )
      on conflict (user_id, post_id) do update
      set saved_item_id = coalesce(
            public.x_bookmarks.saved_item_id, excluded.saved_item_id),
          content_availability = excluded.content_availability;
    end if;

    for relationship in
      select value from pg_catalog.jsonb_array_elements(
        coalesce(item->'relationships', '[]'::jsonb)
      ) as entry(value)
    loop
      insert into public.x_post_relationships (
        user_id, post_id, relationship_type, saved_item_id,
        relationship_timestamp, import_method, import_id
      ) values (
        p_user_id,
        item->>'post_id',
        relationship->>'type',
        item_id,
        (relationship->>'timestamp')::timestamptz,
        'x_archive',
        p_import_id
      )
      on conflict (user_id, post_id, relationship_type) do update
      set saved_item_id = coalesce(
            public.x_post_relationships.saved_item_id, excluded.saved_item_id),
          -- first_seen_at is preserved; a re-import must not reset history.
          relationship_timestamp = coalesce(
            public.x_post_relationships.relationship_timestamp,
            excluded.relationship_timestamp),
          import_id = coalesce(
            public.x_post_relationships.import_id, excluded.import_id);
      relationships_count := relationships_count + 1;
    end loop;
  end loop;

  update public.x_archive_imports
  set records_processed = records_processed + pg_catalog.jsonb_array_length(p_items),
      content_created = content_created + created_count,
      content_updated = content_updated + updated_count,
      relationships_created = relationships_created + relationships_count,
      duplicates_merged = duplicates_merged + merged_count,
      updated_at = pg_catalog.now()
  where id = p_import_id and user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'created', created_count,
    'updated', updated_count,
    'relationships', relationships_count
  );
end;
$$;

create function public.complete_x_archive_import(
  p_user_id uuid,
  p_import_id uuid,
  p_status text,
  p_stage text,
  p_files_processed integer,
  p_files_skipped integer,
  p_records_discovered integer,
  p_warnings jsonb,
  p_errors jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in (
    'completed', 'completed_with_warnings', 'failed', 'cancelled'
  ) then
    raise exception 'Invalid import status' using errcode = '22023';
  end if;

  update public.x_archive_imports
  set status = p_status,
      stage = coalesce(p_stage, 'done'),
      files_processed = coalesce(p_files_processed, files_processed),
      files_skipped = coalesce(p_files_skipped, files_skipped),
      records_discovered = coalesce(p_records_discovered, records_discovered),
      warnings = coalesce(p_warnings, warnings),
      errors = coalesce(p_errors, errors),
      completed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.now()
  where id = p_import_id and user_id = p_user_id;
end;
$$;

-- Reverts one import by removing only the relationships it created.
--
-- Content is deliberately garbage-collected only when nothing else refers to
-- it: a post that also arrived through the X API, or through another import,
-- survives. User notes and tags on a surviving item are never touched.
create function public.revert_x_archive_import(
  p_user_id uuid,
  p_import_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed_relationships integer;
  removed_items integer;
begin
  if p_user_id is null or p_import_id is null then
    raise exception 'Revert identifiers must not be null' using errcode = '22004';
  end if;

  with deleted as (
    delete from public.x_post_relationships
    where user_id = p_user_id and import_id = p_import_id
    returning saved_item_id
  )
  select pg_catalog.count(*) into removed_relationships from deleted;

  with orphaned as (
    delete from public.saved_items as item
    where item.user_id = p_user_id
      and item.source = 'x'
      -- Only items with no surviving relationship, no bookmark row, and
      -- nothing the user added themselves.
      and not exists (
        select 1 from public.x_post_relationships as rel
        where rel.saved_item_id = item.id
      )
      and not exists (
        select 1 from public.x_bookmarks as bookmark
        where bookmark.saved_item_id = item.id and bookmark.active = true
      )
      and coalesce(item.notes, '') = ''
      and pg_catalog.array_length(item.tags, 1) is null
    returning item.id
  )
  select pg_catalog.count(*) into removed_items from orphaned;

  update public.x_archive_imports
  set status = 'cancelled',
      stage = 'reverted',
      completed_at = pg_catalog.clock_timestamp()
  where id = p_import_id and user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'relationships_removed', removed_relationships,
    'items_removed', removed_items
  );
end;
$$;

revoke all on function public.begin_x_archive_import(uuid, text, bigint, integer)
from public, anon, authenticated;
grant execute on function public.begin_x_archive_import(uuid, text, bigint, integer)
to service_role;

revoke all on function public.apply_x_archive_batch(uuid, uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.apply_x_archive_batch(uuid, uuid, jsonb)
to service_role;

revoke all on function public.complete_x_archive_import(
  uuid, uuid, text, text, integer, integer, integer, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_x_archive_import(
  uuid, uuid, text, text, integer, integer, integer, jsonb, jsonb
) to service_role;

revoke all on function public.revert_x_archive_import(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.revert_x_archive_import(uuid, uuid)
to service_role;
