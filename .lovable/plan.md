
# Blueprint Implementation Plan

You picked all four scopes, keep current stack (Cloudflare Pages Functions + Supabase), and approved a pgvector cache. I'll ship this as four sequential phases (7→10) on top of the existing orchestrator, NOT as a rewrite. Nothing in Phases 1-6 gets thrown away.

## Phase 7 — GEO: Information Gain Engine + Semantic Cache

**New files**
- `migrations/004_phase7_semantic_cache.sql` — `pgvector` extension, `serp_cache` (keyword, embedding vector(1536), payload jsonb, fetched_at), `information_gain_runs` table, `match_serp_cache` RPC.
- `src/lib/sota/geo/InformationGainEngine.ts` — orchestrates: SERP fetch (reuses `SERPAnalyzer`) → embed top-5 page chunks via Lovable AI Gateway (`google/gemini-embedding-001`, dims=1536) → embed draft outline → cosine-diff to surface blindspot topics, missing entities, contrarian angles.
- `src/lib/sota/geo/embeddings.ts` — thin wrapper around `https://ai.gateway.lovable.dev/v1/embeddings` (server-side only via Cloudflare Function).
- `functions/api/embed.ts` — Cloudflare Function proxy holding `LOVABLE_API_KEY`.
- `src/lib/db/semanticCache.ts` — `getCachedSerp(keyword, threshold=0.92)` / `putCachedSerp` via Supabase RPC.
- `src/components/optimizer/GenerativeLiftPanel.tsx` — mounted in `ReviewExport` (and per-article in `ContentViewerPanel`) showing blindspots, suggested entities, contrarian angles, "lift score" 0-100.

**Wiring**
- New orchestrator phase **0b: Information Gain** (after SERP, before outline). Result attached to `GeneratedContent.metadata.informationGain`.
- Cache: every SERP scrape + embedding run is keyed by keyword embedding; reuse when cosine ≥ 0.92 and `fetched_at` within 7 days.

## Phase 8 — 4-Agent Pipeline Refactor

Refactor `EnterpriseContentOrchestrator` into an explicit agent graph WITHOUT breaking existing phase numbers (agents wrap groups of phases).

- `src/lib/sota/agents/AgentTypes.ts` — `AgentContext`, `AgentResult<T>`, `AgentRunLog`.
- `src/lib/sota/agents/ResearcherAgent.ts` — wraps Phase 0 (SERP) + 0b (Information Gain) + entity/PAA extraction + Wikidata sameAs lookup.
- `src/lib/sota/agents/OutlineArchitectAgent.ts` — emits strict H2/H3 plan with AEO question headers + snippet-bait targets.
- `src/lib/sota/agents/CopywriterAgent.ts` — section-by-section streaming; reuses Master Prompt v15.0 (Hormozi/Ferriss voice, AI-phrase ban).
- `src/lib/sota/agents/CriticAgent.ts` — programmatic scorer (entity coverage %, snippet-bait conformance %, citation density, gap coverage). Returns rewrite directives per section.
- `src/lib/sota/agents/AgentRunner.ts` — Critic→Copywriter loop, max 3 cycles, target score ≥95.
- `src/lib/sota/EnterpriseContentOrchestrator.ts` — replace inline phase calls with `AgentRunner.run({ researcher, architect, copywriter, critic })`. Existing self-critique (Phase 7) becomes part of CriticAgent.
- UI: `GenerationProgressModal` shows active agent + cycle count.

## Phase 9 — AEO: Snippet-Bait Linter + Deep JSON-LD @graph

- `src/lib/sota/aeo/snippetBaitLinter.ts` — for every H2/H3 that is a question, verify the next paragraph is 40-60 words, starts with an absolute definition ("X is…" / "To do Y…"), has no ambiguous pronouns. Emits `LintIssue[]` with severity.
- `src/lib/sota/aeo/snippetBaitFixer.ts` — auto-rewrite failing baits via Lovable AI Gateway in CriticAgent.
- `src/components/optimizer/AEOLinterPanel.tsx` — live panel in `ContentViewerPanel` with click-to-jump highlights (reuses the per-claim highlight pattern from Phase 4).
- `src/lib/sota/SchemaGenerator.ts` — extend to emit nested `@graph` with `WebSite`, `Organization`, `Person` (author with `sameAs` socials from AuthorProfiles), `TechArticle`/`Article`, `FAQPage`, `BreadcrumbList`, and `about: [{ @type: Thing, sameAs: <wikidata> }]` Entity Mentions from ResearcherAgent.
- Validate against schema.org JSON-LD shapes; render in `ReviewExport` Schema tab.

## Phase 10 — Topical Cluster Visualizer (ReactFlow)

- `bun add reactflow`
- `migrations/005_phase10_clusters.sql` — `topic_clusters`, `cluster_nodes` (id, cluster_id, kind: 'pillar'|'spoke', title, target_keyword, status, draft_id FK).
- `src/lib/sota/clusters/ClusterPlanner.ts` — given a root topic, generate 1 pillar + 10 spokes via Lovable AI Gateway with strict JSON schema output.
- `src/lib/sota/clusters/LinkMatrix.ts` — extends existing `SOTAInternalLinkEngine` to auto-resolve spoke↔pillar↔sibling anchors using cosine similarity over cluster-scoped embeddings (reuses Phase 7 cache).
- `src/components/optimizer/cluster/ClusterCanvas.tsx` — ReactFlow node tree, click node → opens article workstation (reuses existing `ContentViewerPanel` flow).
- `src/components/optimizer/cluster/ClusterPlannerModal.tsx` — root-topic input + generate button.
- New nav entry under Strategy step.

## Cross-cutting

- All embedding/LLM calls go through Cloudflare Function or Supabase Edge Function — never client-side (keeps `LOVABLE_API_KEY` server-only).
- All four phases write into `mem://features/...` after completion and update `mem://index.md`.
- Existing Phase 1-6 surfaces (Content Memory, GSC, Job Queue, Fact-Check, WP Publisher, Feedback Loop) are untouched.

## Manual actions you'll need to take

1. Run migrations 004 + 005 in Supabase SQL editor (I'll provide the files).
2. Confirm `LOVABLE_API_KEY` is set as a Cloudflare Pages environment variable for the new `/api/embed` function (it's already in Supabase secrets for existing functions).

## Execution order

I'll ship one phase per turn so each is reviewable and testable. **Starting with Phase 7 next turn unless you want a different order.**
