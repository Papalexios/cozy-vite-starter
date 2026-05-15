// src/lib/sota/factcheck/factCheckPipeline.ts
// Phase 4 — End-to-end fact-check orchestration.
// Steps:
//   1. detectYmyl()         → strictness flag
//   2. extractClaims()      → atomic claims from HTML
//   3. bindEvidence()       → verify factual claims against candidate URLs
//   4. summarize + decide   → publish gate

import { detectYmyl, type YmylDetectionResult } from './ymyl';
import { extractClaims, type ClaimExtractorGenerator, type ExtractedClaim } from './claimExtractor';
import { bindEvidence, type BoundClaim, type CandidateEvidence } from './evidenceBinder';

export interface FactCheckPipelineInput {
  html: string;
  primaryKeyword: string;
  secondaryKeywords?: string[];
  category?: string;

  /** LLM callback used for claim extraction. */
  generator: ClaimExtractorGenerator;

  /**
   * Caller supplies candidate URLs per claim (typically by querying SERP / NeuronWriter
   * for each `factual` claim). The pipeline does NOT own this lookup so we don't
   * couple to any specific search provider here.
   */
  resolveCandidates?: (claim: ExtractedClaim) => Promise<CandidateEvidence[]>;

  /** Override defaults (auto-detected unless explicit). */
  ymyl?: boolean;
  freshnessRequired?: boolean;
  maxAgeMonths?: number;
  minSourcesPerClaim?: number;
  maxClaims?: number;
}

export interface FactCheckSummary {
  totalClaims: number;
  factualClaims: number;
  verified: number;
  unverified: number;
  insufficient: number;
  stale: number;
  skipped: number;
  /** Hallucination-flag count = factual claims NOT in 'verified'. */
  flagged: number;
}

export interface FactCheckPipelineResult {
  generatedAt: number;
  ymyl: YmylDetectionResult;
  claims: BoundClaim[];
  summary: FactCheckSummary;
  /** Publish gate. False = block publish until user resolves flags. */
  publishAllowed: boolean;
  blockingReasons: string[];
}

export async function runFactCheck(input: FactCheckPipelineInput): Promise<FactCheckPipelineResult> {
  // 1. YMYL detection
  const ymylInput = {
    primaryKeyword: input.primaryKeyword,
    secondaryKeywords: input.secondaryKeywords,
    category: input.category,
    sampleText: input.html.slice(0, 2000),
  };
  const ymyl = detectYmyl(ymylInput);
  const isYmyl = input.ymyl ?? ymyl.isYmyl;

  // 2. Extract claims
  const claims = await extractClaims(input.html, input.generator, { maxClaims: input.maxClaims });

  // 3. Resolve candidates per factual claim (caller-owned)
  const candidates: CandidateEvidence[] = [];
  if (input.resolveCandidates) {
    const factual = claims.filter((c) => c.type === 'factual');
    // Sequential to avoid hammering SERP — caller may parallelize internally if safe.
    for (const c of factual) {
      try {
        const list = await input.resolveCandidates(c);
        for (const cand of list) candidates.push({ ...cand, claimId: c.id });
      } catch (err) {
        console.warn('[factCheckPipeline] resolveCandidates failed for', c.id, err);
      }
    }
  }

  // 4. Bind + verify
  const bound = await bindEvidence(claims, candidates, {
    ymyl: isYmyl,
    freshnessRequired: input.freshnessRequired,
    maxAgeMonths: input.maxAgeMonths,
    minSourcesPerClaim: input.minSourcesPerClaim,
  });

  // 5. Summarize
  const summary: FactCheckSummary = {
    totalClaims: bound.length,
    factualClaims: bound.filter((b) => b.claim.type === 'factual').length,
    verified:     bound.filter((b) => b.status === 'verified').length,
    unverified:   bound.filter((b) => b.status === 'unverified').length,
    insufficient: bound.filter((b) => b.status === 'insufficient').length,
    stale:        bound.filter((b) => b.status === 'stale').length,
    skipped:      bound.filter((b) => b.status === 'skipped').length,
    flagged: 0,
  };
  summary.flagged = summary.unverified + summary.insufficient + summary.stale;

  // 6. Publish gate (YMYL: any flag blocks; non-YMYL: allow with warnings)
  const blockingReasons: string[] = [];
  if (isYmyl && summary.flagged > 0) {
    blockingReasons.push(
      `YMYL content has ${summary.flagged} unverified factual claim(s); resolve before publishing.`,
    );
  }
  const publishAllowed = blockingReasons.length === 0;

  return {
    generatedAt: Date.now(),
    ymyl,
    claims: bound,
    summary,
    publishAllowed,
    blockingReasons,
  };
}
