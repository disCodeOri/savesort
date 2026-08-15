alter table public.github_connections
  add column page_lease_id uuid,
  add column page_lease_started_at timestamptz,
  add constraint github_connections_page_lease_pair check (
    (page_lease_id is null and page_lease_started_at is null)
    or (page_lease_id is not null and page_lease_started_at is not null)
  );

create or replace function public.begin_github_sync(
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
  if p_sync_id is null then
    raise exception 'p_sync_id must not be null' using errcode = '22004';
  end if;

  update public.github_connections
  set sync_status = 'running',
      active_sync_id = p_sync_id,
      next_page = 1,
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

create or replace function public.claim_github_sync_page(
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
    raise exception 'GitHub sync page identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'GitHub sync page must be positive'
      using errcode = '22023';
  end if;

  update public.github_connections
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

create or replace function public.apply_github_sync_page(
  p_user_id uuid,
  p_sync_id uuid,
  p_lease_id uuid,
  p_page integer,
  p_next_page integer,
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
  connection_row public.github_connections%rowtype;
  item jsonb;
  expected_updated_at timestamptz;
  changed_count integer;
  inserted_count integer := 0;
  final_status text;
begin
  if p_user_id is null or p_sync_id is null or p_lease_id is null then
    raise exception 'GitHub sync page identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'GitHub sync page must be positive'
      using errcode = '22023';
  end if;
  if p_next_page is not null and p_next_page <> p_page + 1 then
    raise exception 'GitHub next page must advance by one'
      using errcode = '22023';
  end if;
  if p_discovered_count is null or p_discovered_count < 0
    or p_skipped_count is null or p_skipped_count < 0 then
    raise exception 'GitHub page counts must be non-negative'
      using errcode = '22023';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
    or pg_catalog.jsonb_array_length(p_items) > 100
    or pg_catalog.jsonb_array_length(p_items) + p_skipped_count <> p_discovered_count then
    raise exception 'GitHub page items do not match the page counts'
      using errcode = '22023';
  end if;

  select connection.*
  into connection_row
  from public.github_connections as connection
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
      raise exception 'GitHub page item is invalid'
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
  update public.github_connections
  set discovered_count = discovered_count + p_discovered_count,
      saved_count = saved_count + inserted_count,
      skipped_count = skipped_count + p_skipped_count,
      next_page = coalesce(p_next_page, next_page),
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
    raise exception 'GitHub page lease changed during apply'
      using errcode = '40001';
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

create or replace function public.fail_github_sync_page(
  p_user_id uuid,
  p_sync_id uuid,
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
    raise exception 'GitHub sync identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_error is null or p_error = '' or pg_catalog.length(p_error) > 200
    or p_reconnect_required is null then
    raise exception 'GitHub sync failure metadata is invalid'
      using errcode = '22023';
  end if;

  update public.github_connections
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
    and (
      page_lease_id = p_lease_id
      or (page_lease_id is null and p_lease_id is null)
    );
  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

revoke all on function public.begin_github_sync(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.begin_github_sync(uuid, uuid) to service_role;

revoke all on function public.claim_github_sync_page(uuid, uuid, integer, uuid)
from public, anon, authenticated;
grant execute on function public.claim_github_sync_page(uuid, uuid, integer, uuid)
to service_role;

revoke all on function public.apply_github_sync_page(
  uuid, uuid, uuid, integer, integer, integer, integer, jsonb
)
from public, anon, authenticated;
grant execute on function public.apply_github_sync_page(
  uuid, uuid, uuid, integer, integer, integer, integer, jsonb
)
to service_role;

revoke all on function public.fail_github_sync_page(uuid, uuid, uuid, text, boolean)
from public, anon, authenticated;
grant execute on function public.fail_github_sync_page(uuid, uuid, uuid, text, boolean)
to service_role;
