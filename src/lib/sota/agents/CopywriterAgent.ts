// src/lib/sota/agents/CopywriterAgent.ts
// Generates the full HTML article from the outline + research bundle.
// Delegates to the existing master content prompt + SOTA engine so we
// inherit all retry/continuation/validation logic from Phase 1-7.

import { createSOTAEngine } from '../SOTAContentGenerationEngine';
import type {
  Agent,
  AgentContext,
  DraftBundle,
  OutlineBundle,
  ResearchBundle,
} from './AgentTypes';

export interface CopywriterInput {
  research: ResearchBundle;
  outline: OutlineBundle;
}

function countWords(html: string): number {
  return html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
}

export class CopywriterAgent implements Agent<CopywriterInput, DraftBundle> {
  name = 'copywriter' as const;

  async run({ research, outline }: CopywriterInput, ctx: AgentContext): Promise<DraftBundle> {
    const { plan, apiKeys, model, onProgress } = ctx;
    const emit = (message: string) =>
      onProgress?.({ agent: 'copywriter', status: 'running', message, timestamp: Date.now() });

    emit(`Drafting ~${outline.targetWords} words across ${outline.outline.length} sections`);

    const engine = createSOTAEngine(apiKeys);

    const refsBlock = (research.references || [])
      .slice(0, 10)
      .map((r, i) => `${i + 1}. ${r.title} — ${r.url}`)
      .join('\n');
    const videosBlock = (research.videos || [])
      .slice(0, 2)
      .map((v) => `- ${v.title} (https://www.youtube.com/watch?v=${v.id})`)
      .join('\n');
    const outlineBlock = outline.outline.map((h, i) => `${i + 1}. ${h}`).join('\n');
    const faqsBlock = outline.faqs.map((f, i) => `${i + 1}. ${f}`).join('\n');

    const systemPrompt = `You are an elite editorial writer producing premium HTML articles.
Voice: direct, high-agency, Hormozi/Ferriss energy. First-person where natural.
Output: ONE complete <article>...</article> with semantic HTML5 (h1, h2, h3, p, ul, table, blockquote, figure).
No "In conclusion", no AI filler. Every section ships specifics: numbers, examples, named entities.`;

    const userPrompt = `Write a ~${outline.targetWords}-word article.

TITLE: ${outline.title}
META DESCRIPTION: ${outline.metaDescription}
PRIMARY KEYWORD: ${plan.keyword}
AUDIENCE: ${plan.targetAudience || 'industry professionals'}
TONE: ${plan.tone || 'expert, direct'}

OUTLINE (H2s in order):
${outlineBlock}

FAQs to answer in a dedicated section:
${faqsBlock}

REFERENCE these sources where appropriate (inline links):
${refsBlock || '(none)'}

VIDEOS to embed once (use <iframe> for YouTube):
${videosBlock || '(none)'}

Return ONLY the full HTML article.`;

    const result = await engine.generateWithModel({
      prompt: userPrompt,
      systemPrompt,
      model,
      apiKeys,
      temperature: 0.7,
      maxTokens: 16000,
      timeoutMs: 3 * 60 * 1000,
      maxRetries: 2,
      allowContinuations: true,
      allowResume: true,
      validation: { type: 'article-html', requireCompleteArticle: true, minWords: 1500 },
    });

    const html = result?.content || '';
    return { html, wordCount: countWords(html) };
  }
}

export const createCopywriterAgent = () => new CopywriterAgent();
