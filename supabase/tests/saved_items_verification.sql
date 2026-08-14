-- Run these checks against a disposable local Supabase database after applying migrations.
-- They are intentionally wrapped in a transaction so verification data is never retained.
begin;

do $$
begin
  assert (
    select relrowsecurity
    from pg_class
    where oid = 'public.saved_items'::regclass
  ), 'saved_items must have RLS enabled';

  assert (
    select count(*) = 4
    from pg_policies
    where schemaname = 'public' and tablename = 'saved_items'
  ), 'saved_items must have four owner policies';

  assert (
    select count(*) = 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'saved_items'
      and indexdef ilike '%using gin%'
  ), 'saved_items must have a GIN full-text index';

  assert (
    select count(*) = 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'saved_items'
      and indexdef ilike '%using hnsw%'
  ), 'saved_items must have an HNSW vector index';
end;
$$;

rollback;

-- Manual integration checks with two real Supabase test users:
-- 1. Insert the same normalized URL for both users; both inserts should succeed.
-- 2. Insert it twice for one user; the second insert should fail with unique_violation.
-- 3. User A must receive zero rows when selecting/updating/deleting User B's UUID.
-- 4. Exact title search should set keyword_rank; a paraphrase with a query vector should set semantic_rank.
-- 5. Calling hybrid_search_saved_items with query_embedding => null must still return keyword matches.
