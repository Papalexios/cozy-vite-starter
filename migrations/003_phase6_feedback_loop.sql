-- =====================================================================
-- Phase 6 — Performance Feedback Loop
-- WP Content Optimizer PRO
--
-- Adds:
--   * topical_authority_snapshots — periodic per-site coverage score
--   * page_baselines              — 28-day pre-publish snapshot per draft,
--                                   captured at publish time so we can
--                                   compute before/after deltas later
--   * helpful indexes for ranking_snapshots / publish_logs
--
-- Idempotent: safe to re-run.
-- =====================================================================

-- ===== TOPICAL AUTHORITY =============================================
create table if not exists public.topical_authority_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  captured_at date not null default current_date,
  score numeric not null,                         -- 0..100
  entity_count integer not null default 0,
  covered_count integer not null default 0,
  details jsonb,                                  -- top gaps / clusters
  unique (site_id, captured_at)
);
create index if not exists idx_topical_site_date
  on public.topical_authority_snapshots(site_id, captured_at desc);

alter table public.topical_authority_snapshots enable row level security;

do $$ begin
  create policy "topical_owner_rw" on public.topical_authority_snapshots
    for all using (
      site_id in (select id from public.sites where owner_id = auth.uid())
    ) with check (
      site_id in (select id from public.sites where owner_id = auth.uid())
    );
exception when duplicate_object then null; end $$;

-- ===== PAGE BASELINES (pre-publish snapshot) =========================
create table if not exists public.page_baselines (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.drafts(id) on delete cascade,
  site_id uuid not null references public.sites(id) on delete cascade,
  page_url text not null,
  captured_at timestamptz not null default now(),
  window_days integer not null default 28,
  impressions integer not null default 0,
  clicks integer not null default 0,
  ctr numeric not null default 0,
  avg_position numeric not null default 0,
  top_queries jsonb,
  unique (draft_id, captured_at)
);
create index if not exists idx_baseline_draft on public.page_baselines(draft_id);
create index if not exists idx_baseline_site_url on public.page_baselines(site_id, page_url);

alter table public.page_baselines enable row level security;

do $$ begin
  create policy "baseline_owner_rw" on public.page_baselines
    for all using (
      site_id in (select id from public.sites where owner_id = auth.uid())
    ) with check (
      site_id in (select id from public.sites where owner_id = auth.uid())
    );
exception when duplicate_object then null; end $$;

-- ===== Helpful indexes for feedback queries ==========================
create index if not exists idx_ranking_url_date
  on public.ranking_snapshots(site_id, url, captured_at desc);
create index if not exists idx_publish_logs_published_at
  on public.publish_logs(site_id, published_at desc);
