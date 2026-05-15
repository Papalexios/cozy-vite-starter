// src/lib/gsc/opportunities.ts
// Phase 2 - Surface real opportunities from imported GSC data.
//
// Three opportunity types:
//   1. striking_distance  — page ranks 5..15 with significant impressions ("almost there")
//   2. ctr_underperformer — top-10 with CTR well below the position-expected curve
//   3. cannibalization    — same query has 2+ ranking URLs on the same site

import { withSupabase } from '@/lib/supabaseClient';

export type OpportunityKind = 'striking_distance' | 'ctr_underperformer' | 'cannibalization';

export interface Opportunity {
  kind: OpportunityKind;
  query: string;
  page_url: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  expected_ctr?: number;
  ctr_delta?: number;
  competing_urls?: string[];
  score: number;             // higher = bigger opportunity
}

/** Empirical SERP CTR curve (web). Position → expected CTR. */
const CTR_CURVE: Record<number, number> = {
  1: 0.272, 2: 0.157, 3: 0.110, 4: 0.080, 5: 0.061,
  6: 0.048, 7: 0.038, 8: 0.030, 9: 0.024, 10: 0.020,
};

function expectedCtr(position: number): number {
  const p = Math.round(position);
  if (p < 1) return CTR_CURVE[1];
  if (p > 10) return 0.012;
  return CTR_CURVE[p] ?? 0.015;
}

interface AggregatedRow {
  query: string;
  page_url: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

/** Aggregate the last `days` of gsc_metrics for one site. */
async function aggregate(site_id: string, days: number): Promise<AggregatedRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return withSupabase(async (sb) => {
    const { data, error } = await sb
      .from('gsc_metrics')
      .select('query,page_url,impressions,clicks,position')
      .eq('site_id', site_id)
      .gte('date', since);
    if (error) throw error;

    // Aggregate by (query, page_url)
    const map = new Map<string, AggregatedRow>();
    for (const r of (data ?? []) as Array<{ query: string; page_url: string; impressions: number; clicks: number; position: number }>) {
      const key = `${r.query}\u0001${r.page_url}`;
      const cur = map.get(key);
      if (!cur) {
        map.set(key, {
          query: r.query,
          page_url: r.page_url,
          impressions: r.impressions,
          clicks: r.clicks,
          position: r.position * Math.max(r.impressions, 1),
          ctr: 0,
        });
      } else {
        cur.impressions += r.impressions;
        cur.clicks += r.clicks;
        cur.position += r.position * Math.max(r.impressions, 1);
      }
    }
    // Finalise position (impression-weighted) + ctr
    const out: AggregatedRow[] = [];
    for (const v of map.values()) {
      const totImp = Math.max(v.impressions, 1);
      out.push({
        ...v,
        position: v.position / totImp,
        ctr: v.clicks / totImp,
      });
    }
    return out;
  }, [] as AggregatedRow[]);
}

export async function findOpportunities(args: {
  site_id: string;
  days?: number;
  minImpressions?: number;
  limit?: number;
}): Promise<Opportunity[]> {
  const days = args.days ?? 28;
  const minImpressions = args.minImpressions ?? 50;
  const limit = args.limit ?? 50;

  const rows = await aggregate(args.site_id, days);
  const opps: Opportunity[] = [];

  // 1. Striking distance — position 5..15, decent impressions
  for (const r of rows) {
    if (r.impressions < minImpressions) continue;
    if (r.position >= 5 && r.position <= 15) {
      const score = Math.round(r.impressions * (15 - r.position));
      opps.push({
        kind: 'striking_distance', query: r.query, page_url: r.page_url,
        impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position,
        score,
      });
    }
  }

  // 2. CTR underperformers — top-10 with CTR below expected curve by 30%+
  for (const r of rows) {
    if (r.impressions < minImpressions) continue;
    if (r.position > 10) continue;
    const exp = expectedCtr(r.position);
    const delta = exp - r.ctr;
    if (delta / exp >= 0.30) {
      const score = Math.round(r.impressions * delta * 100);
      opps.push({
        kind: 'ctr_underperformer', query: r.query, page_url: r.page_url,
        impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position,
        expected_ctr: exp, ctr_delta: delta, score,
      });
    }
  }

  // 3. Cannibalization — same query → multiple URLs (>=2) with non-trivial impressions
  const byQuery = new Map<string, AggregatedRow[]>();
  for (const r of rows) {
    if (r.impressions < minImpressions / 2) continue;
    const arr = byQuery.get(r.query) ?? [];
    arr.push(r);
    byQuery.set(r.query, arr);
  }
  for (const [query, urls] of byQuery) {
    if (urls.length < 2) continue;
    const totImp = urls.reduce((s, u) => s + u.impressions, 0);
    urls.sort((a, b) => b.impressions - a.impressions);
    const primary = urls[0];
    opps.push({
      kind: 'cannibalization', query, page_url: primary.page_url,
      impressions: primary.impressions, clicks: primary.clicks, ctr: primary.ctr, position: primary.position,
      competing_urls: urls.slice(1).map((u) => u.page_url),
      score: Math.round(totImp * (urls.length - 1)),
    });
  }

  return opps.sort((a, b) => b.score - a.score).slice(0, limit);
}
