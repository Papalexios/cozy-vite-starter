// src/lib/sota/aeo/snippetBaitFixer.ts
// Phase 9 — AEO auto-fixer.
// Given the rendered HTML and an optional LintReport, rewrites the first
// paragraph of each flagged section into a ≤55-word direct-answer lead.
// Uses the SOTA engine. Returns updated HTML plus a fix log.

import type { SOTAContentGenerationEngine } from '../SOTAContentGenerationEngine';
import type { AIModel } from '../types';
import { lintSnippetBait, type LintReport } from './snippetBaitLinter';

export interface FixOptions {
  engine: SOTAContentGenerationEngine;
  model: AIModel;
  keyword: string;
  maxFixes?: number;       // default 8 — avoid runaway LLM cost
  timeoutMs?: number;      // per-fix call timeout
}

export interface FixLogEntry {
  heading: string;
  before: string;
  after: string;
}

export interface FixResult {
  html: string;
  beforeReport: LintReport;
  afterReport: LintReport;
  fixes: FixLogEntry[];
}

const FIXER_SYSTEM = `You rewrite the first paragraph under an HTML heading so it qualifies as a Google paragraph snippet:
- 30-55 words, one paragraph, plain prose.
- Lead with a definition or direct answer to the heading.
- Echo the heading's key noun phrase within the first sentence.
- No filler. No "In this section". No transition phrases.
Return ONLY the new paragraph text (no <p> tags, no markdown).`;

export async function fixSnippetBait(html: string, opts: FixOptions): Promise<FixResult> {
  const before = lintSnippetBait(html);
  const target = new Set([
    'first-paragraph-not-direct-answer',
    'first-paragraph-too-long',
    'question-heading-without-answer',
  ]);
  const fixable = before.issues.filter((i) => target.has(i.rule));
  const maxFixes = opts.maxFixes ?? 8;
  const slice = fixable.slice(0, maxFixes);

  let working = html;
  const fixes: FixLogEntry[] = [];

  for (const issue of slice) {
    const headingPattern = new RegExp(
      `(<h${issue.headingLevel}\\b[^>]*>\\s*${escapeRegex(issue.headingText)}\\s*<\\/h${issue.headingLevel}>)\\s*(<p\\b[^>]*>)([\\s\\S]*?)(<\\/p>)`,
      'i'
    );
    const m = working.match(headingPattern);
    if (!m) continue;

    const original = stripTags(m[3]);
    let rewritten = '';
    try {
      const res = await opts.engine.generateWithModel({
        prompt: `HEADING: ${issue.headingText}\nPRIMARY KEYWORD: ${opts.keyword}\nCURRENT PARAGRAPH:\n${original}\n\nRewrite as a 30-55 word direct-answer lead.`,
        systemPrompt: FIXER_SYSTEM,
        model: opts.model,
        apiKeys: {} as any,
        temperature: 0.4,
        maxTokens: 240,
        timeoutMs: opts.timeoutMs ?? 25_000,
        maxRetries: 0,
        allowContinuations: false,
        allowResume: false,
      });
      rewritten = (res?.content || '').trim().replace(/^<p[^>]*>|<\/p>$/gi, '').trim();
    } catch {
      continue;
    }

    if (!rewritten || rewritten.split(/\s+/).length < 12) continue;

    working = working.replace(headingPattern, `$1$2${rewritten}$4`);
    fixes.push({ heading: issue.headingText, before: original, after: rewritten });
  }

  const after = lintSnippetBait(working);
  return { html: working, beforeReport: before, afterReport: after, fixes };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
