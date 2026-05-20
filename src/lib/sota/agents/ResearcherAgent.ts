// src/lib/sota/agents/ResearcherAgent.ts
// Wraps SERPAnalyzer + ReferenceService + YouTubeService into a single
// research phase. Produces the evidence base every downstream agent reads.

import { createSERPAnalyzer } from '../SERPAnalyzer';
import { createReferenceService } from '../ReferenceService';
import { createYouTubeService } from '../YouTubeService';
import { gateReferences } from '../AuthoritativeSourceGate';
import type { Agent, AgentContext, ResearchBundle } from './AgentTypes';

export class ResearcherAgent implements Agent<void, ResearchBundle> {
  name = 'researcher' as const;

  async run(_: void, ctx: AgentContext): Promise<ResearchBundle> {
    const { plan, serperKey, onProgress } = ctx;
    const emit = (message: string, meta?: Record<string, unknown>) =>
      onProgress?.({ agent: 'researcher', status: 'running', message, meta, timestamp: Date.now() });

    if (!serperKey) {
      emit('No Serper key — researcher returning empty bundle.');
      return { serp: null, references: [], videos: [], contentGaps: [], semanticEntities: [] };
    }

    const serpAnalyzer = createSERPAnalyzer(serperKey);
    const refService = createReferenceService(serperKey);
    const ytService = createYouTubeService(serperKey);

    emit(`SERP scan: "${plan.keyword}"`);
    const serp = await serpAnalyzer.analyze(plan.keyword).catch((e) => {
      emit(`SERP failed: ${e?.message || e}`);
      return null;
    });

    emit('Gathering references (8-12 authoritative sources)');
    const rawRefs = await refService.gather(plan.keyword, 12).catch(() => []);
    const references = gateReferences(rawRefs);

    emit('Discovering YouTube videos (1-3 best matches)');
    const videos = await ytService.discover(plan.keyword, 3).catch(() => []);

    return {
      serp,
      references,
      videos,
      contentGaps: serp?.contentGaps ?? [],
      semanticEntities: serp?.semanticEntities ?? [],
    };
  }
}

export const createResearcherAgent = () => new ResearcherAgent();
