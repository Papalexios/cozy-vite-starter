// src/lib/db/contentMemory.ts
// Phase 1 - High-level glue between existing generation/publish flows and the DB.
// All operations are best-effort: if Supabase is not configured, they no-op gracefully
// so nothing in the existing flows breaks for users who haven't run the migration yet.

import { getSupabaseClient } from '@/lib/supabaseClient';
import {
  DraftsRepo, PublishLogsRepo, RevisionsRepo, SitesRepo,
  type DraftRow, type PublishLogRow, type RevisionRow, type SiteRow,
} from './index';

/** Resolve current auth user id (or null when no session). */
export async function getCurrentOwnerId(): Promise<string | null> {
  const sb = getSupabaseClient();
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Find or create a Site row matching the user's WP config. */
export async function ensureSiteForWpConfig(args: {
  name?: string;
  wp_url: string;
  wp_username?: string | null;
}): Promise<SiteRow | null> {
  const owner_id = await getCurrentOwnerId();
  if (!owner_id) return null;
  const sites = (await SitesRepo.list()) ?? [];
  const match = sites.find((s) => s.wp_url.replace(/\/+$/, '') === args.wp_url.replace(/\/+$/, ''));
  if (match) return match;
  return SitesRepo.upsert({
    name: args.name || args.wp_url,
    wp_url: args.wp_url,
    wp_username: args.wp_username ?? null,
    owner_id,
  });
}

export interface PersistDraftInput {
  site_id: string;
  job_id?: string | null;
  page_id?: string | null;
  primary_keyword: string;
  secondary_keywords?: string[];
  title: string;
  seo_title?: string | null;
  meta_description?: string | null;
  slug?: string | null;
  html: string;
  word_count?: number;
  quality_score?: unknown;
  neuronwriter_query_id?: string | null;
  model?: string | null;
  sources?: Array<{
    url: string;
    title?: string | null;
    domain?: string | null;
    authority_score?: number | null;
    http_status?: number | null;
    type?: string | null;
    verified_at?: string | null;
  }>;
  internalLinks?: Array<{
    anchor: string;
    target_url: string;
    paragraph_index?: number | null;
    relevance_score?: number | null;
  }>;
}

/** Persist a generated draft + sources + internal links. Returns null when DB unavailable. */
export async function persistGeneratedDraft(input: PersistDraftInput): Promise<DraftRow | null> {
  return DraftsRepo.insertWithChildren({
    draft: {
      site_id: input.site_id,
      job_id: input.job_id ?? null,
      page_id: input.page_id ?? null,
      primary_keyword: input.primary_keyword,
      secondary_keywords: input.secondary_keywords ?? [],
      title: input.title,
      seo_title: input.seo_title ?? null,
      meta_description: input.meta_description ?? null,
      slug: input.slug ?? null,
      html: input.html,
      word_count: input.word_count ?? input.html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length,
      quality_score: input.quality_score ?? null,
      neuronwriter_query_id: input.neuronwriter_query_id ?? null,
      model: input.model ?? null,
    },
    sources: input.sources?.map((s) => ({
      url: s.url,
      title: s.title ?? null,
      domain: s.domain ?? (() => { try { return new URL(s.url).hostname; } catch { return null; } })(),
      authority_score: s.authority_score ?? null,
      http_status: s.http_status ?? null,
      type: s.type ?? null,
      verified_at: s.verified_at ?? null,
    })),
    internalLinks: input.internalLinks?.map((l) => ({
      anchor: l.anchor,
      target_url: l.target_url,
      paragraph_index: l.paragraph_index ?? null,
      relevance_score: l.relevance_score ?? null,
    })),
  });
}

/** Record a WP publish + a revision snapshot of the published HTML. */
export async function recordPublish(args: {
  draft_id: string;
  site_id: string;
  status: 'success' | 'error' | 'scheduled';
  wp_post_id?: number | null;
  wp_url?: string | null;
  response?: unknown;
  error?: string | null;
  html?: string;
  diff_summary?: string | null;
}): Promise<{ log: PublishLogRow | null; revision: RevisionRow | null }> {
  const log = await PublishLogsRepo.create({
    draft_id: args.draft_id,
    site_id: args.site_id,
    status: args.status,
    wp_post_id: args.wp_post_id ?? null,
    wp_url: args.wp_url ?? null,
    response: args.response ?? null,
    error: args.error ?? null,
  });

  let revision: RevisionRow | null = null;
  if (args.html && args.status === 'success') {
    const version = await RevisionsRepo.nextVersion(args.draft_id);
    revision = await RevisionsRepo.create({
      draft_id: args.draft_id,
      version,
      html: args.html,
      diff_summary: args.diff_summary ?? null,
    });
  }
  return { log, revision };
}
