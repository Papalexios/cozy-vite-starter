-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 10 — Topical Clusters (pillar + spokes)
-- Run this in Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.topic_clusters (
  id              uuid primary key default gen_random_uuid(),
  site_id         text,
  owner_id        uuid,
  root_topic      text not null,
  pillar_keyword  text not null,
  summary         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists topic_clusters_owner_idx on public.topic_clusters (owner_id);
create index if not exists topic_clusters_site_idx  on public.topic_clusters (site_id);

create table if not exists public.cluster_nodes (
  id              uuid primary key default gen_random_uuid(),
  cluster_id      uuid not null references public.topic_clusters(id) on delete cascade,
  kind            text not null check (kind in ('pillar','spoke')),
  title           text not null,
  target_keyword  text not null,
  content_type    text,                         -- how-to | guide | comparison | listicle | deep-dive
  intent          text,                         -- informational | commercial | etc.
  status          text not null default 'planned', -- planned | drafting | done
  draft_id        uuid,                         -- FK to drafts(id) if you wire it
  position        integer not null default 0,
  embedding       vector(1536),                 -- requires Phase 7 pgvector extension
  created_at      timestamptz not null default now()
);

create index if not exists cluster_nodes_cluster_idx on public.cluster_nodes (cluster_id);
create index if not exists cluster_nodes_kind_idx    on public.cluster_nodes (kind);
create index if not exists cluster_nodes_embedding_idx
  on public.cluster_nodes using hnsw (embedding vector_cosine_ops);

alter table public.topic_clusters enable row level security;
alter table public.cluster_nodes  enable row level security;

drop policy if exists "owners read clusters"   on public.topic_clusters;
drop policy if exists "owners write clusters"  on public.topic_clusters;
drop policy if exists "owners read nodes"      on public.cluster_nodes;
drop policy if exists "owners write nodes"     on public.cluster_nodes;

create policy "owners read clusters"  on public.topic_clusters for select using (owner_id = auth.uid() or owner_id is null);
create policy "owners write clusters" on public.topic_clusters for all    using (owner_id = auth.uid() or owner_id is null) with check (owner_id = auth.uid() or owner_id is null);
create policy "owners read nodes"     on public.cluster_nodes  for select using (true);
create policy "owners write nodes"    on public.cluster_nodes  for all    using (true) with check (true);
