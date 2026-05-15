// src/lib/sota/factcheck/claimExtractor.ts
// Phase 4 — Atomic claim extraction.
// Input: HTML draft. Output: list of claims tagged factual | opinion | definitional.
// Uses an injected `generator` callback so this module stays free of engine coupling.

import { stripHtml } from '@/lib/sota/sanitize';

export type ClaimType = 'factual' | 'opinion' | 'definitional';

export interface ExtractedClaim {
  /** Stable id within the report (claim_<index>). */
  id: string;
  /** Index of the source paragraph in the draft. */
  paragraphIndex: number;
  /** Atomic, single-fact rewriting of the sentence (one assertion per claim). */
  text: string;
  /** Type tag — only `factual` requires verification. */
  type: ClaimType;
  /** Brief reason from the extractor (helps debugging false positives). */
  rationale?: string;
}

export interface ClaimExtractorGenerator {
  (systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface ExtractClaimsOptions {
  /** Hard cap on claims returned (cost control). Default 60. */
  maxClaims?: number;
  /** Skip very short paragraphs. Default 40 chars. */
  minParagraphChars?: number;
}

const SYSTEM_PROMPT = `You are a strict fact-extraction engine.
Given an article, identify atomic verifiable assertions.
Rules:
- Split compound sentences into ONE assertion per claim.
- Tag each claim:
  * "factual"      — a checkable claim about the world (statistic, event, attribute, study finding).
  * "opinion"      — a value judgement, preference, or recommendation.
  * "definitional" — a definition, term clarification, or restatement of common knowledge.
- IGNORE: headings, navigation, CTAs, marketing fluff, hypotheticals.
- Use the EXACT wording from the source where possible (truncate at 240 chars).
Return ONLY a JSON array of objects: { "p": <paragraph_index>, "text": "...", "type": "factual|opinion|definitional", "why": "<short>" }.
No prose, no markdown, no code fences.`;

/**
 * Extract atomic claims from an HTML draft.
 * Returns [] on parse failure (caller should treat as "no claims" rather than crash the pipeline).
 */
export async function extractClaims(
  html: string,
  generator: ClaimExtractorGenerator,
  options: ExtractClaimsOptions = {},
): Promise<ExtractedClaim[]> {
  const maxClaims = options.maxClaims ?? 60;
  const minChars  = options.minParagraphChars ?? 40;

  const paragraphs = splitParagraphs(html).filter((p) => p.length >= minChars);
  if (paragraphs.length === 0) return [];

  // Number paragraphs so the model can refer back by index.
  const numbered = paragraphs.map((p, i) => `[${i}] ${p}`).join('\n\n');
  const userPrompt =
    `ARTICLE (paragraphs numbered):\n${numbered}\n\n` +
    `Extract up to ${maxClaims} atomic claims. JSON array only.`;

  let raw: string;
  try {
    raw = await generator(SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    console.warn('[claimExtractor] generator failed', err);
    return [];
  }

  const json = extractJsonArray(raw);
  if (!json) return [];

  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedClaim[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    const type = typeof r.type === 'string' ? r.type.toLowerCase() : '';
    const p    = typeof r.p === 'number' ? Math.max(0, Math.floor(r.p)) : 0;
    if (!text) continue;
    if (type !== 'factual' && type !== 'opinion' && type !== 'definitional') continue;

    out.push({
      id: `claim_${out.length}`,
      paragraphIndex: p,
      text: text.slice(0, 240),
      type: type as ClaimType,
      rationale: typeof r.why === 'string' ? r.why.slice(0, 160) : undefined,
    });

    if (out.length >= maxClaims) break;
  }
  return out;
}

// ─── helpers ─────────────────────────────────────────────────────────

function splitParagraphs(html: string): string[] {
  // Cheap server/browser-safe paragraph extractor.
  const blocks = html
    .split(/<\/?(?:p|h[1-6]|li|blockquote)\b[^>]*>/i)
    .map((b) => stripHtml(b).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return blocks;
}

function extractJsonArray(s: string): string | null {
  // Tolerate code fences & leading prose.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf('[');
  const end   = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}
