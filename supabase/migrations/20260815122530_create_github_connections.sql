create table public.github_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_user_id bigint not null,
  github_login text not null,
  github_avatar_url text,
  connection_status text not null default 'connected'
    check (connection_status in ('connected', 'reconnect_required')),
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'running', 'failed')),
  active_sync_id uuid,
  next_page integer not null default 1 check (next_page > 0),
  discovered_count integer not null default 0 check (discovered_count >= 0),
  saved_count integer not null default 0 check (saved_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  sync_started_at timestamptz,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (github_user_id)
);

create table public.github_connection_secrets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.github_connections enable row level security;
alter table public.github_connection_secrets enable row level security;

create policy "Users can read their GitHub connection"
on public.github_connections for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can update their GitHub connection metadata"
on public.github_connections for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, update on public.github_connections to authenticated;
revoke all on public.github_connection_secrets from anon, authenticated;

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

revoke all on function public.begin_github_sync(uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_github_sync(uuid, uuid) to service_role;

create trigger set_github_connections_updated_at
before update on public.github_connections
for each row execute function public.set_saved_items_updated_at();

create trigger set_github_connection_secrets_updated_at
before update on public.github_connection_secrets
for each row execute function public.set_saved_items_updated_at();
