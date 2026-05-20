// src/lib/sota/agents/CriticAgent.ts
// Wraps the existing HumanQualityRefiner (self-critique loop, up to 3 passes,
// target ≥95 quality) and exposes it as an Agent for the AgentRunner.
// CriticAgent feeds back into CopywriterAgent only when score < threshold.

import { createSOTAEngine } from '../SOTAContentGenerationEngine';
import { refineWithSelfCritique } from '../HumanQualityRefiner';
import { calculateQualityScore } from '../QualityValidator';
import type { Agent, AgentContext, CritiqueBundle, DraftBundle, OutlineBundle, ResearchBundle } from './AgentTypes';

export interface CriticInput {
  draft: DraftBundle;
  outline: OutlineBundle;
  research: ResearchBundle;
  minScore?: number;
  maxPasses?: number;
}

export class CriticAgent implements Agent<CriticInput, CritiqueBundle> {
  name = 'critic' as const;

  async run(input: CriticInput, ctx: AgentContext): Promise<CritiqueBundle> {
    const { plan, apiKeys, model, onProgress } = ctx;
    const { draft, outline, research, minScore = 92, maxPasses = 3 } = input;
    const emit = (message: string, meta?: Record<string, unknown>) =>
      onProgress?.({ agent: 'critic', status: 'running', message, meta, timestamp: Date.now() });

    const engine = createSOTAEngine(apiKeys);

    const initialScore = Number(
      calculateQualityScore(draft.html, plan.keyword, research.contentGaps)?.overall ?? 0
    );
    emit(`Initial quality score: ${initialScore}`);

    if (initialScore >= minScore) {
      return {
        html: draft.html,
        initialScore,
        finalScore: initialScore,
        passes: 0,
        notes: [`Skipped rewrite — already at ${initialScore} (>= ${minScore}).`],
      };
    }

    const result = await refineWithSelfCritique({
      engine,
      model,
      keyword: plan.keyword,
      title: outline.title,
      html: draft.html,
      contentGaps: research.contentGaps,
      maxPasses,
      minScore,
      timeoutMs: 75_000,
      onProgress: (m) => emit(m),
    });

    return {
      html: result.html,
      initialScore: result.initialScore,
      finalScore: result.finalScore,
      passes: result.passes,
      notes: [`Refined ${result.passes} pass(es): ${result.initialScore} → ${result.finalScore}`],
    };
  }
}

export const createCriticAgent = () => new CriticAgent();
