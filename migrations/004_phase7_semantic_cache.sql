-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 7 — Semantic Cache + Information Gain runs
-- Run this in Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════════

create extension if not exists vector;

-- ─── SERP cache (keyed by keyword embedding, reused when cosine ≥ threshold) ───
create table if not exists public.serp_cache (
  id            uuid primary key default gen_random_uuid(),
  keyword       text not null,
  country       text not null default 'us',
  embedding     vector(1536) not null,
  payload       jsonb not null,          -- { serp: SERPResult[], snippets: string[] }
  fetched_at    timestamptz not null default now()
);

create index if not exists serp_cache_embedding_idx
  on public.serp_cache using hnsw (embedding vector_cosine_ops);
create index if not exists serp_cache_fetched_at_idx
  on public.serp_cache (fetched_at desc);

-- ─── Information-Gain runs (one row per generation) ────────────────────────────
create table if not exists public.information_gain_runs (
  id                  uuid primary key default gen_random_uuid(),
  site_id             text,
  keyword             text not null,
  keyword_embedding   vector(1536),
  lift_score          numeric not null default 0,           -- 0-100
  blindspots          jsonb not null default '[]'::jsonb,    -- string[]
  missing_entities    jsonb not null default '[]'::jsonb,    -- {name,wikidataUrl?}[]
  contrarian_angles   jsonb not null default '[]'::jsonb,    -- string[]
  competitor_urls     jsonb not null default '[]'::jsonb,    -- string[]
  created_at          timestamptz not null default now()
);

create index if not exists information_gain_runs_keyword_idx
  on public.information_gain_runs (keyword, created_at desc);

-- ─── RPC: nearest cached SERP within freshness window ─────────────────────────
create or replace function public.match_serp_cache (
  query_embedding vector(1536),
  similarity_threshold float default 0.92,
  max_age_days int default 7,
  match_country text default 'us'
)
returns table (
  id          uuid,
  keyword     text,
  payload     jsonb,
  fetched_at  timestamptz,
  similarity  float
)
language sql stable
as $$
  select
    c.id,
    c.keyword,
    c.payload,
    c.fetched_at,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.serp_cache c
  where c.country = match_country
    and c.fetched_at > now() - (max_age_days || ' days')::interval
    and (1 - (c.embedding <=> query_embedding)) >= similarity_threshold
  order by c.embedding <=> query_embedding
  limit 1;
$$;

-- Open access for now (anon key); tighten with RLS once auth shape is finalised.
alter table public.serp_cache enable row level security;
alter table public.information_gain_runs enable row level security;

drop policy if exists serp_cache_all on public.serp_cache;
create policy serp_cache_all on public.serp_cache for all using (true) with check (true);

drop policy if exists information_gain_runs_all on public.information_gain_runs;
create policy information_gain_runs_all on public.information_gain_runs for all using (true) with check (true);
