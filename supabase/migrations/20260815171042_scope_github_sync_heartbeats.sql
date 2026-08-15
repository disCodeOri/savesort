drop function public.fail_github_sync_page(uuid, uuid, uuid, text, boolean);

create function public.fail_github_sync_page(
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
    raise exception 'GitHub sync identifiers must not be null'
      using errcode = '22004';
  end if;
  if p_page is null or p_page < 1 then
    raise exception 'GitHub sync page must be positive'
      using errcode = '22023';
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
    and next_page = p_page
    and (
      page_lease_id = p_lease_id
      or (page_lease_id is null and p_lease_id is null)
    );
  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

create function public.heartbeat_github_sync_page(
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

revoke all on function public.fail_github_sync_page(
  uuid, uuid, integer, uuid, text, boolean
)
from public, anon, authenticated;
grant execute on function public.fail_github_sync_page(
  uuid, uuid, integer, uuid, text, boolean
)
to service_role;

revoke all on function public.heartbeat_github_sync_page(
  uuid, uuid, integer, uuid
)
from public, anon, authenticated;
grant execute on function public.heartbeat_github_sync_page(
  uuid, uuid, integer, uuid
)
to service_role;
