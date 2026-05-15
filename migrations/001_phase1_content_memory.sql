-- =====================================================================
-- Phase 1 — Content Memory Schema
-- WP Content Optimizer PRO
--
-- Apply via Supabase Dashboard → SQL Editor (or psql).
-- Idempotent: safe to re-run.
-- =====================================================================

-- Extensions ---------------------------------------------------------
create extension if not exists "pgcrypto";

-- ===== ROLES =========================================================
do $$ begin
  create type public.app_role as enum ('admin', 'member');
exception when duplicate_object then null; end $$;

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

-- ===== SITES =========================================================
create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  wp_url text not null,
  wp_username text,
  wp_app_password_encrypted text,    -- pgsodium-encrypted at rest (caller's responsibility)
  default_author_id integer,
  default_category_ids integer[],
  default_status text default 'draft',
  gsc_property_url text,             -- e.g. https://example.com/ or sc-domain:example.com
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sites_owner on public.sites(owner_id);

-- ===== PAGES =========================================================
create table if not exists public.pages (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  url text not null,
  wp_post_id integer,
  title text,
  word_count integer default 0,
  content_hash text,
  health_score integer,
  last_crawled_at timestamptz,
  is_stale boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, url)
);
create index if not exists idx_pages_site on public.pages(site_id);
create index if not exists idx_pages_health on public.pages(site_id, health_score);

-- ===== KEYWORDS ======================================================
create table if not exists public.keywords (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  page_id uuid references public.pages(id) on delete set null,
  keyword text not null,
  intent text,                       -- informational | transactional | navigational | commercial
  source text not null default 'manual',  -- manual | gsc | serp | gap_analysis
  target_position integer,
  serp_snapshot jsonb,
  created_at timestamptz not null default now(),
  unique (site_id, keyword)
);
create index if not exists idx_keywords_site on public.keywords(site_id);

-- ===== CONTENT JOBS ==================================================
create table if not exists public.content_jobs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  type text not null,                -- generate | refresh | godmode | gap
  status text not null default 'queued',  -- queued | running | done | error | cancelled
  config jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_jobs_status on public.content_jobs(status);
create index if not exists idx_jobs_site on public.content_jobs(site_id);

-- ===== DRAFTS ========================================================
create table if not exists public.drafts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.content_jobs(id) on delete set null,
  site_id uuid not null references public.sites(id) on delete cascade,
  page_id uuid references public.pages(id) on delete set null,
  primary_keyword text not null,
  secondary_keywords text[] default '{}',
  title text not null,
  seo_title text,
  meta_description text,
  slug text,
  html text not null,
  word_count integer default 0,
  quality_score jsonb,
  neuronwriter_query_id text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_drafts_site on public.drafts(site_id);
create index if not exists idx_drafts_keyword on public.drafts(primary_keyword);

-- ===== SOURCES (citations) ==========================================
create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.drafts(id) on delete cascade,
  url text not null,
  title text,
  domain text,
  authority_score integer,
  http_status integer,
  verified_at timestamptz,
  type text                          -- academic | news | industry | government | blog
);
create index if not exists idx_sources_draft on public.sources(draft_id);

-- ===== INTERNAL LINKS ================================================
create table if not exists public.internal_links (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.drafts(id) on delete cascade,
  anchor text not null,
  target_url text not null,
  paragraph_index integer,
  relevance_score numeric
);
create index if not exists idx_links_draft on public.internal_links(draft_id);

-- ===== PUBLISH LOGS ==================================================
create table if not exists public.publish_logs (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.drafts(id) on delete cascade,
  site_id uuid not null references public.sites(id) on delete cascade,
  wp_post_id integer,
  wp_url text,
  status text not null,              -- success | error | scheduled
  response jsonb,
  error text,
  published_at timestamptz not null default now()
);
create index if not exists idx_publish_draft on public.publish_logs(draft_id);
create index if not exists idx_publish_site on public.publish_logs(site_id);

-- ===== REVISIONS =====================================================
create table if not exists public.revisions (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.drafts(id) on delete cascade,
  version integer not null,
  html text not null,
  diff_summary text,
  created_at timestamptz not null default now(),
  unique (draft_id, version)
);

-- ===== RANKING SNAPSHOTS =============================================
create table if not exists public.ranking_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  keyword_id uuid references public.keywords(id) on delete cascade,
  url text,
  position numeric,
  captured_at date not null default current_date,
  unique (site_id, keyword_id, captured_at)
);
create index if not exists idx_ranking_site_date on public.ranking_snapshots(site_id, captured_at);

-- ===== GSC METRICS ===================================================
create table if not exists public.gsc_metrics (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  page_url text not null,
  query text not null,
  impressions integer not null default 0,
  clicks integer not null default 0,
  ctr numeric not null default 0,
  position numeric not null default 0,
  date date not null,
  unique (site_id, page_url, query, date)
);
create index if not exists idx_gsc_site_date on public.gsc_metrics(site_id, date);
create index if not exists idx_gsc_page on public.gsc_metrics(site_id, page_url);

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.sites              enable row level security;
alter table public.pages              enable row level security;
alter table public.keywords           enable row level security;
alter table public.content_jobs       enable row level security;
alter table public.drafts             enable row level security;
alter table public.sources            enable row level security;
alter table public.internal_links     enable row level security;
alter table public.publish_logs       enable row level security;
alter table public.revisions          enable row level security;
alter table public.ranking_snapshots  enable row level security;
alter table public.gsc_metrics        enable row level security;

-- Helper: site ownership check (avoids recursive RLS)
create or replace function public.owns_site(_site_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.sites where id = _site_id and owner_id = auth.uid())
$$;

-- user_roles
drop policy if exists "user_roles self read" on public.user_roles;
create policy "user_roles self read" on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- sites
drop policy if exists "sites owner all" on public.sites;
create policy "sites owner all" on public.sites for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- generic owner-via-site policy generator
do $$
declare t text;
begin
  for t in select unnest(array[
    'pages','keywords','drafts','content_jobs','publish_logs',
    'ranking_snapshots','gsc_metrics'
  ]) loop
    execute format('drop policy if exists "%1$s site owner all" on public.%1$s', t);
    execute format(
      'create policy "%1$s site owner all" on public.%1$s for all to authenticated
         using (public.owns_site(site_id)) with check (public.owns_site(site_id))', t);
  end loop;
end $$;

-- sources / internal_links / revisions: scope through draft → site
do $$
declare t text;
begin
  for t in select unnest(array['sources','internal_links','revisions']) loop
    execute format('drop policy if exists "%1$s draft owner all" on public.%1$s', t);
    execute format(
      'create policy "%1$s draft owner all" on public.%1$s for all to authenticated
         using (exists (select 1 from public.drafts d where d.id = %1$s.draft_id and public.owns_site(d.site_id)))
         with check (exists (select 1 from public.drafts d where d.id = %1$s.draft_id and public.owns_site(d.site_id)))', t);
  end loop;
end $$;

-- updated_at triggers
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  for t in select unnest(array['sites','pages','drafts']) loop
    execute format('drop trigger if exists trg_%1$s_updated on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated before update on public.%1$s
                    for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;
