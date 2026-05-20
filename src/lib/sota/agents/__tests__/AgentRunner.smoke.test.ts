// Smoke test — runs the 4-agent pipeline end-to-end against a fixture keyword
// with all external services stubbed. Verifies: every agent fires in order,
// the runner produces a non-empty article, and the AgentEvent stream completes.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Stub heavy external modules BEFORE importing the runner ─────────────────
vi.mock('@/lib/sota/SERPAnalyzer', () => ({
  createSERPAnalyzer: () => ({
    analyze: vi.fn().mockResolvedValue({
      keyword: 'best portable espresso maker 2026',
      topCompetitors: [
        { title: 'A', url: 'https://a', snippet: 'a snippet' },
        { title: 'B', url: 'https://b', snippet: 'b snippet' },
      ],
      contentGaps: ['water capacity', 'travel TSA rules', 'cleaning routine'],
      semanticEntities: ['portafilter', 'bar pressure', 'tamper'],
    }),
  }),
}));

vi.mock('@/lib/sota/ReferenceService', () => ({
  createReferenceService: () => ({
    getTopReferences: vi.fn().mockResolvedValue([
      { title: 'Ref 1', url: 'https://ref1.test', snippet: 's1' },
      { title: 'Ref 2', url: 'https://ref2.test', snippet: 's2' },
    ]),
  }),
}));

vi.mock('@/lib/sota/YouTubeService', () => ({
  createYouTubeService: () => ({
    searchVideos: vi.fn().mockResolvedValue([{ id: 'abc123', title: 'Demo' }]),
  }),
}));

vi.mock('@/lib/sota/AuthoritativeSourceGate', () => ({
  gateReferences: vi.fn().mockImplementation(async (refs: any[]) => ({ kept: refs, rejected: [] })),
}));

const fakeOutline = {
  title: 'Best Portable Espresso Maker 2026',
  metaDescription: 'A direct, practical guide to the best portable espresso makers for travel.',
  outline: ['What is a portable espresso maker?', 'Top picks', 'TSA rules', 'How to clean'],
  faqs: ['Are portable espresso makers worth it?', 'Can I take one on a plane?'],
  targetWords: 1800,
};

const fakeArticle =
  '<article>' +
  '<h1>Best Portable Espresso Maker 2026</h1>' +
  Array.from({ length: 30 })
    .map(
      (_, i) =>
        `<h2>Section ${i + 1}</h2><p>${'A portable espresso maker is a compact device that pulls real shots away from a kitchen counter. '.repeat(10)}</p>`
    )
    .join('') +
  '</article>';

vi.mock('@/lib/sota/SOTAContentGenerationEngine', () => ({
  createSOTAEngine: () => ({
    generateWithModel: vi.fn().mockImplementation(async ({ prompt }: { prompt: string }) => {
      // Architect prompt asks for "Return ONLY JSON"
      if (/Return ONLY JSON/i.test(prompt) || /JSON outline/i.test(prompt)) {
        return { content: JSON.stringify(fakeOutline) };
      }
      return { content: fakeArticle };
    }),
  }),
}));

vi.mock('@/lib/sota/HumanQualityRefiner', () => ({
  refineWithSelfCritique: vi.fn().mockImplementation(async ({ html, onProgress }: any) => {
    onProgress?.('skipping critique in smoke test');
    return { html, initialScore: 96, finalScore: 96, passes: 0 };
  }),
}));

vi.mock('@/lib/sota/QualityValidator', () => ({
  calculateQualityScore: () => ({ overall: 96, seo: 90, eeat: 88 }),
}));

// ─── Now import the real runner ──────────────────────────────────────────────
import { createAgentRunner } from '../AgentRunner';
import type { AgentContext, AgentEvent } from '../AgentTypes';

describe('AgentRunner — full-pipeline smoke', () => {
  const baseCtx: Omit<AgentContext, 'onProgress'> = {
    plan: {
      keyword: 'best portable espresso maker 2026',
      targetAudience: 'travel coffee enthusiasts',
      tone: 'practical, direct',
      targetWordCount: 1800,
    },
    apiKeys: { openaiApiKey: 'sk-test' } as any,
    model: 'openai' as any,
    serperKey: 'serper-test',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs Researcher → Architect → Copywriter → Critic and emits a complete article', async () => {
    const events: AgentEvent[] = [];
    const runner = createAgentRunner({ ...baseCtx, onProgress: (e) => events.push(e) });
    const result = await runner.run();

    // 1. All four agents reported at least one event
    const agents = new Set(events.map((e) => e.agent));
    expect(agents.has('researcher')).toBe(true);
    expect(agents.has('architect')).toBe(true);
    expect(agents.has('copywriter')).toBe(true);
    expect(agents.has('critic')).toBe(true);

    // 2. Each agent has a terminal 'done' event
    for (const a of ['researcher', 'architect', 'copywriter', 'critic'] as const) {
      const terminal = [...events].reverse().find((e) => e.agent === a);
      expect(terminal?.status, `${a} should terminate`).toBe('done');
    }

    // 3. Pipeline produced an article with real content
    expect(result.draft.html).toContain('<article>');
    expect(result.draft.wordCount).toBeGreaterThan(500);

    // 4. Outline + research bundles populated
    expect(result.outline.outline.length).toBeGreaterThan(2);
    expect(result.research.contentGaps).toContain('water capacity');

    // 5. Critic returned final HTML and met the score floor (mock returns 96)
    expect(result.critique.html).toContain('<article>');
    expect(result.critique.finalScore).toBeGreaterThanOrEqual(90);

    // 6. Final unified GeneratedContent carries the keyword + final HTML
    expect((result.content as any).keyword).toBe('best portable espresso maker 2026');
    expect((result.content as any).content).toContain('<article>');
  }, 30_000);
});
