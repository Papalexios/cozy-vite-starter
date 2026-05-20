// src/lib/sota/clusters/ClusterPlanner.ts
// Phase 10 — Given a root topic, generates one pillar + N spokes via the SOTA engine.

import { createSOTAEngine } from '../SOTAContentGenerationEngine';
import type { AIModel, APIKeys } from '../types';
import type { ClusterNode, TopicCluster } from './ClusterTypes';

function safeJson(s: string): any | null {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

function uid() {
  return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export interface PlanClusterOptions {
  rootTopic: string;
  spokes?: number;            // default 10
  audience?: string;
  apiKeys: APIKeys;
  model: AIModel;
}

export async function planCluster(opts: PlanClusterOptions): Promise<TopicCluster> {
  const spokeCount = Math.min(Math.max(opts.spokes ?? 10, 4), 20);
  const engine = createSOTAEngine(opts.apiKeys);

  const prompt = `You are a topical-authority strategist. Design ONE pillar page and ${spokeCount} supporting spoke articles for the root topic below.

ROOT TOPIC: ${opts.rootTopic}
AUDIENCE: ${opts.audience || 'industry professionals'}

Return ONLY valid JSON:
{
  "pillarKeyword": "primary keyword for the pillar (3-5 words)",
  "pillarTitle": "Click-worthy pillar title under 65 chars",
  "summary": "1-2 sentence cluster thesis",
  "spokes": [
    {
      "title": "Spoke article title",
      "targetKeyword": "long-tail keyword (3-7 words)",
      "contentType": "how-to|guide|comparison|listicle|deep-dive",
      "intent": "informational|commercial|transactional|navigational"
    }
  ]
}

Rules:
- The pillar must cover the broad topic; spokes must each own a distinct, specific subtopic.
- No spoke keywords may repeat the pillar keyword verbatim.
- Cover full funnel: ~60% informational, ~25% commercial, ~15% transactional.
- Spokes count MUST equal ${spokeCount}.`;

  let parsed: any = null;
  try {
    const res = await engine.generateWithModel({
      prompt,
      systemPrompt: 'You output strict JSON only. No prose.',
      model: opts.model,
      apiKeys: opts.apiKeys,
      temperature: 0.5,
      maxTokens: 3000,
      timeoutMs: 60_000,
      maxRetries: 1,
      allowContinuations: false,
      allowResume: false,
    });
    parsed = safeJson(res?.content || '');
  } catch (e) {
    console.warn('[ClusterPlanner] LLM call failed:', (e as Error).message);
  }

  const clusterId = uid();
  const nodes: ClusterNode[] = [];

  const pillarKeyword: string = parsed?.pillarKeyword || opts.rootTopic;
  const pillarTitle: string = parsed?.pillarTitle || `The Complete Guide to ${opts.rootTopic}`;

  nodes.push({
    id: uid(),
    kind: 'pillar',
    title: pillarTitle,
    targetKeyword: pillarKeyword,
    contentType: 'guide',
    intent: 'informational',
    status: 'planned',
    position: 0,
  });

  const spokes = Array.isArray(parsed?.spokes) ? parsed.spokes : [];
  if (spokes.length === 0) {
    for (let i = 0; i < spokeCount; i++) {
      nodes.push({
        id: uid(),
        kind: 'spoke',
        title: `${opts.rootTopic} — Topic ${i + 1}`,
        targetKeyword: `${opts.rootTopic} ${i + 1}`,
        contentType: 'guide',
        intent: 'informational',
        status: 'planned',
        position: i + 1,
      });
    }
  } else {
    spokes.slice(0, spokeCount).forEach((s: any, i: number) => {
      nodes.push({
        id: uid(),
        kind: 'spoke',
        title: String(s.title || `Spoke ${i + 1}`).slice(0, 120),
        targetKeyword: String(s.targetKeyword || s.title || '').slice(0, 120),
        contentType: s.contentType,
        intent: s.intent,
        status: 'planned',
        position: i + 1,
      });
    });
  }

  return {
    id: clusterId,
    rootTopic: opts.rootTopic,
    pillarKeyword,
    summary: parsed?.summary,
    nodes,
    createdAt: new Date().toISOString(),
  };
}
