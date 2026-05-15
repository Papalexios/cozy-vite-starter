// src/lib/sota/factcheck/ymyl.ts
// Phase 4 — YMYL (Your Money / Your Life) auto-detection.
// Triggers stricter evidence rules (≥2 verified sources per factual claim).

const YMYL_KEYWORDS: ReadonlyArray<RegExp> = [
  // Health / medical
  /\b(health|medical|medicine|disease|symptom|diagnos|treatment|therapy|drug|dosage|prescription|surgery|cancer|diabetes|cardio|mental health|depression|anxiety|covid|vaccine|nutrition|diet|supplement|pregnan|baby|infant|fertilit)\w*\b/i,
  // Finance / legal
  /\b(invest|stock|crypto|loan|mortgage|tax|insurance|retire|pension|bankrupt|legal|lawyer|attorney|lawsuit|contract|will|estate|tariff|regulation|compliance|gdpr|hipaa)\w*\b/i,
  // Safety
  /\b(safety|hazard|toxic|poison|emergency|first aid|cpr|fire|electrical|firearm|child safety)\w*\b/i,
  // Civic / news
  /\b(election|voting|government|policy|immigration|asylum)\w*\b/i,
];

export interface YmylDetectionInput {
  primaryKeyword?: string;
  secondaryKeywords?: string[];
  category?: string;
  sampleText?: string; // first ~500 chars of article
}

export interface YmylDetectionResult {
  isYmyl: boolean;
  confidence: number;     // 0–1
  matchedTerms: string[]; // unique trigger terms found
}

export function detectYmyl(input: YmylDetectionInput): YmylDetectionResult {
  const haystack = [
    input.primaryKeyword ?? '',
    ...(input.secondaryKeywords ?? []),
    input.category ?? '',
    (input.sampleText ?? '').slice(0, 500),
  ].join(' \n ');

  const matched = new Set<string>();
  for (const re of YMYL_KEYWORDS) {
    const m = haystack.match(re);
    if (m) matched.add(m[0].toLowerCase());
  }

  const hits = matched.size;
  const isYmyl = hits >= 1;
  // Confidence scales with distinct trigger terms (capped at ~0.95).
  const confidence = isYmyl ? Math.min(0.95, 0.55 + 0.1 * hits) : 0;

  return { isYmyl, confidence, matchedTerms: [...matched] };
}
