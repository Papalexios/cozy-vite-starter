// src/lib/feedback/beforeAfter.ts
// Phase 6 — Before/after ROI snapshot per published draft.
//
// Workflow:
//   1. captureBaseline()  — call right BEFORE publish; stores 28d pre-publish GSC stats
//   2. computeRoi()       — call any time after; reads matching baseline + 28d post stats,
//                          returns deltas to display in a "ROI card".

import { withSupabase } from '@/lib/supabaseClient';

export interface BaselineSnapshot {
  draft_id: string;
  site_id: string;
  page_url: string;
  impressions: number;
  clicks: number;
  ctr: number;
  avg_position: number;
  top_queries: Array<{ query: string; impressions: number; clicks: number; position: number }>;
}

export interface RoiReport {
  draft_id: string;
  page_url: string;
  baseline: { impressions: number; clicks: number; ctr: number; position: number } | null;
  current:  { impressions: number; clicks: number; ctr: number; position: number };
  delta:    { impressions: number; clicks: number; ctr: number; position: number };
  daysSincePublish: number;
}

interface GscRow { query: string; impressions: number; clicks: number; position: number; date: string }

function isoDay(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

async function aggregate(site_id: string, page_url: string, sinceISO: string, untilISO?: string) {
  return withSupabase(async (sb) => {
    let q = sb.from('gsc_metrics')
      .select('query,impressions,clicks,position,date')
      .eq('site_id', site_id)
      .eq('page_url', page_url)
      .gte('date', sinceISO);
    if (untilISO) q = q.lt('date', untilISO);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as GscRow[];
    let imp = 0, clk = 0, posWeighted = 0;
    const byQuery = new Map<string, { impressions: number; clicks: number; position: number; w: number }>();
    for (const r of rows) {
      imp += r.impressions; clk += r.clicks;
      posWeighted += r.position * Math.max(r.impressions, 1);
      const cur = byQuery.get(r.query) ?? { impressions: 0, clicks: 0, position: 0, w: 0 };
      cur.impressions += r.impressions;
      cur.clicks += r.clicks;
      cur.position += r.position * Math.max(r.impressions, 1);
      cur.w += Math.max(r.impressions, 1);
      byQuery.set(r.query, cur);
    }
    const top_queries = Array.from(byQuery.entries())
      .map(([query, v]) => ({ query, impressions: v.impressions, clicks: v.clicks, position: +(v.position / v.w).toFixed(2) }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10);
    return {
      impressions: imp,
      clicks: clk,
      ctr: imp > 0 ? +(clk / imp).toFixed(4) : 0,
      avg_position: imp > 0 ? +(posWeighted / imp).toFixed(2) : 0,
      top_queries,
    };
  }, { impressions: 0, clicks: 0, ctr: 0, avg_position: 0, top_queries: [] as BaselineSnapshot['top_queries'] });
}

/** Capture a 28-day pre-publish baseline. Best-effort, no-op when DB unavailable. */
export async function captureBaseline(args: {
  draft_id: string;
  site_id: string;
  page_url: string;
  windowDays?: number;
}): Promise<BaselineSnapshot | null> {
  const win = args.windowDays ?? 28;
  const since = isoDay(win);
  const agg = await aggregate(args.site_id, args.page_url, since);
  const snap: BaselineSnapshot = {
    draft_id: args.draft_id,
    site_id: args.site_id,
    page_url: args.page_url,
    impressions: agg.impressions,
    clicks: agg.clicks,
    ctr: agg.ctr,
    avg_position: agg.avg_position,
    top_queries: agg.top_queries,
  };
  await withSupabase(async (sb) => {
    const { error } = await sb.from('page_baselines').insert({
      draft_id: snap.draft_id,
      site_id: snap.site_id,
      page_url: snap.page_url,
      window_days: win,
      impressions: snap.impressions,
      clicks: snap.clicks,
      ctr: snap.ctr,
      avg_position: snap.avg_position,
      top_queries: snap.top_queries,
    });
    if (error) console.warn('[feedback] captureBaseline insert failed', error.message);
    return true;
  }, false);
  return snap;
}

/** Compute ROI = post-publish window vs stored baseline. */
export async function computeRoi(args: {
  draft_id: string;
  site_id: string;
  page_url: string;
  publishedAt: string | Date;
  windowDays?: number;
}): Promise<RoiReport> {
  const publishedAt = new Date(args.publishedAt);
  const win = args.windowDays ?? 28;
  const sincePublish = publishedAt.toISOString().slice(0, 10);
  const post = await aggregate(args.site_id, args.page_url, sincePublish);

  const baseline = await withSupabase(async (sb) => {
    const { data, error } = await sb.from('page_baselines')
      .select('impressions,clicks,ctr,avg_position')
      .eq('draft_id', args.draft_id)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as { impressions: number; clicks: number; ctr: number; avg_position: number } | null;
  }, null);

  const days = Math.max(1, Math.floor((Date.now() - publishedAt.getTime()) / 86_400_000));
  return {
    draft_id: args.draft_id,
    page_url: args.page_url,
    baseline: baseline
      ? { impressions: baseline.impressions, clicks: baseline.clicks, ctr: baseline.ctr, position: baseline.avg_position }
      : null,
    current: {
      impressions: post.impressions, clicks: post.clicks, ctr: post.ctr, position: post.avg_position,
    },
    delta: {
      impressions: post.impressions - (baseline?.impressions ?? 0),
      clicks:      post.clicks      - (baseline?.clicks ?? 0),
      ctr:         +(post.ctr - (baseline?.ctr ?? 0)).toFixed(4),
      // position: lower is better; positive delta = improvement
      position: baseline ? +(baseline.avg_position - post.avg_position).toFixed(2) : 0,
    },
    daysSincePublish: days,
  };
}
