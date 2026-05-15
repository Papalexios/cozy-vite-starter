// src/lib/feedback/refreshCalendar.ts
// Phase 6 — Scored backlog of pages to rewrite.
//
// Combines:
//   * Phase 6 decay signals
//   * Phase 2 GSC opportunities (striking distance / CTR / cannibalization)
//   * pages.last_crawled_at age (stale > 180d)
//
// Output is sorted descending by composite score so the dashboard can show
// "what to refresh next".

import { withSupabase } from '@/lib/supabaseClient';
import { detectDecay, type DecayItem } from './decay';
import { findOpportunities, type Opportunity } from '@/lib/gsc/opportunities';

export interface RefreshCandidate {
  page_url: string;
  title?: string | null;
  score: number;
  reasons: string[];
  signals: {
    decay?: DecayItem;
    opportunities?: Opportunity[];
    staleDays?: number;
  };
  recommendedAction: 'rewrite' | 'optimize_meta' | 'merge' | 'expand';
}

interface PageRow { url: string; title: string | null; last_crawled_at: string | null }

export async function buildRefreshCalendar(args: {
  site_id: string;
  limit?: number;
}): Promise<RefreshCandidate[]> {
  const limit = args.limit ?? 25;

  const [decay, opps, pages] = await Promise.all([
    detectDecay({ site_id: args.site_id }),
    findOpportunities({ site_id: args.site_id, limit: 200 }),
    withSupabase(async (sb) => {
      const { data, error } = await sb.from('pages')
        .select('url,title,last_crawled_at')
        .eq('site_id', args.site_id);
      if (error) throw error;
      return (data ?? []) as PageRow[];
    }, [] as PageRow[]),
  ]);

  const pageMap = new Map<string, PageRow>();
  for (const p of pages) pageMap.set(p.url, p);

  const candidates = new Map<string, RefreshCandidate>();

  const ensure = (url: string): RefreshCandidate => {
    let c = candidates.get(url);
    if (!c) {
      const page = pageMap.get(url);
      const staleDays = page?.last_crawled_at
        ? Math.floor((Date.now() - new Date(page.last_crawled_at).getTime()) / 86_400_000)
        : undefined;
      c = {
        page_url: url,
        title: page?.title ?? null,
        score: 0,
        reasons: [],
        signals: { staleDays },
        recommendedAction: 'rewrite',
      };
      if (staleDays != null && staleDays > 180) {
        c.score += Math.min(40, (staleDays - 180) / 5);
        c.reasons.push(`Stale ${staleDays}d`);
      }
      candidates.set(url, c);
    }
    return c;
  };

  for (const d of decay) {
    const c = ensure(d.page_url);
    c.signals.decay = d;
    const weight = d.severity === 'high' ? 60 : d.severity === 'medium' ? 35 : 15;
    c.score += weight;
    c.reasons.push(d.kind === 'position_drop'
      ? `Rank ${d.previous}→${d.current}`
      : `Impressions -${Math.abs(Math.round(d.delta * 100))}%`);
    c.recommendedAction = 'rewrite';
  }

  const oppsByUrl = new Map<string, Opportunity[]>();
  for (const o of opps) {
    const arr = oppsByUrl.get(o.page_url) ?? [];
    arr.push(o);
    oppsByUrl.set(o.page_url, arr);
  }
  for (const [url, list] of oppsByUrl) {
    const c = ensure(url);
    c.signals.opportunities = list;
    for (const o of list) {
      if (o.kind === 'striking_distance') {
        c.score += Math.min(50, Math.log10(o.score + 1) * 12);
        c.reasons.push(`Striking distance "${o.query}" pos ${o.position.toFixed(1)}`);
        if (c.recommendedAction === 'rewrite') c.recommendedAction = 'expand';
      } else if (o.kind === 'ctr_underperformer') {
        c.score += Math.min(30, Math.log10(o.score + 1) * 8);
        c.reasons.push(`Low CTR "${o.query}"`);
        c.recommendedAction = 'optimize_meta';
      } else if (o.kind === 'cannibalization') {
        c.score += Math.min(40, Math.log10(o.score + 1) * 10);
        c.reasons.push(`Cannibalises "${o.query}" with ${o.competing_urls?.length ?? 0} URLs`);
        c.recommendedAction = 'merge';
      }
    }
  }

  return Array.from(candidates.values())
    .map((c) => ({ ...c, score: Math.round(c.score) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
