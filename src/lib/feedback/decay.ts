// src/lib/feedback/decay.ts
// Phase 6 — Decay detector.
//
// Two complementary signals (both best-effort, return [] when DB empty):
//   1. ranking_snapshots: position drop ≥ minDrop comparing two windows
//   2. gsc_metrics:       impressions drop ≥ pct% comparing two windows
//
// All comparisons use a "current" 28-day window vs an immediately-prior 28-day window.

import { withSupabase } from '@/lib/supabaseClient';

export interface DecayItem {
  page_url: string;
  kind: 'position_drop' | 'impressions_drop';
  current: number;
  previous: number;
  delta: number;          // negative = worse
  severity: 'low' | 'medium' | 'high';
  score: number;          // higher = bigger problem
  query?: string;
}

interface RankingRow { url: string | null; position: number | null; captured_at: string }
interface GscRow { page_url: string; query: string; impressions: number; position: number; date: string }

function isoDay(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function severity(delta: number, kind: DecayItem['kind']): DecayItem['severity'] {
  const abs = Math.abs(delta);
  if (kind === 'position_drop') {
    if (abs >= 8) return 'high';
    if (abs >= 5) return 'medium';
    return 'low';
  }
  // impressions: delta is fractional (-0.5 etc.)
  if (abs >= 0.5) return 'high';
  if (abs >= 0.3) return 'medium';
  return 'low';
}

export async function detectDecay(args: {
  site_id: string;
  windowDays?: number;
  minPositionDrop?: number;
  minImpressionsDropPct?: number;
}): Promise<DecayItem[]> {
  const win = args.windowDays ?? 28;
  const minPosDrop = args.minPositionDrop ?? 3;
  const minImpDrop = args.minImpressionsDropPct ?? 0.20;

  const curStart = isoDay(win);
  const prevStart = isoDay(win * 2);

  const items: DecayItem[] = [];

  // ── 1. Ranking snapshots ───────────────────────────────────────────
  const ranking = await withSupabase(async (sb) => {
    const { data, error } = await sb.from('ranking_snapshots')
      .select('url,position,captured_at')
      .eq('site_id', args.site_id)
      .gte('captured_at', prevStart);
    if (error) throw error;
    return (data ?? []) as RankingRow[];
  }, [] as RankingRow[]);

  if (ranking.length) {
    const byUrl = new Map<string, { cur: number[]; prev: number[] }>();
    for (const r of ranking) {
      if (!r.url || r.position == null) continue;
      const bucket = byUrl.get(r.url) ?? { cur: [], prev: [] };
      (r.captured_at >= curStart ? bucket.cur : bucket.prev).push(r.position);
      byUrl.set(r.url, bucket);
    }
    for (const [url, { cur, prev }] of byUrl) {
      if (!cur.length || !prev.length) continue;
      const avg = (xs: number[]) => xs.reduce((s, n) => s + n, 0) / xs.length;
      const c = avg(cur), p = avg(prev);
      const delta = p - c; // negative if got worse (rank went up = number bigger)
      if (c - p >= minPosDrop) {
        items.push({
          page_url: url, kind: 'position_drop',
          current: +c.toFixed(2), previous: +p.toFixed(2),
          delta: +(p - c).toFixed(2),
          severity: severity(c - p, 'position_drop'),
          score: Math.round((c - p) * 10),
        });
      }
      void delta;
    }
  }

  // ── 2. GSC impressions deltas ──────────────────────────────────────
  const gsc = await withSupabase(async (sb) => {
    const { data, error } = await sb.from('gsc_metrics')
      .select('page_url,query,impressions,position,date')
      .eq('site_id', args.site_id)
      .gte('date', prevStart);
    if (error) throw error;
    return (data ?? []) as GscRow[];
  }, [] as GscRow[]);

  if (gsc.length) {
    const byUrl = new Map<string, { cur: number; prev: number }>();
    for (const r of gsc) {
      const b = byUrl.get(r.page_url) ?? { cur: 0, prev: 0 };
      if (r.date >= curStart) b.cur += r.impressions; else b.prev += r.impressions;
      byUrl.set(r.page_url, b);
    }
    for (const [url, { cur, prev }] of byUrl) {
      if (prev < 50) continue; // ignore low-signal
      const pct = (cur - prev) / prev;
      if (pct <= -minImpDrop) {
        items.push({
          page_url: url, kind: 'impressions_drop',
          current: cur, previous: prev,
          delta: +pct.toFixed(3),
          severity: severity(pct, 'impressions_drop'),
          score: Math.round(Math.abs(pct) * prev),
        });
      }
    }
  }

  return items.sort((a, b) => b.score - a.score);
}
