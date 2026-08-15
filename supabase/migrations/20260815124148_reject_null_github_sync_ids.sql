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
      sync_started_at = now(),
      last_sync_error = null,
      updated_at = now()
  where user_id = p_user_id
    and connection_status = 'connected'
    and (
      sync_status <> 'running'
      or sync_started_at < now() - interval '10 minutes'
    );
  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;
