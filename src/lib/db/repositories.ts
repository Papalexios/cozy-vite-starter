// src/lib/db/repositories.ts
// Phase 1 - Content Memory: thin repository functions over Supabase.
// All functions return null/empty arrays when Supabase is not configured (BYO).

import { withSupabase } from '@/lib/supabaseClient';
import type {
  SiteRow, PageRow, KeywordRow, ContentJobRow, DraftRow,
  SourceRow, InternalLinkRow, PublishLogRow, RevisionRow,
  RankingSnapshotRow, GscMetricRow,
} from './types';

// ─── Sites ───────────────────────────────────────────────────────────
export const SitesRepo = {
  list: () => withSupabase(async (sb) => {
    const { data, error } = await sb.from('sites').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as SiteRow[];
  }, [] as SiteRow[]),

  get: (id: string) => withSupabase(async (sb) => {
    const { data, error } = await sb.from('sites').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data as SiteRow | null;
  }, null),

  upsert: (row: Partial<SiteRow> & { name: string; wp_url: string; owner_id: string }) =>
    withSupabase(async (sb) => {
      const { data, error } = await sb.from('sites').upsert(row).select().single();
      if (error) throw error;
      return data as SiteRow;
    }, null),

  remove: (id: string) => withSupabase(async (sb) => {
    const { error } = await sb.from('sites').delete().eq('id', id);
    if (error) throw error;
    return true;
  }, false),
};

// ─── Pages ───────────────────────────────────────────────────────────
export const PagesRepo = {
  bySite: (site_id: string) => withSupabase(async (sb) => {
    const { data, error } = await sb.from('pages').select('*').eq('site_id', site_id).order('updated_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as PageRow[];
  }, [] as PageRow[]),

  upsertMany: (rows: Array<Partial<PageRow> & { site_id: string; url: string }>) =>
    withSupabase(async (sb) => {
      if (!rows.length) return [];
      const { data, error } = await sb.from('pages').upsert(rows, { onConflict: 'site_id,url' }).select();
      if (error) throw error;
      return (data ?? []) as PageRow[];
    }, [] as PageRow[]),
};

// ─── Keywords ────────────────────────────────────────────────────────
export const KeywordsRepo = {
  bySite: (site_id: string) => withSupabase(async (sb) => {
    const { data, error } = await sb.from('keywords').select('*').eq('site_id', site_id);
    if (error) throw error;
    return (data ?? []) as KeywordRow[];
  }, [] as KeywordRow[]),

  upsertMany: (rows: Array<Partial<KeywordRow> & { site_id: string; keyword: string }>) =>
    withSupabase(async (sb) => {
      if (!rows.length) return [];
      const { data, error } = await sb.from('keywords').upsert(rows, { onConflict: 'site_id,keyword' }).select();
      if (error) throw error;
      return (data ?? []) as KeywordRow[];
    }, [] as KeywordRow[]),
};

// ─── Content Jobs ────────────────────────────────────────────────────
export const JobsRepo = {
  create: (row: Partial<ContentJobRow> & { site_id: string; owner_id: string; type: string }) =>
    withSupabase(async (sb) => {
      const { data, error } = await sb.from('content_jobs').insert({ status: 'queued', ...row }).select().single();
      if (error) throw error;
      return data as ContentJobRow;
    }, null),

  update: (id: string, patch: Partial<ContentJobRow>) =>
    withSupabase(async (sb) => {
      const { data, error } = await sb.from('content_jobs').update(patch).eq('id', id).select().single();
      if (error) throw error;
      return data as ContentJobRow;
    }, null),

  get: (id: string) => withSupabase(async (sb) => {
    const { data, error } = await sb.from('content_jobs').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data as ContentJobRow | null;
  }, null),
};

// ─── Drafts (+ children) ─────────────────────────────────────────────
export interface DraftWithChildrenInsert {
  draft: Partial<DraftRow> & { site_id: string; primary_keyword: string; title: string; html: string };
  sources?: Array<Omit<SourceRow, 'id' | 'draft_id'>>;
  internalLinks?: Array<Omit<InternalLinkRow, 'id' | 'draft_id'>>;
}

export const DraftsRepo = {
  bySite: (site_id: string, limit = 50) => withSupabase(async (sb) => {
    const { data, error } = await sb.from('drafts').select('*')
      .eq('site_id', site_id).order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []) as DraftRow[];
  }, [] as DraftRow[]),

  get: (id: string) => withSupabase(async (sb) => {
    const { data, error } = await sb.from('drafts').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data as DraftRow | null;
  }, null),

  /**
   * Insert a draft + its sources + internal links in one logical operation.
   * Not transactional across tables (Supabase JS lacks tx) — children are inserted after.
   * On child failure the draft remains; caller may retry children with the returned id.
   */
  insertWithChildren: ({ draft, sources, internalLinks }: DraftWithChildrenInsert) =>
    withSupabase(async (sb) => {
      const { data: created, error } = await sb.from('drafts').insert(draft).select().single();
      if (error) throw error;
      const draftRow = created as DraftRow;

      if (sources?.length) {
        const payload = sources.map((s) => ({ ...s, draft_id: draftRow.id }));
        const { error: srcErr } = await sb.from('sources').insert(payload);
        if (srcErr) console.warn('[DraftsRepo] sources insert failed', srcErr.message);
      }
      if (internalLinks?.length) {
        const payload = internalLinks.map((l) => ({ ...l, draft_id: draftRow.id }));
        const { error: linkErr } = await sb.from('internal_links').insert(payload);
        if (linkErr) console.warn('[DraftsRepo] internal_links insert failed', linkErr.message);
      }
      return draftRow;
    }, null),

  update: (id: string, patch: Partial<DraftRow>) =>
    withSupabase(async (sb) => {
      const { data, error } = await sb.from('drafts').update(patch).eq('id', id).select().single();
      if (error) throw error;
      return data as DraftRow;
    }, null),
};

