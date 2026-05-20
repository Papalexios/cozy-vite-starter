// src/lib/sota/agents/OutlineArchitectAgent.ts
// Converts ResearchBundle → OutlineBundle (title, meta, H2 list, FAQs).
// Uses the SOTA engine for the LLM call, with safe JSON parsing + fallback.

import { createSOTAEngine } from '../SOTAContentGenerationEngine';
import type { Agent, AgentContext, OutlineBundle, ResearchBundle } from './AgentTypes';

function safeJson(s: string): any | null {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

export class OutlineArchitectAgent implements Agent<ResearchBundle, OutlineBundle> {
  name = 'architect' as const;

  async run(research: ResearchBundle, ctx: AgentContext): Promise<OutlineBundle> {
    const { plan, apiKeys, model, onProgress } = ctx;
    const emit = (message: string) =>
      onProgress?.({ agent: 'architect', status: 'running', message, timestamp: Date.now() });

    emit('Designing outline from SERP gaps + entities');

    const engine = createSOTAEngine(apiKeys);
    const gaps = (research.contentGaps || []).slice(0, 12).join(', ');
    const entities = (research.semanticEntities || []).slice(0, 12).join(', ');
    const competitors = (research.serp?.topCompetitors || [])
      .slice(0, 3)
      .map((c, i) => `${i + 1}. ${c.title} — ${c.snippet}`)
      .join('\n');

    const prompt = `You are an editorial architect. Produce a JSON outline for an article that beats the top SERP.

PRIMARY KEYWORD: ${plan.keyword}
TARGET AUDIENCE: ${plan.targetAudience || 'industry professionals'}
TONE: ${plan.tone || 'expert, direct, high-agency'}
TARGET LENGTH (words): ${plan.targetWordCount || 2200}

COMPETITORS TO BEAT:
${competitors || '(none retrieved)'}

CONTENT GAPS TO COVER: ${gaps || '(none)'}
SEMANTIC ENTITIES: ${entities || '(none)'}

Return ONLY JSON:
{
  "title": "60-char max, primary keyword near front, click-worthy",
  "metaDescription": "<=155 chars, contains keyword, includes a benefit",
  "outline": ["H2 #1", "H2 #2", "..."],
  "faqs": ["Question 1?", "Question 2?", "..."],
  "targetWords": ${plan.targetWordCount || 2200}
}

Rules: 8-14 H2 headings, 5-8 FAQs, no fluff sections, no "Conclusion" as a generic heading.`;

    try {
      const res = await engine.generateWithModel({
        prompt,
        systemPrompt: 'You output strict JSON only. No prose.',
        model,
        apiKeys,
        temperature: 0.4,
        maxTokens: 2000,
        timeoutMs: 45_000,
        maxRetries: 1,
        allowContinuations: false,
        allowResume: false,
      });
      const parsed = safeJson(res?.content || '');
      if (parsed?.outline?.length) {
        return {
          title: parsed.title || plan.keyword,
          metaDescription: parsed.metaDescription || '',
          outline: parsed.outline,
          faqs: parsed.faqs || [],
          targetWords: parsed.targetWords || plan.targetWordCount || 2200,
        };
      }
    } catch (e: any) {
      emit(`Outline LLM failed (${e?.message || e}) — using fallback`);
    }

    // Fallback: derive from gaps + entities
    const fallbackHeadings = [
      `What is ${plan.keyword}?`,
      `Why ${plan.keyword} matters in ${new Date().getFullYear()}`,
      ...(research.contentGaps || []).slice(0, 8).map((g) => g.replace(/^\w/, (c) => c.toUpperCase())),
      `Common pitfalls with ${plan.keyword}`,
      `How to get started with ${plan.keyword}`,
    ].slice(0, 12);

    return {
      title: plan.keyword,
      metaDescription: `Everything you need to know about ${plan.keyword}.`.slice(0, 155),
      outline: fallbackHeadings,
      faqs: [
        `What is ${plan.keyword}?`,
        `How does ${plan.keyword} work?`,
        `Is ${plan.keyword} worth it?`,
      ],
      targetWords: plan.targetWordCount || 2200,
    };
  }
}

export const createOutlineArchitectAgent = () => new OutlineArchitectAgent();
