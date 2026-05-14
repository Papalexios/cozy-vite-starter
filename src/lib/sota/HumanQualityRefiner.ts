import type { AIModel } from './types';
import type { SOTAContentGenerationEngine } from './SOTAContentGenerationEngine';
import { calculateQualityScore } from './QualityValidator';

interface SelfCritiqueOptions {
  engine: SOTAContentGenerationEngine;
  model: AIModel;
  keyword: string;
  title: string;
  html: string;
  contentGaps?: string[];
  maxPasses?: number;
  minScore?: number;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface SelfCritiqueResult {
  html: string;
  initialScore: number;
  finalScore: number;
  passes: number;
}

const CRITIQUE_SYSTEM_PROMPT = `You are a ruthless senior editor for elite business publications.

You improve drafts to be:
- zero fluff
- clear for a smart 14-year-old reader
- practical, specific, and immediately actionable
- written in a direct, high-agency voice (Hormozi/Ferriss energy)

Hard rules:
- Keep the output as complete HTML article only.
- Keep all existing links, embeds, tables, and factual claims unless fixing clarity.
- Preserve SEO relevance to the primary keyword.
- Prefer short paragraphs and concrete examples.
- No generic AI filler language.`;

function extractArticleHtml(input: string): string {
  if (!input) return '';
  const match = input.match(/<article[\s\S]*?<\/article>/i);
  return (match?.[0] || input).trim();
}

function countWords(html: string): number {
  return html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
}

function score(html: string, keyword: string, contentGaps: string[] = []): number {
  return calculateQualityScore(html, keyword, [], contentGaps).overall;
}

function buildCritiquePrompt(title: string, keyword: string, draftHtml: string, contentGaps: string[] = []): string {
  const gapSection = contentGaps.length > 0
    ? `\nMANDATORY GAP TERMS/ENTITIES TO WEAVE NATURALLY:\n${contentGaps.slice(0, 20).map((gap, i) => `${i + 1}. ${gap}`).join('\n')}\n`
    : '';

  return `Rewrite and improve this draft article.

TITLE: ${title}
PRIMARY KEYWORD: ${keyword}
${gapSection}
GOALS:
1) Make it significantly more helpful (specific steps, examples, numbers, clear decisions).
2) Make it easier to read (shorter paragraphs, tighter sentences, no jargon bloat).
3) Remove fluff and AI-sounding transitions.
4) Keep the same core structure and keep all useful links/media.
5) Ensure the final result remains premium, modern, and mobile-friendly HTML.
6) Ensure the mandatory gap terms/entities above are included naturally in useful context.

OUTPUT RULES:
- Return FULL HTML only.
- Begin with <article and end with </article>.
- Do not include markdown/backticks/explanations.

DRAFT HTML:
${draftHtml}`;
}

export async function refineWithSelfCritique(options: SelfCritiqueOptions): Promise<SelfCritiqueResult> {
  const maxPasses = Math.min(3, Math.max(1, options.maxPasses ?? 1));
  const targetScore = Math.max(82, Math.min(98, options.minScore ?? 92));

  let workingHtml = extractArticleHtml(options.html);
  let workingScore = score(workingHtml, options.keyword, options.contentGaps || []);
  const initialScore = workingScore;
  let passes = 0;

  for (let i = 0; i < maxPasses; i++) {
    if (workingScore >= targetScore) break;

    options.onProgress?.(`Self-critique pass ${i + 1}/${maxPasses}...`);

    try {
      const rewrite = await options.engine.generateWithModel({
        prompt: buildCritiquePrompt(options.title, options.keyword, workingHtml, options.contentGaps || []),
        systemPrompt: CRITIQUE_SYSTEM_PROMPT,
        model: options.model,
        apiKeys: {} as any,
        temperature: 0.25,
        maxTokens: 16384,
        timeoutMs: options.timeoutMs ?? 75_000,
        maxRetries: 0,
        allowContinuations: false,
        allowResume: false,
        validation: {
          type: 'article-html',
          requireCompleteArticle: true,
          minWords: Math.max(900, Math.floor(countWords(workingHtml) * 0.82)),
        },
      });

      const candidate = extractArticleHtml(rewrite.content);
      if (!candidate || !candidate.includes('<article')) continue;

      const oldWords = countWords(workingHtml);
      const newWords = countWords(candidate);
      if (newWords < Math.max(900, Math.floor(oldWords * 0.82))) continue;

      const candidateScore = score(candidate, options.keyword, options.contentGaps || []);

      // Accept only when quality actually improves.
      if (candidateScore >= workingScore + 1 || candidateScore >= targetScore) {
        workingHtml = candidate;
        workingScore = candidateScore;
        passes++;
      }
    } catch {
      break;
    }
  }

  return {
    html: workingHtml,
    initialScore,
    finalScore: workingScore,
    passes,
  };
}
