// src/lib/gsc/client.ts
// Phase 2 - Thin browser client over the gsc-proxy edge function.

import { getSupabaseConfig } from '@/lib/supabaseClient';

export interface GscRow {
  keys: string[];          // dimension values, in the order requested
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsParams {
  siteUrl: string;
  startDate: string;       // YYYY-MM-DD
  endDate: string;         // YYYY-MM-DD
  dimensions?: Array<'query' | 'page' | 'date' | 'country' | 'device' | 'searchAppearance'>;
  rowLimit?: number;
  startRow?: number;
  searchType?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
  dataState?: 'all' | 'final';
}

async function callProxy(action: string, body: Record<string, unknown> = {}) {
  const { url, anonKey, configured } = getSupabaseConfig();
  if (!configured) throw new Error('Supabase not configured');
  const res = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/gsc-proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey,
      'Authorization': `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string })?.error || `gsc-proxy HTTP ${res.status}`);
  return data;
}

export const GscClient = {
  status: () => callProxy('status'),
  listSites: () => callProxy('listSites') as Promise<{ sites: Array<{ siteUrl: string; permissionLevel: string }> }>,

  /** Page through all rows for the requested window. Default page size 5000. */
  async fetchAllRows(params: SearchAnalyticsParams): Promise<GscRow[]> {
    const pageSize = params.rowLimit ?? 5000;
    const out: GscRow[] = [];
    let startRow = params.startRow ?? 0;
    for (let page = 0; page < 50; page++) {           // hard cap = 250k rows / window
      const data = (await callProxy('searchAnalytics', { ...params, startRow, rowLimit: pageSize })) as { rows?: GscRow[] };
      const rows = data.rows ?? [];
      out.push(...rows);
      if (rows.length < pageSize) break;
      startRow += pageSize;
    }
    return out;
  },
};
