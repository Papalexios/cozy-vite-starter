// src/lib/sota/factcheck/evidenceBinder.ts
// Phase 4 — Bind extracted claims to verified evidence.
//
// For each `factual` claim we collect candidate URLs (provided by the caller —
// usually the SERP/Reference layer) and verify them via:
//   1. AuthoritativeSourceGate domain whitelist + live HEAD/GET
//   2. Freshness check (Last-Modified header) for time-sensitive topics
//
// Opinion / definitional claims are passed through with status "skipped".

import {
  isAuthoritativeDomain,
  gateReferences,
} from '@/lib/sota/AuthoritativeSourceGate';
import type { Reference } from '@/lib/sota/types';
import type { ExtractedClaim } from './claimExtractor';

export type EvidenceStatus =
  | 'verified'        // passed all required checks
  | 'unverified'      // no evidence URLs survived gating
  | 'insufficient'    // some evidence but below required minimum (YMYL)
  | 'stale'           // evidence URL last-modified older than freshness window
  | 'skipped';        // opinion / definitional

export interface BoundEvidence {
  url: string;
  domain: string;
  httpStatus?: number;
  lastModified?: string | null;
  ageDays?: number | null;
}

export interface BoundClaim {
  claim: ExtractedClaim;
  status: EvidenceStatus;
  evidence: BoundEvidence[];
  /** Human-readable reason (only set when status != 'verified'). */
  reason?: string;
}

export interface BindEvidenceOptions {
  /** Minimum verified URLs per factual claim. Default 1; YMYL bumps to 2. */
  minSourcesPerClaim?: number;
  /** Whether YMYL strictness is on (caller supplies; see ymyl.ts). */
  ymyl?: boolean;
  /** Time-sensitive content → require last-modified within this window. */
  freshnessRequired?: boolean;
  /** Max age allowed when freshnessRequired=true. Default 24 months. */
  maxAgeMonths?: number;
  /** Verification timeout (ms) per URL. Default 6000. */
  timeoutMs?: number;
  /** Concurrency for verification. Default 6. */
  concurrency?: number;
}

export interface CandidateEvidence {
  /** Claim id this candidate belongs to. */
  claimId: string;
  url: string;
  title?: string;
}

/**
 * Bind claims to evidence URLs (caller-supplied, e.g. from SERP per claim).
 * Pure verification — does NOT issue any LLM calls.
 */
export async function bindEvidence(
  claims: ExtractedClaim[],
  candidates: CandidateEvidence[],
  options: BindEvidenceOptions = {},
): Promise<BoundClaim[]> {
  const ymyl              = !!options.ymyl;
  const minRequired       = options.minSourcesPerClaim ?? (ymyl ? 2 : 1);
  const freshnessRequired = !!options.freshnessRequired;
  const maxAgeMonths      = options.maxAgeMonths ?? 24;
  const timeoutMs         = options.timeoutMs ?? 6000;
  const concurrency       = options.concurrency ?? 6;

  // Group candidates by claim id
  const byClaim = new Map<string, CandidateEvidence[]>();
  for (const c of candidates) {
    if (!byClaim.has(c.claimId)) byClaim.set(c.claimId, []);
    byClaim.get(c.claimId)!.push(c);
  }

  const out: BoundClaim[] = [];
  for (const claim of claims) {
    if (claim.type !== 'factual') {
      out.push({ claim, status: 'skipped', evidence: [] });
      continue;
    }

    const cands = byClaim.get(claim.id) ?? [];
    if (cands.length === 0) {
      out.push({ claim, status: 'unverified', evidence: [], reason: 'no candidate sources' });
      continue;
    }

    // Pre-filter to whitelist (cheap) before live HEAD checks.
    const refLike: Reference[] = cands
      .filter((c) => isAuthoritativeDomain(c.url))
      .map((c) => ({
        title: c.title ?? c.url,
        url: c.url,
        type: 'industry',
        domain: hostOf(c.url),
        authorityScore: 80,
      }));

    if (refLike.length === 0) {
      out.push({ claim, status: 'unverified', evidence: [], reason: 'no candidate on whitelist' });
      continue;
    }

    const { kept } = await gateReferences(refLike, { timeoutMs, concurrency, allowOnCorsFailure: true });
    if (kept.length === 0) {
      out.push({ claim, status: 'unverified', evidence: [], reason: 'live verification failed' });
      continue;
    }

    // Freshness probe (optional). Best-effort: ignore failures, treat unknown as fresh.
    const evidence: BoundEvidence[] = [];
    for (const k of kept) {
      const meta = freshnessRequired ? await probeFreshness(k.url, timeoutMs) : { lastModified: null, ageDays: null };
      evidence.push({
        url: k.url,
        domain: k.domain,
        lastModified: meta.lastModified,
        ageDays: meta.ageDays,
      });
    }

    if (freshnessRequired) {
      const maxAgeDays = Math.floor(maxAgeMonths * 30.44);
      const fresh = evidence.filter((e) => e.ageDays == null || e.ageDays <= maxAgeDays);
      if (fresh.length < minRequired) {
        out.push({
          claim,
          status: 'stale',
          evidence,
          reason: `requires ${minRequired} fresh source(s) (<${maxAgeMonths}mo); got ${fresh.length}`,
        });
        continue;
      }
    }

    if (evidence.length < minRequired) {
      out.push({
        claim,
        status: 'insufficient',
        evidence,
        reason: `requires ${minRequired} verified source(s); got ${evidence.length}`,
      });
      continue;
    }

    out.push({ claim, status: 'verified', evidence });
  }

  return out;
}

// ─── helpers ─────────────────────────────────────────────────────────

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

async function probeFreshness(url: string, timeoutMs: number): Promise<{ lastModified: string | null; ageDays: number | null }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    } catch {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { Range: 'bytes=0-1023' } });
    }
    const lm = res.headers.get('last-modified');
    if (!lm) return { lastModified: null, ageDays: null };
    const ts = Date.parse(lm);
    if (Number.isNaN(ts)) return { lastModified: lm, ageDays: null };
    const ageDays = Math.floor((Date.now() - ts) / 86_400_000);
    return { lastModified: lm, ageDays };
  } catch {
    return { lastModified: null, ageDays: null };
  } finally {
    clearTimeout(t);
  }
}
