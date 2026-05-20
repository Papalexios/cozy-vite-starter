// src/lib/sota/agents/AgentRunner.ts
// Orchestrates the 4-agent pipeline:
//   Researcher → OutlineArchitect → Copywriter → Critic (loop ↩ Copywriter)
//
// This sits ALONGSIDE EnterpriseContentOrchestrator. The legacy orchestrator
// remains the production workhorse with all post-processing (Phase 1-7
// injection passes, schema, internal links, etc). AgentRunner gives us a
// clean, traceable, agent-shaped entry point that other surfaces (God Mode,
// Bulk Planner, future MCP agents) can call and observe via AgentEvent
// streams.

import { createResearcherAgent } from './ResearcherAgent';
import { createOutlineArchitectAgent } from './OutlineArchitectAgent';
import { createCopywriterAgent } from './CopywriterAgent';
import { createCriticAgent } from './CriticAgent';
import type {
  AgentContext,
  AgentEvent,
  AgentName,
  AgentRunResult,
  CritiqueBundle,
  DraftBundle,
  OutlineBundle,
  ResearchBundle,
} from './AgentTypes';
import type { GeneratedContent } from '../types';

export interface AgentRunnerOptions {
  minScore?: number;        // critic target (default 92)
  maxCritiquePasses?: number; // default 3
  maxRewriteCycles?: number;  // critic→copywriter cycles (default 1)
}

export class AgentRunner {
  private events: AgentEvent[] = [];

  constructor(private ctx: AgentContext, private opts: AgentRunnerOptions = {}) {}

  private emit(agent: AgentName, status: AgentEvent['status'], message: string, elapsedMs?: number, meta?: Record<string, unknown>) {
    const event: AgentEvent = { agent, status, message, elapsedMs, meta, timestamp: Date.now() };
    this.events.push(event);
    this.ctx.onProgress?.(event);
  }

  async run(): Promise<AgentRunResult> {
    const t0 = Date.now();
    const minScore = this.opts.minScore ?? 92;
    const maxPasses = this.opts.maxCritiquePasses ?? 3;
    const maxRewriteCycles = this.opts.maxRewriteCycles ?? 1;

    // Phase 1 — Researcher
    this.emit('researcher', 'running', 'Gathering SERP, references, videos');
    const tR = Date.now();
    const research: ResearchBundle = await createResearcherAgent().run(undefined as any, this.ctx);
    this.emit('researcher', 'done', `Research complete (${research.references.length} refs, ${research.videos.length} videos)`, Date.now() - tR);

    // Phase 2 — Architect
    this.emit('architect', 'running', 'Building outline');
    const tA = Date.now();
    const outline: OutlineBundle = await createOutlineArchitectAgent().run(research, this.ctx);
    this.emit('architect', 'done', `Outline: ${outline.outline.length} H2s, ${outline.faqs.length} FAQs`, Date.now() - tA);

    // Phase 3 — Copywriter (+ optional Critic rewrite cycles)
    let draft: DraftBundle = await (async () => {
      this.emit('copywriter', 'running', 'Drafting article');
      const tC = Date.now();
      const d = await createCopywriterAgent().run({ research, outline }, this.ctx);
      this.emit('copywriter', 'done', `Draft ready (${d.wordCount} words)`, Date.now() - tC);
      return d;
    })();

    // Phase 4 — Critic (with rewrite loop)
    let critique: CritiqueBundle = await (async () => {
      this.emit('critic', 'running', `Self-critique (target ${minScore}+)`);
      const tCr = Date.now();
      const c = await createCriticAgent().run({ draft, outline, research, minScore, maxPasses }, this.ctx);
      this.emit('critic', 'done', `Final score ${c.finalScore} (${c.passes} pass${c.passes === 1 ? '' : 'es'})`, Date.now() - tCr);
      return c;
    })();

    for (let cycle = 0; cycle < maxRewriteCycles && critique.finalScore < minScore; cycle++) {
      this.emit('copywriter', 'running', `Rewrite cycle ${cycle + 1}/${maxRewriteCycles} — critic below threshold`);
      const tC2 = Date.now();
      draft = await createCopywriterAgent().run({ research, outline }, this.ctx);
      this.emit('copywriter', 'done', `Rewrite draft (${draft.wordCount} words)`, Date.now() - tC2);

      this.emit('critic', 'running', 'Re-critique');
      const tCr2 = Date.now();
      critique = await createCriticAgent().run({ draft: { html: critique.html, wordCount: draft.wordCount }, outline, research, minScore, maxPasses }, this.ctx);
      this.emit('critic', 'done', `Final score ${critique.finalScore}`, Date.now() - tCr2);
    }

    const content: GeneratedContent = {
      title: outline.title,
      metaDescription: outline.metaDescription,
      content: critique.html,
      keyword: this.ctx.plan.keyword,
      slug: this.ctx.plan.keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      wordCount: draft.wordCount,
      qualityScore: { overall: critique.finalScore } as any,
      references: research.references,
      videos: research.videos,
    } as any;

    return {
      research,
      outline,
      draft,
      critique,
      content,
      events: this.events,
      totalElapsedMs: Date.now() - t0,
    };
  }
}

export const createAgentRunner = (ctx: AgentContext, opts?: AgentRunnerOptions) =>
  new AgentRunner(ctx, opts);
