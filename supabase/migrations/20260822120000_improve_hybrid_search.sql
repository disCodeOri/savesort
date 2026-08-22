-- Improve hybrid search quality and speed without changing the RPC contract.
--
-- 1. Tune HNSW recall at query time (hnsw.ef_search 40 -> 100). The partial
--    HNSW index carries no user_id, so the ANN scan returns global nearest
--    neighbours that are then filtered down to one user's rows; a higher
--    ef_search keeps enough surviving candidates per user after that filter.
-- 2. Compute websearch_to_tsquery once instead of three times per query.
-- 3. Add a relaxed keyword leg: when the strict AND-match finds nothing
--    (typical for vague multi-word queries, or queries made only of words the
--    english dictionary drops), fall back to an OR-of-terms tsquery ranked by
--    ts_rank_cd so partial keyword evidence still reaches the fusion step.
--    Terms are stripped to alphanumeric characters before reaching
--    to_tsquery, so arbitrary input can never introduce tsquery syntax.
--
-- Signature, returned columns, security invoker behaviour, RLS scoping, and
-- the reciprocal-rank fusion weights are unchanged.

drop function if exists public.hybrid_search_saved_items(
  text,
  extensions.vector,
  text,
  integer
);

create function public.hybrid_search_saved_items(
  query_text text,
  query_embedding extensions.vector(768) default null,
  filter_source text default null,
  limit_count integer default 20
)
returns table (
  id uuid,
  url text,
  normalized_url text,
  source text,
  title text,
  description text,
  notes text,
  content text,
  author text,
  thumbnail_url text,
  tags text[],
  metadata jsonb,
  indexing_status text,
  created_at timestamptz,
  updated_at timestamptz,
  keyword_rank bigint,
  semantic_rank bigint,
  similarity double precision,
  combined_score double precision
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- Local to this call's snapshot of the surrounding transaction.
  perform set_config('hnsw.ef_search', '100', true);

  return query
  with params as (
    select
      (select auth.uid()) as owner_uid,
      websearch_to_tsquery('english', query_text) as strict_tsquery,
      least(greatest(limit_count, 1), 50) * 5 as candidate_count
  ),
  relaxed_terms as (
    select distinct regexp_replace(token, '[^[:alnum:]_]+', '', 'g') as term
    from unnest(string_to_array(query_text, ' ')) as u(token)
  ),
  relaxed_query as (
    select nullif(string_agg(term, ' | ' order by term), '') as tsquery_text
    from relaxed_terms
    where term <> ''
  ),
  keyword_strict as (
    select
      item.id,
      row_number() over (
        order by ts_rank_cd(item.search_document, p.strict_tsquery) desc,
        item.created_at desc
      ) as rank
    from public.saved_items item
    cross join params p
    where item.user_id = p.owner_uid
      and (filter_source is null or item.source = filter_source)
      and item.search_document @@ p.strict_tsquery
    order by ts_rank_cd(item.search_document, p.strict_tsquery) desc
    limit (select candidate_count from params)
  ),
  -- CASE guards evaluation, so to_tsquery never sees a null or empty string.
  keyword_relaxed as (
    select
      item.id,
      row_number() over (
        order by ts_rank_cd(item.search_document, relaxed.tsq) desc,
        item.created_at desc
      ) as rank
    from public.saved_items item
    cross join (
      select
        case
          when rq.tsquery_text is null then null::tsquery
          else to_tsquery('english', rq.tsquery_text)
        end as tsq
      from relaxed_query rq
    ) relaxed
    cross join params p
    where relaxed.tsq is not null
      and item.user_id = p.owner_uid
      and (filter_source is null or item.source = filter_source)
      and item.search_document @@ relaxed.tsq
    order by ts_rank_cd(item.search_document, relaxed.tsq) desc
    limit (select candidate_count from params)
  ),
  -- Strict AND-matches win on precision; the relaxed OR ranking is only a
  -- fallback so the keyword side still contributes when they find nothing.
  keyword_pool as (
    select ks.id, ks.rank
    from keyword_strict ks
    union all
    select kr.id, kr.rank
    from keyword_relaxed kr
    where (select count(*) from keyword_strict) = 0
  ),
  semantic_matches as (
    select
      item.id,
      row_number() over (
        order by item.embedding operator(extensions.<=>) query_embedding
      ) as rank,
      1 - (item.embedding operator(extensions.<=>) query_embedding) as similarity
    from public.saved_items item
    where query_embedding is not null
      and item.embedding is not null
      and item.user_id = (select owner_uid from params)
      and (filter_source is null or item.source = filter_source)
    order by item.embedding operator(extensions.<=>) query_embedding
    limit (select candidate_count from params)
  ),
  fused as (
    select
      coalesce(keyword_pool.id, semantic_matches.id) as id,
      keyword_pool.rank as keyword_rank,
      semantic_matches.rank as semantic_rank,
      semantic_matches.similarity,
      coalesce(1.0::double precision / (60 + keyword_pool.rank), 0.0::double precision) +
        coalesce(1.0::double precision / (60 + semantic_matches.rank), 0.0::double precision) as combined_score
    from keyword_pool
    full outer join semantic_matches on semantic_matches.id = keyword_pool.id
  )
  select
    item.id,
    item.url,
    item.normalized_url,
    item.source,
    item.title,
    item.description,
    item.notes,
    item.content,
    item.author,
    item.thumbnail_url,
    item.tags,
    item.metadata,
    item.indexing_status,
    item.created_at,
    item.updated_at,
    fused.keyword_rank,
    fused.semantic_rank,
    fused.similarity,
    fused.combined_score
  from fused
  join public.saved_items item on item.id = fused.id
  order by fused.combined_score desc, item.created_at desc
  limit least(greatest(limit_count, 1), 50);
end;
$$;

revoke all on function public.hybrid_search_saved_items(text, extensions.vector, text, integer) from public;
revoke all on function public.hybrid_search_saved_items(text, extensions.vector, text, integer) from anon;
grant execute on function public.hybrid_search_saved_items(text, extensions.vector, text, integer) to authenticated;

comment on function public.hybrid_search_saved_items(text, extensions.vector, text, integer) is
  'Reciprocal-rank fusion over keyword (strict AND, with relaxed OR fallback) and HNSW cosine rankings; security invoker, scoped to auth.uid().';
