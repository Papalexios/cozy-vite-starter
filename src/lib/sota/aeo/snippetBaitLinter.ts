// src/lib/sota/aeo/snippetBaitLinter.ts
// Phase 9 — AEO Snippet-Bait Linter
//
// Scans rendered article HTML for non-AEO-friendly patterns:
//   • First paragraph under H2/H3 that doesn't directly answer the heading
//     (definition / direct answer / list-bait / table-bait / step-bait).
//   • Paragraphs > 60 words at the top of a section (kills snippet eligibility).
//   • Headings phrased as questions without a paragraph answer below.
//   • H2s with no scannable structure (no <ul>, <ol>, <table>, <strong>, <em>).
//
// Output is a list of `LintIssue`s consumed by AEOLinterPanel + an aggregate
// score (0-100). Pure DOM-string parsing — no LLM call.

export type LintSeverity = 'error' | 'warn' | 'info';

export type LintRule =
  | 'first-paragraph-too-long'
  | 'first-paragraph-not-direct-answer'
  | 'question-heading-without-answer'
  | 'section-missing-scannable-structure'
  | 'list-bait-missing'
  | 'tldr-missing';

export interface LintIssue {
  rule: LintRule;
  severity: LintSeverity;
  headingText: string;
  headingLevel: number;
  excerpt: string;
  recommendation: string;
}

export interface LintReport {
  score: number;            // 0-100 — higher = more snippet-eligible
  issues: LintIssue[];
  totalSections: number;
  sectionsWithLeadAnswer: number;
  hasTLDR: boolean;
  generatedAt: number;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function isQuestion(text: string): boolean {
  const t = text.toLowerCase().trim();
  return (
    t.endsWith('?') ||
    /^(what|why|how|when|where|who|which|is|are|can|should|do|does)\b/.test(t)
  );
}

/**
 * Heuristic: does the first paragraph after `headingText` directly answer it?
 *  - starts with a definition ("X is/are…")
 *  - starts with a direct verb answer for question headings ("Yes,", "No,", "To do X,")
 *  - contains the key noun from the heading within the first 25 words
 */
function isDirectAnswer(headingText: string, paragraph: string): boolean {
  const p = paragraph.trim();
  if (!p) return false;
  const firstSentence = p.split(/(?<=[.!?])\s+/)[0] || p;
  const opening = firstSentence.toLowerCase();

  // Definition pattern: "X is/are/refers to/means…"
  if (/^\s*[a-z][^.?!]{2,80}\s+(is|are|refers to|means|stands for|describes)\b/i.test(firstSentence)) {
    return true;
  }
  // Direct yes/no/imperative answer
  if (/^(yes|no|maybe|sometimes|generally|usually|typically|to\s+\w+,|here'?s|the\s+(short|quick)\s+answer)\b/i.test(opening)) {
    return true;
  }
  // Keyword echo: noun phrase from the heading appears in the first 25 words
  const headingTokens = headingText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3 && !STOP.has(t));
  if (!headingTokens.length) return false;
  const lead = p.toLowerCase().split(/\s+/).slice(0, 25).join(' ');
  return headingTokens.some((t) => lead.includes(t));
}

const STOP = new Set([
  'what', 'why', 'how', 'when', 'where', 'with', 'about', 'their', 'there',
  'these', 'those', 'than', 'that', 'this', 'your', 'they', 'them',
  'from', 'into', 'over', 'such', 'will', 'shall', 'should',
]);

// ─── core lint ────────────────────────────────────────────────────────────────

interface Section {
  level: number;
  heading: string;
  body: string;        // raw HTML between this heading and the next H2/H3
}

function splitSections(html: string): Section[] {
  const sections: Section[] = [];
  const headingRegex = /<(h[23])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const matches: Array<{ level: number; heading: string; idx: number; endIdx: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(html)) !== null) {
    matches.push({
      level: m[1].toLowerCase() === 'h2' ? 2 : 3,
      heading: stripTags(m[2]),
      idx: m.index,
      endIdx: m.index + m[0].length,
    });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].endIdx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : html.length;
    sections.push({
      level: matches[i].level,
      heading: matches[i].heading,
      body: html.slice(start, end),
    });
  }
  return sections;
}

