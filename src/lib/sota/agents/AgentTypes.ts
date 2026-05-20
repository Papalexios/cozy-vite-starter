// src/lib/sota/agents/AgentTypes.ts
// Phase 8 — 4-Agent Pipeline contracts.
// Agents are thin, typed wrappers around existing SOTA services so the
// EnterpriseContentOrchestrator can be reasoned about as
// Researcher → OutlineArchitect → Copywriter → Critic with explicit IO,
// telemetry, and rewrite loops — without rewriting the working pipeline.

import type {
  APIKeys,
  AIModel,
  ContentPlan,
  GeneratedContent,
  SERPAnalysis,
  Reference,
  YouTubeVideo,
  QualityScore,
} from '../types';

export type AgentName = 'researcher' | 'architect' | 'copywriter' | 'critic';

export type AgentStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface AgentEvent {
  agent: AgentName;
  status: AgentStatus;
  message: string;
  elapsedMs?: number;
  meta?: Record<string, unknown>;
  timestamp: number;
}

export type AgentProgress = (event: AgentEvent) => void;

export interface AgentContext {
  plan: ContentPlan;
  apiKeys: APIKeys;
  model: AIModel;
  serperKey?: string;
  wpUrl?: string;
  wpUsername?: string;
  wpAppPassword?: string;
  organizationName?: string;
  organizationUrl?: string;
  logoUrl?: string;
  sitePages?: any[];
  onProgress?: AgentProgress;
}

export interface ResearchBundle {
  serp: SERPAnalysis | null;
  references: Reference[];
  videos: YouTubeVideo[];
  contentGaps: string[];
  semanticEntities: string[];
}

export interface OutlineBundle {
  title: string;
  metaDescription: string;
  outline: string[];        // H2 sections in order
  faqs: string[];           // candidate questions
  targetWords: number;
}

export interface DraftBundle {
  html: string;
  wordCount: number;
}

export interface CritiqueBundle {
  html: string;
  initialScore: number;
  finalScore: number;
  passes: number;
  notes: string[];
}

export interface AgentRunResult {
  research: ResearchBundle;
  outline: OutlineBundle;
  draft: DraftBundle;
  critique: CritiqueBundle;
  content: GeneratedContent;
  events: AgentEvent[];
  totalElapsedMs: number;
}

export interface Agent<I, O> {
  name: AgentName;
  run(input: I, ctx: AgentContext): Promise<O>;
}
