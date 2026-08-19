-- Reddit and LinkedIn historical account-data export import.
--
-- A third ingestion path, alongside the live provider syncs. It never calls a
-- platform API and never fetches a platform page: everything it knows comes
-- from a file the user downloaded from the platform themselves.
--
-- Content still lives in saved_items. This migration adds only the things
-- saved_items cannot express:
--
--   data_imports         one upload: job state, progress, audit counts
--   data_import_records  platform identity -> saved_item, plus per-record
--                        provenance and classification state
--
-- data_import_records is what makes identity survive schema drift. A Reddit
-- post keyed `reddit:t3_abc123` resolves to the same saved_items row whether
-- its permalink arrived with a subreddit and slug or without, and whether it
-- was first seen through the Reddit OAuth sync or through an export.

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
      'linkedin',
      'website',
      'other',
      'obsidian'
    )
  );

create table public.data_imports (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('reddit', 'linkedin')),
  status text not null default 'processing'
    check (status in (
      'processing', 'classifying', 'completed',
      'completed_with_warnings', 'failed', 'cancelled'
    )),
  -- Coarse stage for the progress UI. Percentages are avoided because the
  -- total is unknown until the export has been inventoried.
  stage text not null default 'analyzing'
    check (pg_catalog.length(stage) <= 40),
  -- SHA-256 of the uploaded file, so a repeat upload is recognisable. The
  -- archive itself is never stored anywhere.
  file_hash text check (file_hash is null or pg_catalog.length(file_hash) = 64),
  safe_filename text check (
    safe_filename is null or pg_catalog.length(safe_filename) <= 255
  ),
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  parser_version text not null default 'v1',

  -- Which categories the user chose to import, e.g. ["reddit_saved_post"].
  selected_categories jsonb not null default '[]'::jsonb,
  -- Per-category counts found during analysis, for the report.
  detected_categories jsonb not null default '{}'::jsonb,

  items_detected integer not null default 0 check (items_detected >= 0),
  items_selected integer not null default 0 check (items_selected >= 0),
  items_created integer not null default 0 check (items_created >= 0),
  items_updated integer not null default 0 check (items_updated >= 0),
  items_duplicated integer not null default 0 check (items_duplicated >= 0),
  items_unresolved integer not null default 0 check (items_unresolved >= 0),

  full_count integer not null default 0 check (full_count >= 0),
  partial_count integer not null default 0 check (partial_count >= 0),
  reference_only_count integer not null default 0 check (reference_only_count >= 0),

  classification_ready_count integer not null default 0,
  classification_insufficient_count integer not null default 0,
  classification_failed_count integer not null default 0,
  embedding_completed integer not null default 0,

  files_detected integer not null default 0 check (files_detected >= 0),
  files_processed integer not null default 0 check (files_processed >= 0),
  files_skipped integer not null default 0 check (files_skipped >= 0),

  -- Per-file problems only. Never raw export content, never a stack trace.
  warnings jsonb not null default '[]'::jsonb,
  safe_error text check (safe_error is null or pg_catalog.length(safe_error) <= 500),

  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index data_imports_user_idx
  on public.data_imports (user_id, started_at desc);

comment on table public.data_imports is
  'One uploaded Reddit or LinkedIn data export: job state, progress and audit counts.';
comment on column public.data_imports.file_hash is
  'SHA-256 of the uploaded file, used only to recognise a repeat upload. The archive is never stored.';

create table public.data_import_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('reddit', 'linkedin')),
  -- Strongest identity the export supplied: platform content id, else a
  -- normalized canonical URL. This, not the URL alone, is what makes repeat
  -- imports idempotent when a permalink is written two different ways.
  content_key text not null check (
    pg_catalog.btrim(content_key) <> '' and pg_catalog.length(content_key) <= 400
  ),
  saved_item_id uuid references public.saved_items(id) on delete cascade,

  -- What the user did with it, e.g. ["reddit_saved_post","reddit_upvoted_post"].
  categories jsonb not null default '[]'::jsonb,
  content_availability text not null default 'reference_only'
    check (content_availability in ('full', 'partial', 'reference_only')),
  classification_status text not null default 'pending'
    check (classification_status in (
      'pending', 'ready', 'insufficient_content', 'failed'
    )),
  classification_error text check (
    classification_error is null or pg_catalog.length(classification_error) <= 300
  ),

  import_method text not null
    check (import_method in ('reddit_export', 'linkedin_export')),
  import_id uuid references public.data_imports(id) on delete set null,
  -- Which files in the export contributed. Names only, never contents.
  source_files jsonb not null default '[]'::jsonb,

  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, platform, content_key)
);

create index data_import_records_import_idx
  on public.data_import_records (import_id);
create index data_import_records_item_idx
  on public.data_import_records (saved_item_id);
