// src/lib/feedback/topicalAuthority.ts
// Phase 6 — Topical Authority score per site.
//
// Heuristic, GSC-grounded (no paid API):
//   coverage   = distinct queries with ≥ minImpressions in last `windowDays`
//   reach      = log10(total impressions)
//   depth      = pages with ≥1 ranking query / total pages
//   score      = weighted composite, 0..100
//
// When a target entity list is supplied (e.g. SERP entities for the niche),
// `covered` = how many of those entities appear in any ranking query.

import { withSupabase } from '@/lib/supabaseClient';

export interface TopicalAuthorityReport {
  site_id: string;
  score: number;          // 0..100
  distinctQueries: number;
  totalImpressions: number;
  rankingPages: number;
  totalPages: number;
  entityCoverage?: { covered: number; total: number; missing: string[] };
  topGaps: string[];
}

interface GscRow { query: string; page_url: string; impressions: number }

function isoDay(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

export async function scoreTopicalAuthority(args: {
  site_id: string;
  windowDays?: number;
  minImpressions?: number;
  targetEntities?: string[];
  persist?: boolean;
}): Promise<TopicalAuthorityReport> {
  const win = args.windowDays ?? 28;
  const minImp = args.minImpressions ?? 5;
  const since = isoDay(win);

  const gsc = await withSupabase(async (sb) => {
    const { data, error } = await sb.from('gsc_metrics')
      .select('query,page_url,impressions')
      .eq('site_id', args.site_id)
      .gte('date', since);
    if (error) throw error;
    return (data ?? []) as GscRow[];
  }, [] as GscRow[]);

  const totalPages = await withSupabase(async (sb) => {
    const { count, error } = await sb.from('pages')
      .select('id', { count: 'exact', head: true })
      .eq('site_id', args.site_id);
    if (error) throw error;
    return count ?? 0;
  }, 0);

  const queryAgg = new Map<string, number>();
  const rankingPages = new Set<string>();
  let totalImpressions = 0;
  for (const r of gsc) {
    queryAgg.set(r.query, (queryAgg.get(r.query) ?? 0) + r.impressions);
    if (r.impressions > 0) rankingPages.add(r.page_url);
    totalImpressions += r.impressions;
  }
  const distinctQueries = Array.from(queryAgg.values()).filter((v) => v >= minImp).length;

  // Entity coverage (optional)
  let entityCoverage: TopicalAuthorityReport['entityCoverage'];
  if (args.targetEntities?.length) {
    const haystack = Array.from(queryAgg.keys()).join(' \u0001 ').toLowerCase();
    const missing: string[] = [];
    let covered = 0;
    for (const e of args.targetEntities) {
      if (haystack.includes(e.toLowerCase())) covered++;
      else missing.push(e);
    }
    entityCoverage = { covered, total: args.targetEntities.length, missing: missing.slice(0, 25) };
  }

  // Composite score
  const reach = Math.min(1, Math.log10(totalImpressions + 1) / 5);          // 100k imp ≈ 1
  const breadth = Math.min(1, distinctQueries / 500);                       // 500 queries ≈ 1
  const depth = totalPages > 0 ? Math.min(1, rankingPages.size / totalPages) : 0;
  const entityScore = entityCoverage ? entityCoverage.covered / Math.max(1, entityCoverage.total) : breadth;
  const composite = 0.30 * reach + 0.30 * breadth + 0.20 * depth + 0.20 * entityScore;
  const score = Math.round(composite * 100);

  // Top gaps = high-impression queries the site doesn't yet rank well for
  const topGaps = Array.from(queryAgg.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([q]) => q);

  const report: TopicalAuthorityReport = {
    site_id: args.site_id,
    score,
    distinctQueries,
    totalImpressions,
    rankingPages: rankingPages.size,
    totalPages,
    entityCoverage,
    topGaps,
  };

  if (args.persist) {
    await withSupabase(async (sb) => {
      const { error } = await sb.from('topical_authority_snapshots').upsert({
        site_id: args.site_id,
        captured_at: new Date().toISOString().slice(0, 10),
        score,
        entity_count: entityCoverage?.total ?? distinctQueries,
        covered_count: entityCoverage?.covered ?? rankingPages.size,
        details: { topGaps, missing: entityCoverage?.missing ?? [] },
      }, { onConflict: 'site_id,captured_at' });
      if (error) console.warn('[feedback] topical authority persist failed', error.message);
      return true;
    }, false);
  }

  return report;
}
