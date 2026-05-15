// src/lib/gsc/sitemapPersist.ts
// Phase 2 - Persist crawled sitemap URLs into the `pages` table for a site.
// Computes a content_hash later (when the URL is actually fetched/refreshed) — for now
// we just record discovery so other features (decay, refresh queue, internal-link engine)
// can rely on a canonical URL list per site.

import { PagesRepo } from '@/lib/db';
import type { PageRow } from '@/lib/db';

export interface PersistSitemapResult {
  upserted: number;
  skipped: number;
}

export async function persistSitemapUrls(
  site_id: string,
  urls: string[],
): Promise<PersistSitemapResult> {
  const now = new Date().toISOString();
  const cleaned = Array.from(new Set(
    urls
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u))
  ));

  if (!cleaned.length) return { upserted: 0, skipped: urls.length };

  // Chunk to avoid huge payloads
  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < cleaned.length; i += CHUNK) {
    const chunk = cleaned.slice(i, i + CHUNK).map<Partial<PageRow> & { site_id: string; url: string }>((url) => ({
      site_id, url, last_crawled_at: now,
    }));
    const rows = await PagesRepo.upsertMany(chunk);
    upserted += rows.length;
  }
  return { upserted, skipped: urls.length - cleaned.length };
}
