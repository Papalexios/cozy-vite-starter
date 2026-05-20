// src/lib/db/semanticCache.ts
// Phase 7 — Supabase-backed semantic cache for SERP scrapes.
// All operations are best-effort: callers must handle null gracefully.

import { withSupabase } from '@/lib/supabaseClient';
import type { SERPResult } from '@/lib/sota/types';

export interface SerpCachePayload {
  serp: SERPResult[];
  snippets: string[];
}

export interface CachedSerpHit {
  id: string;
  keyword: string;
  payload: SerpCachePayload;
  fetched_at: string;
  similarity: number;
}

export async function getCachedSerpByEmbedding(
  embedding: number[],
  opts?: { threshold?: number; maxAgeDays?: number; country?: string }
): Promise<CachedSerpHit | null> {
  if (!embedding || embedding.length === 0) return null;
  return withSupabase(async (sb) => {
    const { data, error } = await sb.rpc('match_serp_cache', {
      query_embedding: embedding,
      similarity_threshold: opts?.threshold ?? 0.92,
      max_age_days: opts?.maxAgeDays ?? 7,
      match_country: opts?.country ?? 'us',
    });
    if (error) {
      console.warn('[semanticCache] match_serp_cache failed:', error.message);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return row ? (row as CachedSerpHit) : null;
  }, null);
}

export async function putCachedSerp(
  keyword: string,
  embedding: number[],
  payload: SerpCachePayload,
  country: string = 'us'
): Promise<boolean> {
  if (!keyword || !embedding?.length) return false;
  return withSupabase(async (sb) => {
    const { error } = await sb.from('serp_cache').insert({
      keyword,
      country,
      embedding,
      payload,
    });
    if (error) {
      console.warn('[semanticCache] putCachedSerp failed:', error.message);
      return false;
    }
    return true;
  }, false);
}

export interface InformationGainRunRow {
  site_id?: string | null;
  keyword: string;
  keyword_embedding?: number[] | null;
  lift_score: number;
  blindspots: string[];
  missing_entities: Array<{ name: string; wikidataUrl?: string }>;
  contrarian_angles: string[];
  competitor_urls: string[];
}

export async function recordInformationGainRun(row: InformationGainRunRow): Promise<string | null> {
  return withSupabase(async (sb) => {
    const { data, error } = await sb
      .from('information_gain_runs')
      .insert(row)
      .select('id')
      .single();
    if (error) {
      console.warn('[semanticCache] recordInformationGainRun failed:', error.message);
      return null;
    }
    return (data?.id as string) ?? null;
  }, null);
}
