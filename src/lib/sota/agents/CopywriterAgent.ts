// src/lib/sota/agents/CopywriterAgent.ts
// Generates the full HTML article from the outline + research bundle.
// Delegates to the existing master content prompt + SOTA engine so we
// inherit all retry/continuation/validation logic from Phase 1-7.

import { createSOTAEngine } from '../SOTAContentGenerationEngine';
import { buildMasterSystemPrompt, buildMasterUserPrompt } from '../prompts/masterContentPrompt';
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

    const promptConfig: any = {
      keyword: plan.keyword,
      title: outline.title,
      metaDescription: outline.metaDescription,
      targetAudience: plan.targetAudience || 'industry professionals',
      tone: plan.tone || 'expert, direct, high-agency',
      targetWordCount: outline.targetWords,
      outline: outline.outline,
      faqs: outline.faqs,
      contentGaps: research.contentGaps,
      semanticEntities: research.semanticEntities,
      references: research.references,
      videos: research.videos,
      topCompetitors: research.serp?.topCompetitors || [],
    };

    const systemPrompt = buildMasterSystemPrompt(promptConfig);
    const userPrompt = buildMasterUserPrompt(promptConfig);

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

    const html = result?.content || result?.text || '';
    return { html, wordCount: countWords(html) };
  }
}

export const createCopywriterAgent = () => new CopywriterAgent();