// ─── Publish Logs + Revisions ────────────────────────────────────────
export const PublishLogsRepo = {
  create: (row: Omit<PublishLogRow, 'id' | 'published_at'> & { published_at?: string }) =>
    withSupabase(async (sb) => {
      const { data, error } = await sb.from('publish_logs').insert(row).select().single();
      if (error) throw error;
      return data as PublishLogRow;
    }, null),

  byDraft: (draft_id: string) => withSupabase(async (sb) => {
    const { data, error } = await sb.from('publish_logs').select('*')
      .eq('draft_id', draft_id).order('published_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as PublishLogRow[];
  }, [] as PublishLogRow[]),
};

export const RevisionsRepo = {
  create: (row: Omit<RevisionRow, 'id' | 'created_at'>) =>
    withSupabase(async (sb) => {
      const { data, error } = await sb.from('revisions').insert(row).select().single();
      if (error) throw error;
      return data as RevisionRow;
    }, null),

  byDraft: (draft_id: string) => withSupabase(async (sb) => {
    const { data, error } = await sb.from('revisions').select('*')
      .eq('draft_id', draft_id).order('version', { ascending: false });
    if (error) throw error;
    return (data ?? []) as RevisionRow[];
  }, [] as RevisionRow[]),

  nextVersion: async (draft_id: string): Promise<number> => {
    const list = await RevisionsRepo.byDraft(draft_id);
    return (list[0]?.version ?? 0) + 1;
  },
};

// ─── GSC + Rankings (Phase 2 will populate) ──────────────────────────
export const GscRepo = {
  upsertBatch: (rows: Array<Omit<GscMetricRow, 'id'>>) =>
    withSupabase(async (sb) => {
      if (!rows.length) return 0;
      const { error, count } = await sb.from('gsc_metrics')
        .upsert(rows, { onConflict: 'site_id,page_url,query,date', count: 'exact' });
      if (error) throw error;
      return count ?? 0;
    }, 0),
};

export const RankingsRepo = {
  recordSnapshot: (row: Omit<RankingSnapshotRow, 'id'>) =>
    withSupabase(async (sb) => {
      const { error } = await sb.from('ranking_snapshots')
        .upsert(row, { onConflict: 'site_id,keyword_id,captured_at' });
      if (error) throw error;
      return true;
    }, false),
};