function firstParagraph(body: string): string {
  const m = body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  return m ? stripTags(m[1]) : '';
}

function sectionHasStructure(body: string): boolean {
  return /<(ul|ol|table|dl|blockquote)\b/i.test(body) ||
         /<p\b[^>]*>[\s\S]{0,400}<(strong|b)\b/i.test(body);
}

const TLDR_PATTERNS = /(tl;?dr|short\s+answer|quick\s+answer|key\s+takeaways?|in\s+brief)/i;

export function lintSnippetBait(html: string): LintReport {
  const issues: LintIssue[] = [];
  const sections = splitSections(html);
  const hasTLDR = TLDR_PATTERNS.test(html);

  let sectionsWithLeadAnswer = 0;

  for (const sec of sections) {
    const firstPara = firstParagraph(sec.body);

    if (!firstPara) {
      issues.push({
        rule: 'first-paragraph-not-direct-answer',
        severity: 'warn',
        headingText: sec.heading,
        headingLevel: sec.level,
        excerpt: '(no paragraph found under heading)',
        recommendation: 'Add a 30-55 word direct-answer paragraph immediately after the heading.',
      });
      continue;
    }

    const wc = wordCount(firstPara);

    if (wc > 60) {
      issues.push({
        rule: 'first-paragraph-too-long',
        severity: 'warn',
        headingText: sec.heading,
        headingLevel: sec.level,
        excerpt: firstPara.slice(0, 180) + (firstPara.length > 180 ? '…' : ''),
        recommendation: `Trim to ≤55 words for paragraph-snippet eligibility (currently ${wc}).`,
      });
    }

    const direct = isDirectAnswer(sec.heading, firstPara);
    if (direct) sectionsWithLeadAnswer++;

    if (!direct && wc <= 60) {
      issues.push({
        rule: 'first-paragraph-not-direct-answer',
        severity: 'error',
        headingText: sec.heading,
        headingLevel: sec.level,
        excerpt: firstPara.slice(0, 180) + (firstPara.length > 180 ? '…' : ''),
        recommendation: 'Lead with a definition or direct answer that echoes the heading\'s noun phrase.',
      });
    }

    if (isQuestion(sec.heading) && !direct) {
      issues.push({
        rule: 'question-heading-without-answer',
        severity: 'error',
        headingText: sec.heading,
        headingLevel: sec.level,
        excerpt: firstPara.slice(0, 180),
        recommendation: 'Question headings should be followed by a 1-2 sentence direct answer.',
      });
    }

    if (!sectionHasStructure(sec.body)) {
      issues.push({
        rule: 'section-missing-scannable-structure',
        severity: 'info',
        headingText: sec.heading,
        headingLevel: sec.level,
        excerpt: '(prose only — no list/table/bold cue)',
        recommendation: 'Add a <ul>, <ol>, <table>, or <strong> emphasis to make the section scannable.',
      });
    }
  }

  if (!hasTLDR) {
    issues.push({
      rule: 'tldr-missing',
      severity: 'warn',
      headingText: 'Article intro',
      headingLevel: 1,
      excerpt: '(no TL;DR / short-answer / key-takeaways block found)',
      recommendation: 'Add a TL;DR or "Short answer" callout near the top — high signal for AI Overviews & voice search.',
    });
  }

  // Score: start at 100, deduct based on issue density.
  let score = 100;
  for (const i of issues) {
    if (i.severity === 'error') score -= 8;
    else if (i.severity === 'warn') score -= 4;
    else score -= 1;
  }
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    issues,
    totalSections: sections.length,
    sectionsWithLeadAnswer,
    hasTLDR,
    generatedAt: Date.now(),
  };
}
