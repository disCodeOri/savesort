begin;

do $$
begin
  if to_regclass('public.github_connections') is null then
    raise exception 'github_connections is missing';
  end if;
  if to_regclass('public.github_connection_secrets') is null then
    raise exception 'github_connection_secrets is missing';
  end if;
  if to_regprocedure('public.begin_github_sync(uuid,uuid)') is null then
    raise exception 'begin_github_sync(uuid, uuid) is missing';
  end if;
end;
$$;

select relname, relrowsecurity
from pg_class
where relname in ('github_connections', 'github_connection_secrets');

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'github_connection_secrets'
  and grantee in ('anon', 'authenticated');

rollback;
