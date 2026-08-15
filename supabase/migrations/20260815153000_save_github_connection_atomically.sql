create or replace function public.save_github_connection(
  p_user_id uuid,
  p_github_user_id bigint,
  p_github_login text,
  p_github_avatar_url text,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_refresh_token_expires_at timestamptz
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

  if p_github_user_id is null or p_github_user_id <= 0 then
    raise exception 'p_github_user_id must be positive' using errcode = '22023';
  end if;

  if p_github_login is null or btrim(p_github_login) = '' then
    raise exception 'p_github_login must not be blank' using errcode = '22023';
  end if;

  if p_access_token_ciphertext is null or btrim(p_access_token_ciphertext) = '' then
    raise exception 'p_access_token_ciphertext must not be blank' using errcode = '22023';
  end if;

  insert into public.github_connection_secrets (
    user_id,
    access_token_ciphertext,
    refresh_token_ciphertext,
    access_token_expires_at,
    refresh_token_expires_at
  )
  values (
    p_user_id,
    p_access_token_ciphertext,
    p_refresh_token_ciphertext,
    p_access_token_expires_at,
    p_refresh_token_expires_at
  )
  on conflict (user_id) do update
  set access_token_ciphertext = excluded.access_token_ciphertext,
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at;

  insert into public.github_connections (
    user_id,
    github_user_id,
    github_login,
    github_avatar_url,
    connection_status,
    sync_status
  )
  values (
    p_user_id,
    p_github_user_id,
    p_github_login,
    p_github_avatar_url,
    'connected',
    'idle'
  )
  on conflict (user_id) do update
  set github_user_id = excluded.github_user_id,
      github_login = excluded.github_login,
      github_avatar_url = excluded.github_avatar_url,
      connection_status = excluded.connection_status,
      sync_status = excluded.sync_status;
end;
$$;

revoke execute on function public.save_github_connection(uuid, bigint, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.save_github_connection(uuid, bigint, text, text, text, text, timestamptz, timestamptz) to service_role;
