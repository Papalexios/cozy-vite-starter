// src/lib/sota/geo/InformationGainEngine.ts
// Phase 7 — GEO Information-Gain engine.
//
// Goal: surface what the user's draft outline MUST add that the top-ranking
// SERP pages already cover (or that NO competitor covers — true gain).
//
// Flow:
//   1. Embed the keyword.
//   2. Look up a similar SERP scrape in the semantic cache (cosine ≥ 0.92).
//   3. On miss, run a fresh SERP fetch via the existing SERPAnalyzer, embed
//      every competitor snippet/title chunk, and write back to cache.
//   4. Compare the user's outline embedding to competitor embeddings, isolate
//      topics covered by ≥2 competitors but NOT by the outline (blindspots),
//      and topics covered by zero competitors (contrarian angles, sourced from
//      the AI-suggested gap list, not invented).
//   5. Compute a 0-100 "lift score": higher = more unique angle vs SERP.

import type { SERPAnalysis, SERPResult } from '../types';
import type { SERPAnalyzer } from '../SERPAnalyzer';
import { embedTexts, embedOne, cosineSimilarity } from './embeddings';
import {
  getCachedSerpByEmbedding,
  putCachedSerp,
  recordInformationGainRun,
} from '@/lib/db/semanticCache';

export interface InformationGainReport {
  keyword: string;
  liftScore: number;                // 0-100
  blindspots: string[];             // competitor topics absent from outline
  missingEntities: Array<{ name: string; wikidataUrl?: string }>;
  contrarianAngles: string[];       // unique angles your outline can own
  competitorUrls: string[];
  cached: boolean;
  generatedAt: string;
}

export interface InformationGainInput {
  keyword: string;
  country?: string;
  /** Outline H2/H3 list + meta description + draft summary if available. */
  outlineChunks: string[];
  /** Existing SERP analysis (Phase 0 output). Used to seed entities + gaps. */
  serpAnalysis?: SERPAnalysis | null;
  /** When cache misses, this analyzer is used to fetch fresh SERP. */
  serpAnalyzer?: SERPAnalyzer | null;
  siteId?: string | null;
}

const CACHE_THRESHOLD = 0.92;
const CACHE_MAX_AGE_DAYS = 7;
const SNIPPET_TOP_K = 8;

function chunkFromSerp(serp: SERPResult[]): string[] {
  return serp.slice(0, SNIPPET_TOP_K).map((r) => {
    const title = (r.title || '').trim();
    const snip = (r.snippet || '').trim();
    return [title, snip].filter(Boolean).join(' — ').slice(0, 500);
  }).filter(s => s.length > 20);
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

export async function runInformationGain(input: InformationGainInput): Promise<InformationGainReport> {
  const keyword = (input.keyword || '').trim();
  const country = input.country || 'us';
  const generatedAt = new Date().toISOString();

  // 1. Embed keyword (used as cache key)
  const keywordEmbedding = await embedOne(keyword).catch(() => null);

  // 2. Cache lookup
  let cachedHit = null;
  if (keywordEmbedding) {
    cachedHit = await getCachedSerpByEmbedding(keywordEmbedding, {
      threshold: CACHE_THRESHOLD,
      maxAgeDays: CACHE_MAX_AGE_DAYS,
      country,
    });
  }

  let competitorChunks: string[];
  let serpResults: SERPResult[];
  let cached = false;

  if (cachedHit) {
    competitorChunks = cachedHit.payload.snippets || [];
    serpResults = cachedHit.payload.serp || [];
    cached = true;
  } else {
    // 3a. Fresh fetch from existing analyzer if provided
    serpResults = [];
    if (input.serpAnalyzer) {
      try {
        serpResults = await input.serpAnalyzer.fetchSERP(keyword, country);
      } catch (e) {
        console.warn('[InformationGain] SERP fetch failed:', e);
      }
    }
    competitorChunks = chunkFromSerp(serpResults);

    // 3b. Persist for next time
    if (keywordEmbedding && competitorChunks.length > 0) {
      void putCachedSerp(keyword, keywordEmbedding, { serp: serpResults, snippets: competitorChunks }, country);
    }
  }

  // 4. Embed competitor chunks + outline
  let competitorVecs: number[][] = [];
  let outlineVecs: number[][] = [];
  try {
    [competitorVecs, outlineVecs] = await Promise.all([
      competitorChunks.length ? embedTexts(competitorChunks) : Promise.resolve([] as number[][]),
      input.outlineChunks.length ? embedTexts(input.outlineChunks) : Promise.resolve([] as number[][]),
    ]);
  } catch (e) {
    console.warn('[InformationGain] embed failed:', e);
  }

  // 5. Blindspots = competitor chunks whose max-sim to outline is LOW
  const blindspots: string[] = [];
  const COVERAGE_THRESHOLD = 0.72;
  competitorChunks.forEach((chunk, i) => {
    const v = competitorVecs[i];
    if (!v) return;
    let maxSim = 0;
    for (const ov of outlineVecs) {
      const s = cosineSimilarity(v, ov);
      if (s > maxSim) maxSim = s;
    }
    if (maxSim < COVERAGE_THRESHOLD) blindspots.push(chunk);
  });

  // 6. Missing entities from Phase 0 SERP analysis that aren't in outline text
  const outlineHaystack = input.outlineChunks.join(' \n ').toLowerCase();
  const semEntities = (input.serpAnalysis?.semanticEntities || []) as string[];
  const missingEntities = semEntities
    .filter((e) => e && !outlineHaystack.includes(e.toLowerCase()))
    .slice(0, 20)
    .map((name) => ({ name }));

  // 7. Contrarian angles = SERP content gaps the user could OWN
  const contrarianAngles = (input.serpAnalysis?.contentGaps || [])
    .filter((g) => g && !outlineHaystack.includes(g.toLowerCase()))
    .slice(0, 10);

  // 8. Lift score:
  //    base 50 + (10 per unique angle, max 30) + (3 per missing entity surfaced, max 20)
  //    minus penalty for excessive blindspots (-2 each, capped at -30)
  const liftScore = clamp(
    50
    + Math.min(contrarianAngles.length * 10, 30)
    + Math.min(missingEntities.length * 3, 20)
    - Math.min(blindspots.length * 2, 30)
  );

  const report: InformationGainReport = {
    keyword,
    liftScore: Math.round(liftScore),
    blindspots: blindspots.slice(0, 12),
    missingEntities,
    contrarianAngles,
    competitorUrls: serpResults.slice(0, 8).map((r) => r.url).filter(Boolean),
    cached,
    generatedAt,
  };

  // 9. Best-effort persistence (non-blocking)
  void recordInformationGainRun({
    site_id: input.siteId ?? null,
    keyword,
    keyword_embedding: keywordEmbedding ?? null,
    lift_score: report.liftScore,
    blindspots: report.blindspots,
    missing_entities: report.missingEntities,
    contrarian_angles: report.contrarianAngles,
    competitor_urls: report.competitorUrls,
  });

  return report;
}
