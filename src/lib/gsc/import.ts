// src/lib/gsc/import.ts
// Phase 2 - Import GSC search analytics into the gsc_metrics table.
// Backfill window default: 90 days (Google retains 16 months; backfill is chunked by month).

import { GscClient } from './client';
import { GscRepo } from '@/lib/db';
import type { GscMetricRow } from '@/lib/db';

export interface ImportProgress {
  windowsTotal: number;
  windowsDone: number;
  rowsImported: number;
  currentRange?: { start: string; end: string };
}

export interface ImportResult {
  rowsImported: number;
  windows: number;
  startedAt: string;
  finishedAt: string;
  errors: string[];
}

const DAY_MS = 86_400_000;
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Split a [start, end] range into 30-day windows (inclusive). */
function chunkByMonth(start: Date, end: Date): Array<{ start: string; end: string }> {
  const windows: Array<{ start: string; end: string }> = [];
  let cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    const winEnd = new Date(Math.min(cursor.getTime() + 29 * DAY_MS, end.getTime()));
    windows.push({ start: ymd(cursor), end: ymd(winEnd) });
    cursor = new Date(winEnd.getTime() + DAY_MS);
  }
  return windows;
}

/**
 * Import GSC search-analytics rows for a given site over the last `days` days.
 * Dimensions are fixed to ['date','page','query'] so each row maps to a unique (date,page,query) key.
 */
export async function importGscWindow(args: {
  site_id: string;
  siteUrl: string;             // GSC property URL ("https://example.com/" or "sc-domain:example.com")
  days?: number;               // default 90, max 480 (16mo)
  onProgress?: (p: ImportProgress) => void;
}): Promise<ImportResult> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const days = Math.max(1, Math.min(args.days ?? 90, 480));
  const end = new Date(Date.now() - 2 * DAY_MS);     // GSC has ~2 day lag
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  const windows = chunkByMonth(start, end);

  let rowsImported = 0;

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    args.onProgress?.({ windowsTotal: windows.length, windowsDone: i, rowsImported, currentRange: w });
    try {
      const rows = await GscClient.fetchAllRows({
        siteUrl: args.siteUrl,
        startDate: w.start,
        endDate: w.end,
        dimensions: ['date', 'page', 'query'],
      });

      // Map to gsc_metrics rows. keys = [date, page, query].
      const payload: Array<Omit<GscMetricRow, 'id'>> = rows
        .filter((r) => r.keys?.length === 3)
        .map((r) => ({
          site_id: args.site_id,
          date: r.keys[0],
          page_url: r.keys[1],
          query: r.keys[2],
          impressions: Math.round(r.impressions || 0),
          clicks: Math.round(r.clicks || 0),
          ctr: Number(r.ctr || 0),
          position: Number(r.position || 0),
        }));

      // Upsert in chunks of 1000 so we don't blow request size
      for (let j = 0; j < payload.length; j += 1000) {
        const slice = payload.slice(j, j + 1000);
        const n = await GscRepo.upsertBatch(slice);
        rowsImported += n || slice.length;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`[${w.start}..${w.end}] ${msg}`);
      // Continue with next window — partial backfill is better than total failure.
    }
  }

  args.onProgress?.({ windowsTotal: windows.length, windowsDone: windows.length, rowsImported });

  return {
    rowsImported,
    windows: windows.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    errors,
  };
}
