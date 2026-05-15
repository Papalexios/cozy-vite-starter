// src/lib/db/types.ts
// Phase 1 - Content Memory: TypeScript row types matching migrations/001_phase1_content_memory.sql

export type AppRole = 'admin' | 'member';

export interface SiteRow {
  id: string;
  owner_id: string;
  name: string;
  wp_url: string;
  wp_username: string | null;
  wp_app_password_encrypted: string | null;
  default_author_id: number | null;
  default_category_ids: number[] | null;
  default_status: string | null;
  gsc_property_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  id: string;
  site_id: string;
  url: string;
  wp_post_id: number | null;
  title: string | null;
  word_count: number;
  content_hash: string | null;
  health_score: number | null;
  last_crawled_at: string | null;
  is_stale: boolean;
  created_at: string;
  updated_at: string;
}

export interface KeywordRow {
  id: string;
  site_id: string;
  page_id: string | null;
  keyword: string;
  intent: string | null;
  source: 'manual' | 'gsc' | 'serp' | 'gap_analysis' | string;
  target_position: number | null;
  serp_snapshot: unknown;
  created_at: string;
}

export type ContentJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type ContentJobType = 'generate' | 'refresh' | 'godmode' | 'gap';

export interface ContentJobRow {
  id: string;
  site_id: string;
  owner_id: string;
  type: ContentJobType | string;
  status: ContentJobStatus | string;
  config: Record<string, unknown>;
  progress: Record<string, unknown>;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface DraftRow {
  id: string;
  job_id: string | null;
  site_id: string;
  page_id: string | null;
  primary_keyword: string;
  secondary_keywords: string[];
  title: string;
  seo_title: string | null;
  meta_description: string | null;
  slug: string | null;
  html: string;
  word_count: number;
  quality_score: unknown;
  neuronwriter_query_id: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  id: string;
  draft_id: string;
  url: string;
  title: string | null;
  domain: string | null;
  authority_score: number | null;
  http_status: number | null;
  verified_at: string | null;
  type: string | null;
}

export interface InternalLinkRow {
  id: string;
  draft_id: string;
  anchor: string;
  target_url: string;
  paragraph_index: number | null;
  relevance_score: number | null;
}

export interface PublishLogRow {
  id: string;
  draft_id: string;
  site_id: string;
  wp_post_id: number | null;
  wp_url: string | null;
  status: 'success' | 'error' | 'scheduled' | string;
  response: unknown;
  error: string | null;
  published_at: string;
}

export interface RevisionRow {
  id: string;
  draft_id: string;
  version: number;
  html: string;
  diff_summary: string | null;
  created_at: string;
}

export interface RankingSnapshotRow {
  id: string;
  site_id: string;
  keyword_id: string | null;
  url: string | null;
  position: number | null;
  captured_at: string;
}

export interface GscMetricRow {
  id: string;
  site_id: string;
  page_url: string;
  query: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  date: string;
}
