create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.saved_items (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  url text not null,
  normalized_url text not null,
  source text not null check (source in ('github', 'instagram', 'youtube', 'reddit', 'x', 'website', 'other')),
  title text,
  description text,
  notes text,
  content text,
  author text,
  thumbnail_url text,
  tags text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  searchable_text text not null default '',
  search_document tsvector generated always as (
    to_tsvector('english', coalesce(searchable_text, ''))
  ) stored,
  embedding extensions.vector(768),
  indexing_status text not null default 'pending'
    check (indexing_status in ('ready', 'keyword_only', 'pending', 'failed')),
  indexing_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, normalized_url)
);

comment on table public.saved_items is
  'Private internet resources saved and indexed by one authenticated user.';
comment on column public.saved_items.embedding is
  '768-dimension Gemini embedding for semantic retrieval; nullable for keyword-only records.';
comment on column public.saved_items.indexing_error is
  'A short safe provider/enrichment error for user-facing retry guidance; never a stack trace.';

create index saved_items_user_created_at_idx
  on public.saved_items (user_id, created_at desc);
create index saved_items_user_source_idx
  on public.saved_items (user_id, source);
create index saved_items_search_document_idx
  on public.saved_items using gin (search_document);
create index saved_items_embedding_idx
  on public.saved_items using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

create or replace function public.set_saved_items_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_saved_items_updated_at
before update on public.saved_items
for each row execute function public.set_saved_items_updated_at();

alter table public.saved_items enable row level security;

create policy "Users can read their own saved items"
on public.saved_items for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert their own saved items"
on public.saved_items for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own saved items"
on public.saved_items for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own saved items"
on public.saved_items for delete
to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.saved_items to authenticated;

create or replace function public.hybrid_search_saved_items(
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
language sql
stable
security invoker
set search_path = ''
as $$
  with keyword_matches as (
    select
      item.id,
      row_number() over (
        order by ts_rank_cd(
          item.search_document,
          websearch_to_tsquery('english', query_text)
        ) desc,
        item.created_at desc
      ) as rank
    from public.saved_items item
    where item.user_id = (select auth.uid())
      and (filter_source is null or item.source = filter_source)
      and item.search_document @@ websearch_to_tsquery('english', query_text)
    order by ts_rank_cd(
      item.search_document,
      websearch_to_tsquery('english', query_text)
    ) desc
    limit least(greatest(limit_count, 1), 50) * 5
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
      and item.user_id = (select auth.uid())
      and (filter_source is null or item.source = filter_source)
    order by item.embedding operator(extensions.<=>) query_embedding
    limit least(greatest(limit_count, 1), 50) * 5
  ),
  fused as (
    select
      coalesce(keyword_matches.id, semantic_matches.id) as id,
      keyword_matches.rank as keyword_rank,
      semantic_matches.rank as semantic_rank,
      semantic_matches.similarity,
      coalesce(1.0 / (60 + keyword_matches.rank), 0.0) +
        coalesce(1.0 / (60 + semantic_matches.rank), 0.0) as combined_score
    from keyword_matches
    full outer join semantic_matches using (id)
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
$$;

revoke all on function public.hybrid_search_saved_items(text, extensions.vector, text, integer) from public;
revoke all on function public.hybrid_search_saved_items(text, extensions.vector, text, integer) from anon;
grant execute on function public.hybrid_search_saved_items(text, extensions.vector, text, integer) to authenticated;