-- Drives the classification pass: the pending queue for one import.
create index data_import_records_pending_idx
  on public.data_import_records (user_id, import_id, classification_status)
  where classification_status = 'pending';

comment on table public.data_import_records is
  'Platform identity -> saved_item mapping and provenance for one imported record.';

alter table public.data_imports enable row level security;
alter table public.data_import_records enable row level security;

create policy "Users can read their data imports"
on public.data_imports for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can read their data import records"
on public.data_import_records for select to authenticated
using ((select auth.uid()) = user_id);

-- Writes happen only through the security-definer RPCs below, which the
-- service role calls after the route has authenticated the user.
revoke all on table public.data_imports from anon, authenticated;
revoke all on table public.data_import_records from anon, authenticated;

grant select on table public.data_imports to authenticated;
grant select on table public.data_import_records to authenticated;

create trigger set_data_imports_updated_at
before update on public.data_imports
for each row execute function public.set_saved_items_updated_at();

create trigger set_data_import_records_updated_at
before update on public.data_import_records
for each row execute function public.set_saved_items_updated_at();

create function public.begin_data_import(
  p_user_id uuid,
  p_platform text,
  p_file_hash text,
  p_safe_filename text,
  p_file_size_bytes bigint,
  p_parser_version text,
  p_selected_categories jsonb,
  p_detected_categories jsonb,
  p_items_detected integer,
  p_items_selected integer,
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
  if p_platform not in ('reddit', 'linkedin') then
    raise exception 'Unsupported import platform' using errcode = '22023';
  end if;

  -- One active import per user at a time. A second upload cannot race the
  -- first into a half-merged state.
  update public.data_imports
  set status = 'cancelled',
      stage = 'superseded',
      completed_at = pg_catalog.clock_timestamp()
  where user_id = p_user_id
    and status in ('processing', 'classifying');

  insert into public.data_imports (
    user_id, platform, status, stage, file_hash, safe_filename,
    file_size_bytes, parser_version, selected_categories, detected_categories,
    items_detected, items_selected, files_detected
  ) values (
    p_user_id, p_platform, 'processing', 'importing',
    p_file_hash, p_safe_filename, p_file_size_bytes,
    coalesce(p_parser_version, 'v1'),
    coalesce(p_selected_categories, '[]'::jsonb),
    coalesce(p_detected_categories, '{}'::jsonb),
    coalesce(p_items_detected, 0), coalesce(p_items_selected, 0),
    coalesce(p_files_detected, 0)
  )
  returning id into import_id;

  return import_id;
end;
$$;

-- Applies one batch of normalized records.
--
-- Identity resolution, in order:
--   1. an existing data_import_records row for this content key
--   2. an existing saved_items row on (user_id, normalized_url)
--   3. insert
--
-- Step 2 is what makes an export converge with the Reddit OAuth sync: a post
-- already synced from the connected account is found by its canonical
-- permalink and enriched in place rather than duplicated.
create function public.apply_data_import_batch(
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
  item_id uuid;
  import_platform text;
  existing_item public.saved_items%rowtype;
  existing_record public.data_import_records%rowtype;
  created_count integer := 0;
  updated_count integer := 0;
  merged_count integer := 0;
  availability text;
  classification text;
  batch_full integer := 0;
  batch_partial integer := 0;
  batch_reference integer := 0;
begin
  if p_user_id is null or p_import_id is null then
    raise exception 'Import identifiers must not be null' using errcode = '22004';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
    or pg_catalog.jsonb_array_length(p_items) > 500 then
    raise exception 'Import batch is invalid' using errcode = '22023';
  end if;

  select d.platform into import_platform
  from public.data_imports d
  where d.id = p_import_id and d.user_id = p_user_id
    and d.status in ('processing', 'classifying');
  if import_platform is null then
    raise exception 'Import is not active' using errcode = '42501';
  end if;

  for item in
    select value from pg_catalog.jsonb_array_elements(p_items) as entry(value)
  loop
    if item->>'content_key' is null or item->>'normalized_url' is null then
      raise exception 'Import item is invalid' using errcode = '22023';
    end if;
    availability := coalesce(item->>'content_availability', 'reference_only');
    classification := coalesce(item->>'classification_status', 'pending');

    select * into existing_record
    from public.data_import_records r
    where r.user_id = p_user_id
      and r.platform = import_platform
      and r.content_key = item->>'content_key';

    item_id := null;
    if found and existing_record.saved_item_id is not null then
      -- Confirm the row still exists and still belongs to this user before
      -- writing through a stored id.
      select * into existing_item
      from public.saved_items s
      where s.id = existing_record.saved_item_id and s.user_id = p_user_id;
      if found then item_id := existing_item.id; end if;
    end if;

    if item_id is null then
      select * into existing_item
      from public.saved_items s
      where s.user_id = p_user_id and s.normalized_url = item->>'normalized_url';
      if found then item_id := existing_item.id; end if;
    end if;

    if item_id is null then
      insert into public.saved_items (
        user_id, url, normalized_url, source, title, description, content,
        author, thumbnail_url, tags, metadata, searchable_text, embedding,
        indexing_status, indexing_error
      ) values (
        p_user_id,
        item->>'url',
        item->>'normalized_url',
        import_platform,
        item->>'title',
        item->>'description',
        item->>'content',
        item->>'author',
        null,
        -- Tags are the user's. An import never writes them.
        '{}',
        coalesce(item->'metadata', '{}'::jsonb),
        coalesce(item->>'searchable_text', ''),
        case
          when item->'embedding' is null
            or pg_catalog.jsonb_typeof(item->'embedding') = 'null' then null
          else (item->>'embedding')::extensions.vector
        end,
        coalesce(item->>'indexing_status', 'pending'),
        null
      )
      returning id into item_id;
      created_count := created_count + 1;
    else
      -- Never downgrade. Richer stored content survives a poorer import, an
      -- existing embedding is never discarded, and notes and tags are not
      -- touched at all.
      update public.saved_items
      set title = coalesce(nullif(item->>'title', ''), public.saved_items.title),
          description = coalesce(
            nullif(item->>'description', ''), public.saved_items.description),
          content = case
            when public.saved_items.content is not null
              and pg_catalog.length(public.saved_items.content)
                >= pg_catalog.length(coalesce(item->>'content', ''))
            then public.saved_items.content
            else coalesce(nullif(item->>'content', ''), public.saved_items.content)
          end,
          author = coalesce(nullif(item->>'author', ''), public.saved_items.author),
          metadata = public.saved_items.metadata
            || coalesce(item->'metadata', '{}'::jsonb),
          searchable_text = case
            when pg_catalog.length(coalesce(item->>'searchable_text', ''))
              > pg_catalog.length(coalesce(public.saved_items.searchable_text, ''))
            then item->>'searchable_text'
            else public.saved_items.searchable_text
          end,
          embedding = coalesce(public.saved_items.embedding, case
            when item->'embedding' is null
              or pg_catalog.jsonb_typeof(item->'embedding') = 'null' then null
            else (item->>'embedding')::extensions.vector
          end),
          indexing_status = case
            when public.saved_items.indexing_status = 'ready' then 'ready'
            else coalesce(item->>'indexing_status', public.saved_items.indexing_status)
          end
      where id = item_id and user_id = p_user_id;
      updated_count := updated_count + 1;
      merged_count := merged_count + 1;
    end if;

    insert into public.data_import_records (
      user_id, platform, content_key, saved_item_id, categories,
      content_availability, classification_status, import_method,
      import_id, source_files
    ) values (
      p_user_id, import_platform, item->>'content_key', item_id,
      coalesce(item->'categories', '[]'::jsonb),
      availability, classification,
      import_platform || '_export', p_import_id,
      coalesce(item->'source_files', '[]'::jsonb)
    )
    on conflict (user_id, platform, content_key) do update
    set saved_item_id = coalesce(
          excluded.saved_item_id, public.data_import_records.saved_item_id),
        categories = excluded.categories,
        -- A later export that carries more content upgrades the record; one
        -- that carries less never downgrades it.
        content_availability = case
          when public.data_import_records.content_availability = 'full' then 'full'
          when public.data_import_records.content_availability = 'partial'
            and excluded.content_availability = 'reference_only' then 'partial'
          else excluded.content_availability
        end,
        classification_status = case
          when public.data_import_records.classification_status = 'ready'
            then 'ready'
          else excluded.classification_status
        end,
        source_files = excluded.source_files,
        import_id = excluded.import_id;
    -- first_seen_at is preserved by omission: a re-import must not reset it.

    if availability = 'full' then batch_full := batch_full + 1;
    elsif availability = 'partial' then batch_partial := batch_partial + 1;
    else batch_reference := batch_reference + 1;
    end if;
  end loop;

  update public.data_imports
  set items_created = items_created + created_count,
      items_updated = items_updated + updated_count,
      items_duplicated = items_duplicated + merged_count,
      full_count = full_count + batch_full,
      partial_count = partial_count + batch_partial,
      reference_only_count = reference_only_count + batch_reference,
      updated_at = pg_catalog.now()
  where id = p_import_id and user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'created', created_count,
    'updated', updated_count,
    'full', batch_full,
    'partial', batch_partial,
    'referenceOnly', batch_reference
  );
end;
$$;

-- Records the outcome of one classification pass.
create function public.record_data_import_classification(
  p_user_id uuid,
  p_import_id uuid,
  p_content_key text,
  p_platform text,
  p_status text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('ready', 'insufficient_content', 'failed') then
    raise exception 'Invalid classification status' using errcode = '22023';
  end if;

  update public.data_import_records
  set classification_status = p_status,
      classification_error = pg_catalog.left(p_error, 300)
  where user_id = p_user_id
    and platform = p_platform
    and content_key = p_content_key;

  update public.data_imports
  set classification_ready_count = classification_ready_count
        + case when p_status = 'ready' then 1 else 0 end,
      classification_insufficient_count = classification_insufficient_count
        + case when p_status = 'insufficient_content' then 1 else 0 end,
      classification_failed_count = classification_failed_count
        + case when p_status = 'failed' then 1 else 0 end,
      updated_at = pg_catalog.now()
  where id = p_import_id and user_id = p_user_id;
end;
$$;

create function public.complete_data_import(
  p_user_id uuid,
  p_import_id uuid,
  p_status text,
  p_stage text,
  p_files_processed integer,
  p_files_skipped integer,
  p_items_unresolved integer,
  p_warnings jsonb,
  p_safe_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in (
    'classifying', 'completed', 'completed_with_warnings', 'failed', 'cancelled'
  ) then
    raise exception 'Invalid import status' using errcode = '22023';
  end if;

  update public.data_imports
  set status = p_status,
      stage = coalesce(p_stage, 'done'),
      files_processed = coalesce(p_files_processed, files_processed),
      files_skipped = coalesce(p_files_skipped, files_skipped),
      items_unresolved = coalesce(p_items_unresolved, items_unresolved),
      warnings = coalesce(p_warnings, warnings),
      safe_error = pg_catalog.left(p_safe_error, 500),
      completed_at = case
        when p_status = 'classifying' then null
        else pg_catalog.clock_timestamp()
      end,
      updated_at = pg_catalog.now()
  where id = p_import_id and user_id = p_user_id;
end;
$$;

-- Reverts one import by removing only what it created.
--
-- An item is deleted only when nothing else refers to it: no other import
-- record, no provider sync row, and nothing the user added themselves. A
-- Reddit post that also came from the connected account survives, as does any
-- item carrying a note or a manual tag.
create function public.revert_data_import(
  p_user_id uuid,
  p_import_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed_records integer;
  removed_items integer;
  import_platform text;
begin
  if p_user_id is null or p_import_id is null then
    raise exception 'Revert identifiers must not be null' using errcode = '22004';
  end if;

  select platform into import_platform
  from public.data_imports
  where id = p_import_id and user_id = p_user_id;
  if import_platform is null then
    raise exception 'Import not found' using errcode = '42501';
  end if;

  with deleted as (
    delete from public.data_import_records
    where user_id = p_user_id and import_id = p_import_id
    returning saved_item_id
  )
  select pg_catalog.count(*) into removed_records from deleted;

  with orphaned as (
    delete from public.saved_items as item
    where item.user_id = p_user_id
      and item.source = import_platform
      and not exists (
        select 1 from public.data_import_records as record
        where record.saved_item_id = item.id
      )
      -- The Reddit OAuth sync stamps `metadata.reddit`; an import stamps
      -- `metadata.import`. An item carrying the provider key came from the
      -- connected account too and must survive a revert.
      and not pg_catalog.jsonb_exists(item.metadata, 'reddit')
      and coalesce(item.notes, '') = ''
      and pg_catalog.array_length(item.tags, 1) is null
    returning item.id
  )
  select pg_catalog.count(*) into removed_items from orphaned;

  update public.data_imports
  set status = 'cancelled',
      stage = 'reverted',
      completed_at = pg_catalog.clock_timestamp()
  where id = p_import_id and user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'recordsRemoved', removed_records,
    'itemsRemoved', removed_items
  );
end;
$$;

revoke all on function public.begin_data_import(
  uuid, text, text, text, bigint, text, jsonb, jsonb, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.begin_data_import(
  uuid, text, text, text, bigint, text, jsonb, jsonb, integer, integer, integer
) to service_role;

revoke all on function public.apply_data_import_batch(uuid, uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.apply_data_import_batch(uuid, uuid, jsonb)
to service_role;

revoke all on function public.record_data_import_classification(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_data_import_classification(
  uuid, uuid, text, text, text, text
) to service_role;

revoke all on function public.complete_data_import(
  uuid, uuid, text, text, integer, integer, integer, jsonb, text
) from public, anon, authenticated;
grant execute on function public.complete_data_import(
  uuid, uuid, text, text, integer, integer, integer, jsonb, text
) to service_role;

revoke all on function public.revert_data_import(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.revert_data_import(uuid, uuid) to service_role;
