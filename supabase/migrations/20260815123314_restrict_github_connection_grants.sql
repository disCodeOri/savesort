revoke all on table public.github_connections from anon, authenticated;
grant select, update on table public.github_connections to authenticated;
