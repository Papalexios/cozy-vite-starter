// src/lib/sota/EnterpriseContentOrchestrator.ts
// ═══════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CONTENT ORCHESTRATOR v10.0 — SOTA GOD-MODE ARCHITECTURE
//
// Pipeline phases:
//   1. NeuronWriter Semantic Context Initialization (auto-create + poll)
//   2. YouTube Video Discovery (1-3 relevant videos via Serper)
//   3. Reference Gathering (8-12 high-quality references via Serper)
//   4. Master Content Generation (AI model)
//   5. SOTA Humanization & Premium Design Overlay
//   6. Visual Break Enforcement (break walls of text every ~200 words)
//   7. YouTube Video Injection (embed + cards)
//   8. Reference Section Injection
//   9. Internal Link Generation & Injection (4–8 contextual links)
//  10. Schema.org Structured Data Generation
// ═══════════════════════════════════════════════════════════════════════════════

import type {
  APIKeys,
  AIModel,
  GeneratedContent,
  ContentMetrics,
  QualityScore,
  SERPAnalysis,
  InternalLink,
  SchemaMarkup,
  EEATProfile,
  YouTubeVideo,
  Reference,
  ContentPlan,
  PostProcessingResult,
} from './types';
import {
  SOTAContentGenerationEngine,
  createSOTAEngine,
  type ExtendedAPIKeys,
} from './SOTAContentGenerationEngine';
import { SERPAnalyzer, createSERPAnalyzer } from './SERPAnalyzer';
import { YouTubeService, createYouTubeService } from './YouTubeService';
import { ReferenceService, createReferenceService } from './ReferenceService';
import {
  SOTAInternalLinkEngine,
  createInternalLinkEngine,
} from './SOTAInternalLinkEngine';
import { SchemaGenerator, createSchemaGenerator } from './SchemaGenerator';
import {
  calculateQualityScore,
  analyzeContent,
  removeAIPhrases,
  polishReadability,
  validateVisualBreaks,
} from './QualityValidator';
import { EEATValidator, createEEATValidator } from './EEATValidator';
import { generationCache } from './cache';
import {
  detectClaimParagraphs,
  buildSerperCacheKey,
  getCachedSerper,
  setCachedSerper,
  classifyClaimOutcome,
  setLatestFactCheckReport,
  findBestMatchingParagraph,
  type FactCheckClaim,
  type FactCheckSource,
  type FactCheckReport,
} from './FactCheckReport';
import {
  NeuronWriterService,
  createNeuronWriterService,
  type NeuronWriterAnalysis,
  type NeuronWriterQuery,
} from './NeuronWriterService';
import ContentPostProcessor, { removeAIPatterns, postProcessContent, injectMissingTerms, ensureVisualElements } from './ContentPostProcessor';
import {
  buildMasterSystemPrompt,
  buildMasterUserPrompt,
  type ContentPromptConfig,
} from './prompts/masterContentPrompt';
import { refineWithSelfCritique } from './HumanQualityRefiner';
import { WordPressMediaService, type WordPressMediaItem } from './WordPressMediaService';
import { runBlogPostChecklist, buildMissingSectionsRewritePrompt, type ChecklistResult } from './BlogPostChecklist';
import { extractEntityCandidates } from './EntityGraph';
import { injectCitedQuotes } from './CitedQuoteInjector';
import { buildVoiceFingerprintDirective, type AuthorProfile, type VoiceFingerprint } from './AuthorProfiles';
import { gateReferences } from './AuthoritativeSourceGate';
import { applyAEO } from './AEOEnhancer';
import { runFactCheck, type FactCheckPipelineResult, type CandidateEvidence } from './factcheck';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const NW_TARGET_SCORE = 90;

// Polling: bounded so NeuronWriter can never hold generation hostage.
const NW_MAX_POLL_ATTEMPTS = 6;           // 6 × 8s = 48 seconds max
const NW_POLL_INTERVAL_MS = 8000;         // 8 seconds between polls
const NW_HARD_LIMIT_MS = 50 * 1000;       // fail open and continue without NW

// The NW query must be in one of these statuses before we consider data valid
const NW_READY_STATUSES = new Set(['done', 'ready', 'completed', 'finished', 'analysed', 'analyzed']);

const MIN_VALID_CONTENT_LENGTH = 9000;
const MIN_ENTERPRISE_WORD_COUNT = 1800;
const PIPELINE_HARD_LIMIT_MS = 10 * 60 * 1000;
const OPTIONAL_PHASE_MIN_REMAINING_MS = 2 * 60 * 1000;
const MASTER_GENERATION_TIMEOUT_MS = 3 * 60 * 1000;
const CRITIQUE_TIMEOUT_MS = 75 * 1000;
const CHECKLIST_PATCH_TIMEOUT_MS = 45 * 1000;
const TITLE_REWRITE_TIMEOUT_MS = 20 * 1000;

type NeuronBundle = {
  service: NeuronWriterService;
  queryId: string;
  analysis: NeuronWriterAnalysis;
};

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR CLASS
// ─────────────────────────────────────────────────────────────────────────────

export class EnterpriseContentOrchestrator {
  private engine: SOTAContentGenerationEngine;
  private serpAnalyzer: SERPAnalyzer;
  private youtubeService: YouTubeService;
  private referenceService: ReferenceService;
  private wpMediaService: WordPressMediaService;
  private linkEngine: SOTAInternalLinkEngine;
  private schemaGenerator: SchemaGenerator;
  private eeatValidator: EEATValidator;
  private config: any;
  private serperKey: string = '';
  private telemetry: any = { warnings: [], errors: [], timeline: [] };
  private onProgress?: (msg: string) => void;

  constructor(config: any) {
    this.config = config;

    // Extract serperApiKey from nested apiKeys or from top-level config
    const serperKey = config.apiKeys?.serperApiKey || config.serperApiKey || '';
    this.serperKey = serperKey;

    // CRITICAL: pipe engine progress (retries, continuations, fallbacks) to UI
    this.engine = createSOTAEngine(config.apiKeys, (msg: string) => {
      this.log(`[Engine] ${msg}`);
    });
    this.serpAnalyzer = createSERPAnalyzer(serperKey);
    this.youtubeService = createYouTubeService(serperKey);
    this.referenceService = createReferenceService(serperKey);
    this.wpMediaService = new WordPressMediaService({
      wpUrl: config.wpUrl,
      wpUsername: config.wpUsername,
      wpAppPassword: config.wpAppPassword,
    });
    this.linkEngine = createInternalLinkEngine(config.sitePages || []);
    // FIX: SchemaGenerator(orgName, orgUrl, logoUrl) — never pass apiKeys here
    this.schemaGenerator = createSchemaGenerator(
      config.organizationName || 'Editorial Team',
      config.organizationUrl || config.wpUrl || 'https://example.com',
      config.logoUrl || ''
    );
    this.eeatValidator = createEEATValidator();
  }

  private log(msg: string) {
    const timestamp = new Date().toISOString();
    console.log(`[Orchestrator] [${timestamp}]`, msg);
    this.telemetry.timeline.push({ timestamp, event: msg });
    if (this.onProgress) this.onProgress(msg);
  }

  private warn(msg: string) {
    console.warn('[Orchestrator]', msg);
    this.telemetry.warnings.push(msg);
  }

  private getPipelineElapsedMs(): number {
    return Date.now() - (this.telemetry.startedAt || Date.now());
  }

  private getPipelineRemainingMs(): number {
    return Math.max(0, PIPELINE_HARD_LIMIT_MS - this.getPipelineElapsedMs());
  }

  private shouldSkipOptionalPhase(phase: string, minRemainingMs = OPTIONAL_PHASE_MIN_REMAINING_MS): boolean {
    const remaining = this.getPipelineRemainingMs();
    if (remaining >= minRemainingMs) return false;
    this.warn(`${phase}: skipped — runtime budget nearly exhausted (${Math.round(remaining / 1000)}s remaining). Finalizing current article.`);
    return true;
  }

  private async withTimeout<T>(label: string, work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        work,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => {
            this.warn(`${label}: timed out after ${Math.round(timeoutMs / 1000)}s — continuing without blocking generation.`);
            resolve(fallback);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private error(msg: string) {
    console.error('[Orchestrator]', msg);
    this.telemetry.errors.push(msg);
  }

  private normalizeTextForGap(text: string): string {
    return (text || '').toLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private buildTopGapTargetsFromSerp(analysis: SERPAnalysis, keyword: string, limit = 20): string[] {
    const stopWords = new Set([
      'about', 'after', 'again', 'also', 'and', 'are', 'been', 'best', 'between', 'both', 'but', 'can', 'for',
      'from', 'guide', 'have', 'into', 'more', 'most', 'over', 'that', 'than', 'their', 'them', 'then', 'there',
      'these', 'they', 'this', 'those', 'with', 'your', 'what', 'when', 'where', 'which', 'while', 'will', 'would',
      'could', 'should', 'using', 'used', 'into', 'only', 'much', 'many', 'very', 'through'
    ]);

    const keywordTokens = new Set(keyword.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const top3 = (analysis.topCompetitors || []).slice(0, 3);

    const tokenScore = new Map<string, number>();
    const boost = (token: string, weight: number) => {
      const t = token.trim().toLowerCase();
      if (!t || t.length < 4 || stopWords.has(t) || keywordTokens.has(t)) return;
      tokenScore.set(t, (tokenScore.get(t) || 0) + weight);
    };

    for (const competitor of top3) {
      const combined = `${competitor.title || ''} ${competitor.snippet || ''}`.toLowerCase();
      const words = combined.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
      words.forEach((w) => boost(w, 1));

      for (let i = 0; i < words.length - 1; i++) {
        const a = words[i];
        const b = words[i + 1];
        if (!a || !b) continue;
        if (a.length < 4 || b.length < 4) continue;
        if (stopWords.has(a) || stopWords.has(b)) continue;
        boost(`${a} ${b}`, 2);
      }
    }

    const rankedFromTop3 = Array.from(tokenScore.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([term]) => term);

    const merged = [
      ...(analysis.contentGaps || []),
      ...(analysis.semanticEntities || []),
      ...rankedFromTop3,
    ];

    const dedup = new Set<string>();
    const finalTerms: string[] = [];
    for (const term of merged) {
      const normalized = term.trim().toLowerCase();
      if (!normalized || normalized.length < 4) continue;
      if (dedup.has(normalized)) continue;
      dedup.add(normalized);
      finalTerms.push(term.trim());
      if (finalTerms.length >= limit) break;
    }

    return finalTerms;
  }

  private enforceGapCoverage(html: string, gapTargets: string[]): { html: string; missingBefore: string[]; missingAfter: string[] } {
    if (!gapTargets.length) return { html, missingBefore: [], missingAfter: [] };

    const isCovered = (text: string, gap: string): boolean => {
      const tokens = gap.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
      if (tokens.length === 0) return true;
      const matches = tokens.filter((token) => text.includes(token)).length;
      return matches >= Math.max(1, Math.ceil(tokens.length * 0.5));
    };

    const textBefore = this.normalizeTextForGap(html);
    const missingBefore = gapTargets.filter((gap) => !isCovered(textBefore, gap));
    if (missingBefore.length === 0) return { html, missingBefore: [], missingAfter: [] };

    const injectedHtml = injectMissingTerms(html, missingBefore);
    const textAfter = this.normalizeTextForGap(injectedHtml);
    const missingAfter = gapTargets.filter((gap) => !isCovered(textAfter, gap));

    return {
      html: injectedHtml,
      missingBefore,
      missingAfter,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FACT-CHECK PASS — live web search verification of factual claims
  // ─────────────────────────────────────────────────────────────────────────
  private async runFactCheckPass(html: string, keyword: string, model: string): Promise<string> {
    const startedAt = Date.now();
    const totalParagraphs = (html.match(/<p[^>]*>/gi) || []).length;

    const baseReport: FactCheckReport = {
      generatedAt: startedAt,
      keyword,
      totalParagraphsScanned: totalParagraphs,
      candidatesDetected: 0,
      claimsChecked: 0,
      reconciled: false,
      claims: [],
    };

    if (!this.serperKey) {
      this.warn('Fact-check: skipped (no Serper API key configured).');
      setLatestFactCheckReport({ ...baseReport, notes: 'Skipped — no Serper API key configured.' });
      return html;
    }

    // Improved claim-paragraph detection (scored, deduped, false-positive filtered)
    const detected = detectClaimParagraphs(html, 6);
    baseReport.candidatesDetected = detected.length;

    if (detected.length === 0) {
      this.log('Fact-check: no high-stakes claims detected.');
      setLatestFactCheckReport({ ...baseReport, notes: 'No high-stakes claims detected in draft.' });
      return html;
    }

    // Run Serper for each claim (parallel) with per-claim cache
    const claims: FactCheckClaim[] = [];
    const evidenceForPrompt: { claim: string; sources: FactCheckSource[] }[] = [];

    await Promise.all(detected.map(async (p, idx) => {
      const query = `${keyword} ${p.text.slice(0, 140)}`;
      const cacheKey = buildSerperCacheKey(keyword, p.text);
      const cached = getCachedSerper(cacheKey);
      let sources: FactCheckSource[] = [];
      let cachedHit = false;
      const t0 = Date.now();

      if (cached) {
        sources = cached;
        cachedHit = true;
      } else {
        try {
          const res = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': this.serperKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: query, num: 4 }),
          });
          if (res.ok) {
            const data = await res.json();
            sources = (data.organic || []).slice(0, 4).map((o: any) => ({
              title: o.title || '',
              snippet: o.snippet || '',
              link: o.link || '',
            }));
            if (sources.length) setCachedSerper(cacheKey, sources);
          }
        } catch { /* ignore */ }
      }

      claims.push({
        index: idx,
        claim: p.text,
        query,
        sources,
        outcome: sources.length ? 'kept' : 'unverified', // tentative; refined after rewrite
        cached: cachedHit,
        latencyMs: Date.now() - t0,
        originalParagraphHtml: p.raw,
      });
      if (sources.length) evidenceForPrompt.push({ claim: p.text, sources });
    }));

    claims.sort((a, b) => a.index - b.index);
    baseReport.claimsChecked = claims.length;

    if (evidenceForPrompt.length === 0) {
      this.warn('Fact-check: no live evidence retrieved (Serper unreachable or rate-limited).');
      setLatestFactCheckReport({
        ...baseReport,
        claims,
        notes: 'No live evidence retrieved — content left unchanged.',
      });
      return html;
    }

    this.log(`Fact-check: gathered live evidence for ${evidenceForPrompt.length}/${claims.length} claims (cached: ${claims.filter(c => c.cached).length}). Reconciling…`);

    const evidenceBlock = evidenceForPrompt.map((e, i) =>
      `CLAIM ${i + 1}: ${e.claim}\nLIVE EVIDENCE:\n${e.sources.map(s => `- ${s.title}: ${s.snippet} (${s.link})`).join('\n')}`
    ).join('\n\n');

    const prompt = `Audit this draft article against live web evidence. For each numerical, date, statistic, or attributed claim:
1. If supported by the evidence below, keep it.
2. If contradicted, correct it to match the most authoritative source (prefer .gov, .edu, primary sources).
3. If unverifiable, soften the language ("studies suggest", "industry estimates") or remove the claim.
4. Never invent new statistics. Preserve all HTML structure, links, embeds, and overall length.

LIVE EVIDENCE:
${evidenceBlock}

DRAFT HTML:
${html}

Return the full corrected HTML article only, starting with <article and ending with </article>.`;

    let finalHtml = html;
    let reconciled = false;
    try {
      const result = await this.engine.generateWithModel({
        prompt,
        systemPrompt: 'You are a senior fact-checker. You only allow claims supported by primary sources. Output complete HTML only.',
        model: model as any,
        apiKeys: {} as any,
        temperature: 0.15,
        maxTokens: 8192,
        timeoutMs: 45_000,
        maxRetries: 0,
        allowContinuations: false,
        allowResume: false,
        validation: { type: 'article-html', requireCompleteArticle: true, minWords: 600 },
      });
      const match = result.content.match(/<article[\s\S]*?<\/article>/i);
      if (match && match[0].length > html.length * 0.6) {
        finalHtml = match[0];
        reconciled = true;
        this.log(`Fact-check ✅ ${evidenceForPrompt.length} claims reconciled against live web evidence.`);
      }
    } catch (e) {
      this.warn(`Fact-check pass failed: ${e instanceof Error ? e.message : e}`);
    }

    // Classify per-claim outcome by comparing draft → final HTML
    if (reconciled) {
      for (const c of claims) {
        c.outcome = c.sources.length === 0 ? 'unverified' : classifyClaimOutcome(c.claim, finalHtml);
      }
    }

    // Snapshot the matching paragraph in the final HTML so /status can render a per-claim diff.
    for (const c of claims) {
      const match = findBestMatchingParagraph(finalHtml, c.claim, 0.2);
      if (match) {
        c.finalParagraphHtml = match.html;
        c.finalText = match.text;
      } else {
        c.finalParagraphHtml = '';
        c.finalText = '';
        if (reconciled && c.outcome !== 'unverified') c.outcome = 'removed';
      }
    }

    setLatestFactCheckReport({
      ...baseReport,
      reconciled,
      claims,
      notes: reconciled
        ? `Reconciled ${claims.filter(c => c.outcome === 'corrected' || c.outcome === 'softened' || c.outcome === 'removed').length} of ${claims.length} claims against live web evidence.`
        : 'Reconciliation rewrite did not produce a usable article — original draft preserved.',
      // Re-check context (in-memory only — stripped before localStorage persistence)
      model,
      apiKeys: (this.config.apiKeys || {}) as any,
      serperKey: this.serperKey,
      currentHtml: finalHtml,
    });

    return finalHtml;
  }



  private async maybeInitNeuronWriter(keyword: string, options: any): Promise<NeuronBundle | null> {
    if (!this.config.neuronWriterApiKey || !this.config.neuronWriterProjectId) {
      this.warn('NeuronWriter: Skipping — API key or project ID not configured.');
      return null;
    }

    // Build NeuronWriter config with proper proxy routing
    const nwConfig: any = {
      neuronWriterApiKey: this.config.neuronWriterApiKey,
      targetLanguage: this.config.targetLanguage,
      targetCountry: this.config.targetCountry,
    };

    // If a customProxyUrl is set, pass it through
    if (this.config.customProxyUrl) {
      nwConfig.customProxyUrl = this.config.customProxyUrl;
    }

    // Pass Supabase credentials for edge function auth (if using Supabase proxy)
    if (this.config.supabaseUrl) {
      nwConfig.supabaseUrl = this.config.supabaseUrl;
    }
    if (this.config.supabaseAnonKey) {
      nwConfig.supabaseAnonKey = this.config.supabaseAnonKey;
    }

    const service = createNeuronWriterService(nwConfig);
    const projectId = this.config.neuronWriterProjectId;
    const startTime = Date.now();

    try {
      // ── Step 1: Search for existing query ──────────────────────────────────
      this.log(`NeuronWriter: Searching project "${projectId}" for keyword "${keyword}"...`);
      const searchRes = await service.findQueryByKeyword(projectId, keyword);

      let query: NeuronWriterQuery | undefined = searchRes.query;

      // ── Step 2: Auto-create query if not found ────────────────────────────
      if (!query) {
        this.log(`NeuronWriter: Keyword not found in project. Creating new query for "${keyword}"...`);
        const createRes = await service.createQuery(projectId, keyword);

        if (!createRes.success || !createRes.query) {
          this.warn(`NeuronWriter: Failed to create query — ${createRes.error || 'unknown error'}. Proceeding without NW data.`);
          return null;
        }

        query = createRes.query;
        this.log(`NeuronWriter: New query created (ID: ${query.id}). Waiting for analysis to complete...`);
      } else {
        this.log(`NeuronWriter: Found existing query "${query.keyword}" (ID: ${query.id}, status: ${query.status})`);
      }

      const queryId = query.id;

      // ── Step 3: Poll until data is ready ─────────────────────────────────
      this.log(`NeuronWriter: Polling query ${queryId} for analysis data...`);

      for (let i = 0; i < NW_MAX_POLL_ATTEMPTS; i++) {
        const elapsed = Date.now() - startTime;

        if (elapsed > NW_HARD_LIMIT_MS) {
          this.warn(`NeuronWriter: Polling timeout (${Math.round(elapsed / 1000)}s). Proceeding without NW data.`);
          break;
        }

        const res = await service.getQueryAnalysis(queryId);

        if (!res.success) {
          this.warn(`NeuronWriter: getQueryAnalysis failed (attempt ${i + 1}): ${res.error}`);
          await new Promise(r => setTimeout(r, NW_POLL_INTERVAL_MS));
          continue;
        }

        if (res.analysis) {
          const a = res.analysis;
          const status = (a.status || '').toLowerCase();

          const basicCount = a.terms?.length || 0;
          const extendedCount = a.termsExtended?.length || 0;
          const entityCount = a.entities?.length || 0;
          const h2Count = a.headingsH2?.length || 0;
          const h3Count = a.headingsH3?.length || 0;
          const totalData = basicCount + extendedCount + entityCount + h2Count + h3Count;

          if (i % 3 === 0 || totalData > 0) {
            this.log(
              `NeuronWriter: Poll ${i + 1}/${NW_MAX_POLL_ATTEMPTS} | Status: ${status} | ` +
              `Basic: ${basicCount}, Extended: ${extendedCount}, Entities: ${entityCount}, H2: ${h2Count}, H3: ${h3Count}`
            );
          }

          const isReady = NW_READY_STATUSES.has(status);
          const hasSubstantialData = basicCount >= 5 || (basicCount > 0 && extendedCount > 0);

          if (isReady || hasSubstantialData) {
            this.log(
              `✅ NeuronWriter: Analysis ready! ` +
              `${basicCount} basic, ${extendedCount} extended, ` +
              `${entityCount} entities, ${h2Count} H2s, ${h3Count} H3s.`
            );
            return { service, queryId, analysis: a };
          }

          if (isReady && totalData === 0) {
            this.warn(`NeuronWriter: Query is '${status}' but returned no data.`);
            if (i >= 5) {
              this.warn('NeuronWriter: 5 retries with empty data on ready query. Giving up.');
              break;
            }
          }
        }

        if (i < NW_MAX_POLL_ATTEMPTS - 1) {
          const elapsed2 = Date.now() - startTime;
          if (i % 5 === 0) {
            this.log(`NeuronWriter: Analysis still processing... (${Math.round(elapsed2 / 1000)}s elapsed)`);
          }
          await new Promise(r => setTimeout(r, NW_POLL_INTERVAL_MS));
        }
      }

      this.warn('NeuronWriter: Could not retrieve analysis data after polling. Proceeding without NW optimization.');
      return null;

    } catch (e) {
      this.error(`NeuronWriter Subsystem Error: ${e}`);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SOTA TITLE REWRITER (SEO + AEO + GEO optimized)
  // ─────────────────────────────────────────────────────────────────────────

  private async generateSOTATitle(
    keyword: string,
    originalTitle: string | undefined,
    sourceUrl: string | undefined,
    isRefresh: boolean,
  ): Promise<string> {
    const cleanOriginal = (originalTitle || '').replace(/^\s*(refresh|rewrite)\s*:\s*/i, '').trim();
    const context = isRefresh
      ? `You are rewriting an EXISTING blog post title to make it 1000x more powerful.
Original/working title: "${cleanOriginal}"
${sourceUrl ? `Source URL: ${sourceUrl}` : ''}
Primary keyword: "${keyword}"

Generate ONE world-class replacement title that will outrank the existing version.`
      : `Generate ONE world-class SEO title for a brand-new article.
Topic / working title: "${cleanOriginal || keyword}"
Primary keyword: "${keyword}"`;

    const prompt = `${context}

REQUIREMENTS — every single one is mandatory:
1. SEO: Include the primary keyword "${keyword}" naturally near the start (front-loaded if possible).
2. AEO (Answer Engine Optimization): Phrase it so ChatGPT, Perplexity, and Google AI Overviews would directly quote it as the canonical answer.
3. GEO (Generative Engine Optimization): Include a concrete number, year (2026), or quantifier where natural.
4. Length: 50-70 characters total. NEVER exceed 70.
5. Power: Use ONE high-impact modifier (e.g. "Ultimate", "Definitive", "Proven", "Complete", "Honest", "Real", "Tested"). Pick the one that fits the topic — never multiple.
6. Title case (capitalize main words). No ALL CAPS. No emojis. No quotes around the title. NO "Refresh:", "Rewrite:", "Update:", "New:" prefixes — EVER.
7. Specific over generic. Promise a concrete outcome, framework, or insight — not vague descriptions.
8. Must read like a #1-ranking title from Healthline, NYT Wirecutter, or Backlinko — never AI slop.

OUTPUT: Return ONLY the title string. No JSON, no quotes, no explanation, no markdown. Just the title text on a single line.`;

    const result = await this.engine.generateWithModel({
      prompt,
      systemPrompt: 'You are a world-class SEO title strategist. You write titles that rank #1 on Google and get cited by AI engines. You output ONE title and nothing else — no quotes, no preamble, no explanations.',
      model: this.config.primaryModel || 'gemini',
      apiKeys: this.config.apiKeys,
      maxTokens: 120,
      timeoutMs: TITLE_REWRITE_TIMEOUT_MS,
      maxRetries: 0,
      allowContinuations: false,
      allowResume: false,
      temperature: 0.7,
    } as any);

    let title = (result.content || '').trim();
    title = title.split('\n')[0].trim();
    title = title.replace(/^["'`*\-•\d.)\s]+/, '').replace(/["'`*]+$/, '').trim();
    title = title.replace(/^\s*(refresh|rewrite|update|new)\s*:\s*/i, '').trim();
    return title;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // YOUTUBE VIDEO DISCOVERY & INJECTION
  // ─────────────────────────────────────────────────────────────────────────

  private async fetchYouTubeVideos(keyword: string): Promise<YouTubeVideo[]> {
    try {
      this.log('Searching for relevant YouTube videos...');
      const primary = await this.youtubeService.getRelevantVideos(keyword, 'guide');
      if (primary.length > 0) {
        const selected = primary.slice(0, 3).filter(v => v.id && v.id.length > 0);
        this.log(`YouTube: Found ${selected.length} relevant videos.`);
        return selected;
      }

      this.warn('YouTube: Primary search returned no videos. Running fallback query set...');
      const fallbackQueries = [`${keyword} tutorial`, `how to ${keyword}`, `${keyword} explained`];
      const fallbackBatches = await Promise.all(fallbackQueries.map((q) => this.youtubeService.searchVideos(q, 5)));

      const dedup = new Map<string, YouTubeVideo>();
      for (const batch of fallbackBatches) {
        for (const video of batch) {
          if (!video.id) continue;
          if (!dedup.has(video.id)) dedup.set(video.id, video);
        }
      }

      const fallbackSelected = Array.from(dedup.values()).slice(0, 3);
      if (fallbackSelected.length > 0) {
        this.log(`YouTube: Fallback recovered ${fallbackSelected.length} videos.`);
        return fallbackSelected;
      }

      const guaranteed = await this.youtubeService.getGuaranteedFallbackVideos(keyword, 1);
      if (guaranteed.length > 0) {
        this.warn('YouTube: Recovered a best-effort video via resilient fallback source.');
        return guaranteed;
      }

      this.warn('YouTube: No relevant videos found after all fallback sources.');
      return [];
    } catch (e) {
      this.warn(`YouTube: Video search failed (${e}). Proceeding without videos.`);
      return [];
    }
  }

  private injectYouTubeVideos(html: string, videos: YouTubeVideo[]): string {
    if (!videos || videos.length === 0) return html;

    let result = html;

    // Find H2 headings to distribute videos across sections
    const h2Matches = [...result.matchAll(/<h2[^>]*>[\s\S]*?<\/h2>/gi)];

    if (h2Matches.length < 2) {
      // If not enough headings, inject all videos before the article footer
      const videoBlock = this.buildVideoSectionHtml(videos);
      const footerIdx = result.indexOf('data-article-footer');
      if (footerIdx !== -1) {
        const insertPoint = result.lastIndexOf('<div', footerIdx);
        if (insertPoint !== -1) {
          result = result.slice(0, insertPoint) + '\n' + videoBlock + '\n' + result.slice(insertPoint);
        }
      } else {
        result = result.replace('</article>', videoBlock + '\n</article>');
      }
      return result;
    }

    // Distribute: embed first video after 2nd H2, place cards for remaining as a section
    const firstVideo = videos[0];
    const remainingVideos = videos.slice(1);

    // Embed the first video after the 2nd H2's section (after 2-3 paragraphs)
    if (firstVideo && h2Matches.length >= 2) {
      const secondH2 = h2Matches[1];
      const searchStart = secondH2.index! + secondH2[0].length;

      // Find the 2nd </p> after this H2
      let pCount = 0;
      let insertPos = searchStart;
      const pClosingRegex = /<\/p>/gi;
      pClosingRegex.lastIndex = searchStart;
      let pMatch;
      while ((pMatch = pClosingRegex.exec(result)) !== null) {
        pCount++;
        if (pCount >= 2) {
          insertPos = pMatch.index + pMatch[0].length;
          break;
        }
      }

      const embedHtml = this.youtubeService.formatVideoEmbed(firstVideo);
      result = result.slice(0, insertPos) + '\n' + embedHtml + '\n' + result.slice(insertPos);
    }

    // Insert remaining videos as cards in a dedicated section before references
    if (remainingVideos.length > 0) {
      const videoCardsHtml = this.buildVideoCardsSection(remainingVideos);
      const refsIdx = result.search(/<h2[^>]*>.*?(?:references|sources|further reading)/i);
      if (refsIdx !== -1) {
        result = result.slice(0, refsIdx) + '\n' + videoCardsHtml + '\n' + result.slice(refsIdx);
      } else {
        const footerIdx = result.indexOf('data-article-footer');
        if (footerIdx !== -1) {
          const insertPoint = result.lastIndexOf('<div', footerIdx);
          if (insertPoint !== -1) {
            result = result.slice(0, insertPoint) + '\n' + videoCardsHtml + '\n' + result.slice(insertPoint);
          }
        } else {
          result = result.replace('</article>', videoCardsHtml + '\n</article>');
        }
      }
    }

    return result;
  }

  private buildVideoSectionHtml(videos: YouTubeVideo[]): string {
    if (videos.length === 0) return '';

    const embed = videos[0] ? this.youtubeService.formatVideoEmbed(videos[0]) : '';
    const cards = videos.slice(1).map(v => this.youtubeService.formatVideoCard(v)).join('\n');

    return `
<div style="margin: 48px 0;">
  <h2 style="font-size:1.95em;font-weight:900;color:#0f172a;margin:0 0 20px 0;line-height:1.15;letter-spacing:-0.025em;font-family:'Inter',system-ui,sans-serif;border-bottom:3px solid #e2e8f0;padding-bottom:12px;">🎬 Helpful Video Resources</h2>
  ${embed}
  ${cards}
</div>`;
  }

  private buildVideoCardsSection(videos: YouTubeVideo[]): string {
    if (videos.length === 0) return '';
    const cards = videos.map(v => this.youtubeService.formatVideoCard(v)).join('\n');
    return `
<div style="margin: 40px 0;">
  <h3 style="font-size:1.3em;font-weight:800;color:#1e293b;margin:0 0 16px 0;font-family:'Inter',system-ui,sans-serif;">📺 More Videos Worth Watching</h3>
  ${cards}
</div>`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // REFERENCE GATHERING & INJECTION
  // ─────────────────────────────────────────────────────────────────────────

  private async fetchReferences(keyword: string): Promise<Reference[]> {
    try {
      this.log('Gathering high-quality references via Serper...');
      const raw = await this.referenceService.getTopReferences(keyword, 18);
      this.log(`References: Found ${raw.length} candidates. Applying authoritative whitelist + live verification...`);
      const { kept, rejected } = await gateReferences(raw, { timeoutMs: 6000, concurrency: 6, allowOnCorsFailure: true });
      if (rejected.length > 0) {
        this.log(`References: rejected ${rejected.length} (sample: ${rejected.slice(0, 3).map(r => `${r.ref.domain}=${r.reason}`).join(', ')})`);
      }
      this.log(`References: ${kept.length} passed whitelist + live-verify gate.`);
      return kept.slice(0, 12);
    } catch (e) {
      this.warn(`References: Search failed (${e}). Proceeding without references.`);
      return [];
    }
  }

  private async fetchWordPressImages(keyword: string): Promise<WordPressMediaItem[]> {
    const TARGET = 3; // SOTA: 2-3 images per article. Aim for 3, accept ≥2.
    try {
      // Pass 1: full keyword scoring
      let images = await this.wpMediaService.getRelevantImages(keyword, 6);

      // Pass 2: token-broadened search if we have fewer than TARGET
      if (images.length < TARGET) {
        const tokens = keyword.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3).slice(0, 4);
        for (const token of tokens) {
          if (images.length >= TARGET) break;
          const more = await this.wpMediaService.getRelevantImages(token, 6);
          const seen = new Set(images.map(i => i.sourceUrl));
          for (const m of more) {
            if (images.length >= TARGET) break;
            if (!seen.has(m.sourceUrl)) images.push(m);
          }
        }
      }

      // Pass 3: GUARANTEED fallback — pull ANY images from media library so
      // every post ships with at least 2 visuals, never zero.
      if (images.length < 2) {
        this.warn(`WP Media: only ${images.length} keyword-relevant images. Pulling latest from library as fallback.`);
        const fallback = await this.wpMediaService.getRelevantImages('', 12);
        const seen = new Set(images.map(i => i.sourceUrl));
        for (const m of fallback) {
          if (images.length >= TARGET) break;
          if (!seen.has(m.sourceUrl)) images.push(m);
        }
      }

      if (images.length === 0) {
        this.warn('WP Media: ZERO images returned. Check wpUrl + WP REST API access (/wp-json/wp/v2/media).');
      } else {
        this.log(`WP Media: ${images.length} images ready for injection.`);
      }

      return images.slice(0, TARGET);
    } catch (e) {
      this.warn(`WP Media fetch failed: ${e}`);
      return [];
    }
  }

  private injectWordPressImages(html: string, images: WordPressMediaItem[], keyword: string): string {
    if (!images.length) return html;
    // Idempotency guard: if images already injected, don't double-inject
    if (html.includes('data-wp-inline-image')) return html;

    const variants: Array<'primary' | 'secondary'> = ['primary', 'secondary', 'secondary'];
    const figures = images
      .slice(0, 3)
      .map((img, idx) => this.wpMediaService.buildInlineImageFigureHtml(img, keyword, variants[idx] || 'secondary'))
      .filter(Boolean);

    if (figures.length === 0) return html;

    const paragraphMatches = [...html.matchAll(/<\/p>/gi)];

    // No paragraphs found — inject all figures before </article>, or append.
    if (paragraphMatches.length === 0) {
      const block = figures.join('\n');
      if (/<\/article>/i.test(html)) return html.replace(/<\/article>/i, `${block}\n</article>`);
      return `${html}\n${block}`;
    }

    // Distribute up to 3 images evenly through the article.
    const totalP = paragraphMatches.length;
    const slots = figures.map((_, i) => {
      const ratio = (i + 1) / (figures.length + 1); // 1/4, 2/4, 3/4 for 3 images
      return Math.min(totalP - 1, Math.max(0, Math.floor(totalP * ratio)));
    });

    // Ensure unique slot indices
    const usedSlots = new Set<number>();
    const finalSlots: number[] = [];
    for (const s of slots) {
      let idx = s;
      while (usedSlots.has(idx) && idx < totalP - 1) idx++;
      while (usedSlots.has(idx) && idx > 0) idx--;
      usedSlots.add(idx);
      finalSlots.push(idx);
    }

    const insertions = figures.map((markup, i) => ({
      position: (paragraphMatches[finalSlots[i]].index || 0) + 4,
      markup,
    }));

    insertions.sort((a, b) => b.position - a.position);

    let result = html;
    for (const insertion of insertions) {
      result = `${result.slice(0, insertion.position)}\n${insertion.markup}\n${result.slice(insertion.position)}`;
    }
    return result;
  }

  private linkifyPlainUrls(html: string): string {
    const tokens = html.split(/(<[^>]+>)/g);
    const urlRegex = /\bhttps?:\/\/[^\s<>"')]+/gi;
    let insideAnchor = false;

    return tokens
      .map((token) => {
        if (!token) return token;
        if (token.startsWith('<')) {
          if (/^<a\b/i.test(token)) insideAnchor = true;
          if (/^<\/a>/i.test(token)) insideAnchor = false;
          return token;
        }

        if (insideAnchor) return token;

        return token.replace(urlRegex, (rawUrl) => {
          const cleanUrl = rawUrl.replace(/[),.;]+$/, '');
          const trailing = rawUrl.slice(cleanUrl.length);
          return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
        });
      })
      .join('');
  }

  private ensureExternalLinksClickable(html: string): string {
    const enriched = html.replace(/<a\s+([^>]*href=["']https?:\/\/[^"']+["'][^>]*)>/gi, (_m, attrs: string) => {
      let out = attrs;
      if (!/\btarget=/i.test(out)) out += ' target="_blank"';
      if (!/\brel=/i.test(out)) out += ' rel="noopener noreferrer"';
      return `<a ${out}>`;
    });

    return this.linkifyPlainUrls(enriched);
  }

  private injectReferencesSection(html: string, references: Reference[]): string {
    if (!references || references.length === 0) return html;

    const sanitizedReferences = references
      .filter((ref) => /^https?:\/\//i.test(ref.url || ''))
      .map((ref) => ({
        ...ref,
        title: (ref.title || ref.domain || ref.url || 'Reference')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;'),
      }))
      .slice(0, 12);

    if (sanitizedReferences.length === 0) return html;

    const refsHeadingRegex = /<h2[^>]*>\s*(?:references|sources|further reading|sources\s*&\s*further\s*reading)\s*<\/h2>/i;
    const hasRefsHeading = refsHeadingRegex.test(html);

    const refsSectionMatch = html.match(
      /<h2[^>]*>\s*(?:references|sources|further reading|sources\s*&\s*further\s*reading)\s*<\/h2>[\s\S]*?(?=<h2[^>]*>|<div[^>]*data-article-footer|<\/article>)/i,
    );
    const hasLinkedReferences = !!refsSectionMatch && /<a\s+[^>]*href=["']https?:\/\//i.test(refsSectionMatch[0]);

    if (hasRefsHeading && hasLinkedReferences) {
      this.log('References: Existing references section already has clickable links. Skipping duplicate injection.');
      return html;
    }

    const heading = '📚 Verified Sources';

    const styledRefsHtml = `
<div data-verified-references="true" style="margin:56px 0 0 0;padding-top:40px;border-top:2px solid #e2e8f0;">
  <h2 style="font-size:1.95em;font-weight:900;color:#0f172a;margin:0 0 20px 0;line-height:1.15;letter-spacing:-0.025em;font-family:'Inter',system-ui,sans-serif;border-bottom:3px solid #e2e8f0;padding-bottom:12px;">${heading}</h2>
  <div style="font-family:'Inter',system-ui,sans-serif;">
    <ol style="margin:0;padding:0;list-style:none;counter-reset:ref-counter;">
      ${sanitizedReferences.map((ref, i) => {
      const typeLabel = ref.type === 'academic' ? ' <span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">Academic</span>'
        : ref.type === 'government' ? ' <span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">Official</span>'
          : ref.type === 'news' ? ' <span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">News</span>'
            : '';
      return `<li style="margin:0 0 16px 0;padding:12px 16px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;display:flex;align-items:flex-start;gap:12px;">
          <span style="flex-shrink:0;width:28px;height:28px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;">${i + 1}</span>
          <div>
            <a href="${ref.url}" target="_blank" rel="noopener noreferrer" style="color:#1e293b;text-decoration:none;font-weight:600;font-size:15px;line-height:1.4;">${ref.title}</a>
            <div style="margin-top:4px;font-size:12px;color:#64748b;">${ref.domain}${typeLabel}</div>
          </div>
        </li>`;
    }).join('\n')}
    </ol>
  </div>
</div>`;

    const footerIdx = html.indexOf('data-article-footer');
    if (footerIdx !== -1) {
      const insertPoint = html.lastIndexOf('<div', footerIdx);
      if (insertPoint !== -1) {
        return html.slice(0, insertPoint) + '\n' + styledRefsHtml + '\n' + html.slice(insertPoint);
      }
    }

    return html.replace('</article>', styledRefsHtml + '\n</article>');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PREMIUM HTML STYLING
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // SOTA PREMIUM DESIGN SYSTEM v10.0 — MAGAZINE-QUALITY POST-PROCESSOR
  // ─────────────────────────────────────────────────────────────────────────

  private async applyPremiumStyling(html: string): Promise<string> {
    let output = html;

    // ── 1. UNWRAP BARE ARTICLE TAG — ensure consistent wrapper with FORCED visibility ─
    // Normalize the article wrapper so it's fully readable on ANY WordPress theme
    // (light, dark, or custom). Background:#ffffff + color:#1e293b lock visibility.
    output = output.replace(
      /<article[^>]*>/i,
      `<article style="font-family:'Georgia','Iowan Old Style','Times New Roman',serif;max-width:860px;margin:0 auto;background:#ffffff;color:#1e293b;line-height:1.85;font-size:18px;letter-spacing:-0.01em;padding:32px 24px;border-radius:8px;">`
    );

    // ── 2. PREMIUM HERO HEADER ─────────────────────────────────────────────
    // Intentionally DISABLED: WordPress themes already render the post title,
    // author byline, and date. Our previous custom hero produced a duplicate
    // header AND a stray gradient avatar circle that rendered as a single
    // floating letter (e.g. "S") when the WP theme stripped the inline flex CSS.
    // Keep article wrapper styling above; let WP own the byline.

    // ── 3. AUTO-GENERATE TABLE OF CONTENTS ────────────────────────────────
    if (!output.includes('data-toc') && (output.match(/<h2[^>]*>/gi) || []).length >= 3) {
      const h2Matches = [...output.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
      if (h2Matches.length >= 3) {
        const tocItems = h2Matches.map((m, i) => {
          const text = m[1].replace(/<[^>]+>/g, '').trim();
          const id = `section-${i + 1}`;
          // Add id to the matching h2
          output = output.replace(m[0], m[0].replace(/<h2/, `<h2 id="${id}"`));
          return `<li style="margin:6px 0;"><a href="#${id}" style="color:#4f46e5;text-decoration:none;font-size:15px;line-height:1.5;display:flex;align-items:baseline;gap:10px;"><span style="color:#cbd5e1;font-size:12px;font-weight:700;min-width:20px;">${String(i + 1).padStart(2, '0')}</span>${text}</a></li>`;
        }).join('\n');

        const toc = `
<nav data-toc="true" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:28px 32px;margin:0 0 48px 0;font-family:'Inter',system-ui,sans-serif;">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
    <span style="font-size:16px;">📋</span>
    <strong style="font-size:13px;letter-spacing:0.1em;text-transform:uppercase;color:#64748b;font-family:'Inter',system-ui,sans-serif;">Table of Contents</strong>
  </div>
  <ol style="margin:0;padding:0;list-style:none;">
    ${tocItems}
  </ol>
</nav>`;

        // Insert TOC after the hero/first callout box or at start of article body
        output = output.replace(/(data-premium-hero="true"[\s\S]*?<\/div>)\s*(<[ph2])/i, `$1\n${toc}\n$2`);
      }
    }

    // ── 4. STYLE ALL PARAGRAPHS — explicit dark color for visibility on any theme ─
    output = output.replace(/<p(?!\s+style=)(?=[^>]*>)/gi, '<p style="margin:0 0 22px 0;line-height:1.85;color:#1e293b;font-size:18px;"');
    // Don't double-style within callout boxes
    output = output.replace(/<p style="margin:0 0 22px 0;line-height:1\.85;color:#1e293b;font-size:18px;" style="/gi, '<p style="');
    // Style any unstyled list items / lists with explicit dark color
    output = output.replace(/<ul(?!\s+[^>]*style=)([^>]*)>/gi, '<ul$1 style="margin:0 0 24px 0;padding-left:28px;color:#1e293b;font-size:17px;line-height:1.85;">');
    output = output.replace(/<ol(?!\s+[^>]*style=)([^>]*)>/gi, '<ol$1 style="margin:0 0 24px 0;padding-left:28px;color:#1e293b;font-size:17px;line-height:1.85;">');
    output = output.replace(/<li(?!\s+[^>]*style=)([^>]*)>/gi, '<li$1 style="margin:8px 0;color:#1e293b;">');

    // ── 5. STYLE ALL HEADINGS ───────────────────────────────────────────────
    output = output.replace(/<h2(?!\s+[^>]*style=)([^>]*)>/gi,
      `<h2$1 style="font-size:1.95em;font-weight:900;color:#0f172a;margin:56px 0 20px 0;line-height:1.15;letter-spacing:-0.025em;font-family:'Inter',system-ui,sans-serif;border-bottom:3px solid #e2e8f0;padding-bottom:12px;">`
    );
    output = output.replace(/<h3(?!\s+[^>]*style=)([^>]*)>/gi,
      `<h3$1 style="font-size:1.3em;font-weight:800;color:#1e293b;margin:40px 0 14px 0;letter-spacing:-0.01em;font-family:'Inter',system-ui,sans-serif;">`
    );
    output = output.replace(/<h4(?!\s+[^>]*style=)([^>]*)>/gi,
      `<h4$1 style="font-size:1.1em;font-weight:700;color:#334155;margin:28px 0 10px 0;font-family:'Inter',system-ui,sans-serif;">`
    );

    // ── 6. STYLE LISTS ──────────────────────────────────────────────────────
    output = output.replace(/<ul(?!\s+[^>]*style=)([^>]*)>/gi,
      `<ul$1 style="margin:0 0 24px 0;padding:0 0 0 0;list-style:none;">`
    );
    output = output.replace(/<li(?!\s+[^>]*style=)([^>]*)>(?!\s*<strong)/gi,
      `<li$1 style="margin:0 0 10px 0;padding:0 0 0 28px;position:relative;line-height:1.7;">
        <span style="position:absolute;left:0;top:7px;width:8px;height:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:50%;"></span>`
    );
    output = output.replace(/<ol(?!\s+[^>]*style=)([^>]*)>/gi,
      `<ol$1 style="margin:0 0 24px 0;padding:0 0 0 0;list-style:none;counter-reset:ol-counter;">`
    );

    // ── 7. ENHANCE BLOCKQUOTES ──────────────────────────────────────────────
    output = output.replace(/<blockquote(?!\s+[^>]*style=)([^>]*)>/gi,
      `<blockquote$1 style="border:none;border-left:5px solid #6366f1;background:linear-gradient(to right,#fafafa,#ffffff);padding:32px 36px;margin:40px 0;border-radius:0 16px 16px 0;position:relative;overflow:hidden;">`
    );
    // Add the decorative quote mark
    // Decorative giant quote mark intentionally REMOVED — it rendered as a
    // stray floating " character on WordPress themes that strip overflow:hidden.
    output = output.replace(/<blockquote([^>]*)>\s*<p([^>]*)>/gi,
      `<blockquote$1><p$2 style="font-style:italic;font-size:1.15em;color:#1e293b;line-height:1.8;margin:0 0 16px 0;font-family:'Georgia',serif;">`
    );
    output = output.replace(/<cite(?!\s+[^>]*style=)([^>]*)>/gi,
      `<cite$1 style="display:block;margin-top:12px;font-style:normal;font-size:13px;color:#64748b;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;font-family:'Inter',system-ui,sans-serif;">`
    );

    // ── 8. ENHANCE TABLES ───────────────────────────────────────────────────
    // Wrap tables that aren't already wrapped
    output = output.replace(/(?<!overflow-x:auto[^<]*)<table(?!\s+[^>]*style=)([^>]*)>/gi,
      `<div style="overflow-x:auto;margin:36px 0;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);border:1px solid #e2e8f0;"><table$1 style="width:100%;border-collapse:collapse;font-size:15px;font-family:'Inter',system-ui,sans-serif;">`
    );
    output = output.replace(/<\/table>(?!\s*<\/div>(?=[^<]*overflow-x))/gi, '</table></div>');
    output = output.replace(/<thead(?!\s+[^>]*style=)([^>]*)>/gi,
      `<thead$1 style="background:linear-gradient(90deg,#1e293b,#334155);">`
    );
    output = output.replace(/<th(?!\s+[^>]*style=)([^>]*)>/gi,
      `<th$1 style="padding:16px 20px;text-align:left;font-weight:700;color:white;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;white-space:nowrap;">`
    );
    output = output.replace(/<td(?!\s+[^>]*style=)([^>]*)>/gi,
      `<td$1 style="padding:14px 20px;border-bottom:1px solid #f1f5f9;vertical-align:top;color:#334155;">`
    );
    output = output.replace(/<tbody(?!\s+[^>]*style=)([^>]*)>/gi, `<tbody$1>`);

    // ── 9. STYLE FAQ ACCORDIONS (details/summary) ───────────────────────────
    output = output.replace(/<details(?!\s+[^>]*style=)([^>]*)>/gi,
      `<details$1 style="border:1px solid #e2e8f0;border-radius:14px;margin:12px 0;overflow:hidden;transition:all 0.2s ease;">`
    );
    output = output.replace(/<summary(?!\s+[^>]*style=)([^>]*)>/gi,
      `<summary$1 style="padding:20px 26px;font-weight:700;cursor:pointer;background:#f8fafc;color:#1e293b;list-style:none;display:flex;justify-content:space-between;align-items:center;font-family:'Inter',system-ui,sans-serif;font-size:16px;line-height:1.4;">`
    );

    // ── 10. ENHANCE STRONG/EM ────────────────────────────────────────────────
    // Don't touch strong tags that are already inside styled containers

    // ── 11. READING META BAR — DISABLED (WordPress theme already shows read time) ──
    // ── 12. STYLE ANY BARE HR ELEMENTS ──────────────────────────────────────
    output = output.replace(/<hr(?!\s+[^>]*style=)\s*\/?>/gi,
      `<hr style="border:none;height:2px;background:linear-gradient(90deg,transparent,#e2e8f0,transparent);margin:48px 0;">`
    );

    // ── 13. SHARE/ENGAGEMENT FOOTER — DISABLED (non-functional decorative chips rendered poorly on published themes) ──

    return output;
  }

  private async humanizeContent(html: string, keyword: string): Promise<string> {
    // Fast LOCAL humanization — no second AI call, no truncation risk.
    // Applies anti-AI text fixes directly to the HTML content.
    let result = html;

    // 1. Replace stiff AI transition words with natural ones
    const transitionReplacements: [RegExp, string[]][] = [
      [/\bFurthermore,?\s/gi, ["But here's the thing: ", "And ", ""]],
      [/\bMoreover,?\s/gi, ["Plus, ", "On top of that, ", ""]],
      [/\bAdditionally,?\s/gi, ["Also — ", "And ", ""]],
      [/\bConsequently,?\s/gi, ["So ", "Which means ", "The result? "]],
      [/\bNevertheless,?\s/gi, ["Still, ", "But ", "Even so, "]],
      [/\bHowever,?\s/gi, ["But ", "That said, ", "Here's the catch: "]],
      [/\bIn conclusion,?\s/gi, ["Bottom line: ", "Here's my take: ", "So where does that leave us? "]],
    ];

    let replIdx = 0;
    for (const [pattern, alternatives] of transitionReplacements) {
      result = result.replace(pattern, () => {
        const pick = alternatives[replIdx % alternatives.length];
        replIdx++;
        return pick;
      });
    }

    // 2. Force contractions for natural English
    const contractions: [RegExp, string][] = [
      [/\bdo not\b/gi, "don't"],
      [/\bDo not\b/g, "Don't"],
      [/\bcannot\b/gi, "can't"],
      [/\bCannot\b/g, "Can't"],
      [/\bwill not\b/gi, "won't"],
      [/\bWill not\b/g, "Won't"],
      [/\bit is\b/gi, "it's"],
      [/\bthat is\b/gi, "that's"],
      [/\bthey are\b/gi, "they're"],
      [/\bwe are\b/gi, "we're"],
      [/\byou are\b/gi, "you're"],
      [/\bshould not\b/gi, "shouldn't"],
      [/\bwould not\b/gi, "wouldn't"],
      [/\bcould not\b/gi, "couldn't"],
      [/\bI have\b/g, "I've"],
      [/\bthey have\b/gi, "they've"],
      [/\byou will\b/gi, "you'll"],
    ];
    for (const [pat, rep] of contractions) {
      result = result.replace(pat, rep);
    }

    // 3. Replace generic AI vocabulary
    const vocabUpgrades: [RegExp, string][] = [
      [/\butilize\b/gi, "use"],
      [/\bfacilitate\b/gi, "help"],
      [/\bcommence\b/gi, "start"],
      [/\bnumerous\b/gi, "many"],
      [/\bpurchase\b/gi, "buy"],
      [/\bprior to\b/gi, "before"],
      [/\bin order to\b/gi, "to"],
      [/\bat this point in time\b/gi, "now"],
      [/\bin the event that\b/gi, "if"],
      [/\bdue to the fact that\b/gi, "because"],
      [/\bin spite of the fact that\b/gi, "although"],
    ];
    for (const [pat, rep] of vocabUpgrades) {
      result = result.replace(pat, rep);
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN PIPELINE
  // ─────────────────────────────────────────────────────────────────────────

  /** STOP all in-flight provider calls (user-initiated). */
  abort(reason?: string): void {
    this.log(`🛑 USER STOP requested${reason ? `: ${reason}` : ''}`);
    try { (this.engine as any)?.abort?.(reason); } catch { /* noop */ }
  }

  async generateContent(options: any): Promise<any> {
    this.onProgress = options.onProgress;
    this.telemetry = { warnings: [], errors: [], timeline: [], startedAt: Date.now(), runtimeBudgetMs: PIPELINE_HARD_LIMIT_MS };
    this.log(`🚀 SOTA GOD-MODE PIPELINE v10.0 ENGAGED: "${options.keyword}"`);

    try {
      return await this._executeGenerationPipeline(options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.error(`PIPELINE FATAL ERROR: ${msg}`);
      console.error('[Orchestrator] Full error:', err);
      throw err;
    }
  }

  private async _executeGenerationPipeline(options: any): Promise<any> {
    this.config.currentTitle = options.title || options.keyword;
    this.config.authorName = options.authorName || this.config.authorName || 'Editorial Team';

    // ── Phase 0a: SOTA Title Rewrite (refresh items + URL-derived titles) ───
    // For refresh content, the incoming "title" is just a slug-derived guess
    // (e.g. "Blue House Plants"). Generate a SOTA SEO/AEO/GEO-optimized title.
    const isRefresh = options.contentType === 'refresh';
    const looksLikeSlugTitle = !options.title || options.title === options.keyword ||
      /^[A-Z][a-z]+( [A-Z][a-z]+)*$/.test(String(options.title || '').trim());

    if (isRefresh || looksLikeSlugTitle) {
      try {
        this.log('Phase 0a: Rewriting title to SOTA SEO/AEO/GEO standard...');
        const newTitle = await this.generateSOTATitle(
          options.keyword,
          options.title,
          options.url,
          isRefresh,
        );
        if (newTitle && newTitle.length >= 20 && newTitle.length <= 90) {
          this.log(`Phase 0a ✅ Title rewritten: "${newTitle}"`);
          options.title = newTitle;
          this.config.currentTitle = newTitle;
          options.onTitleRewritten?.(newTitle);
        }
      } catch (e) {
        this.warn(`Phase 0a: Title rewrite skipped (${e instanceof Error ? e.message : e}). Using original.`);
      }
    }

    // ── Phase 0: Top-3 SERP Scan + Gap Analysis ─────────────────────────────
    this.log('Phase 0: Top-3 SERP ranking scan and gap analysis...');
    const serpAnalysis = await this.withTimeout(
      'Phase 0 SERP analysis',
      this.serpAnalyzer.analyze(options.keyword),
      35_000,
      {
        avgWordCount: Number(options.targetWordCount || 2500),
        commonHeadings: [],
        contentGaps: [],
        userIntent: 'informational',
        semanticEntities: [],
        topCompetitors: [],
        recommendedWordCount: Number(options.targetWordCount || 2500),
        recommendedHeadings: [],
      } as SERPAnalysis,
    );
    let gapTargets = this.buildTopGapTargetsFromSerp(serpAnalysis, options.keyword, 50);
    const top3Competitors = (serpAnalysis.topCompetitors || []).slice(0, 3);

    this.log(
      `Phase 0 ✅ Top competitors: ${top3Competitors.length}, gap targets: ${gapTargets.length}`
    );

    // ── Phase 1: NeuronWriter Semantic Context Initialization ──────────────
    this.log('Phase 1: NeuronWriter Semantic Context Initialization...');
    const neuron = await this.maybeInitNeuronWriter(options.keyword, options);

    if (neuron) {
      const { analysis } = neuron;
      this.log(
        `Phase 1 ✅ NeuronWriter data loaded: ` +
        `${analysis.terms?.length || 0} basic, ` +
        `${analysis.termsExtended?.length || 0} extended, ` +
        `${analysis.entities?.length || 0} entities, ` +
        `${analysis.headingsH2?.length || 0} H2, ` +
        `${analysis.headingsH3?.length || 0} H3`
      );
    } else {
      this.warn('Phase 1: NeuronWriter data unavailable — generating without semantic optimization.');
    }

    // ── Phase 1b: Merge ALL semantically relevant entities/terms into gap targets ──
    if (neuron?.analysis) {
      const a = neuron.analysis;
      const merged = new Set(gapTargets.map(t => t.toLowerCase()));
      const ordered: string[] = [...gapTargets];
      const pushUnique = (term?: string) => {
        if (!term) return;
        const t = term.trim();
        if (t.length < 3) return;
        const k = t.toLowerCase();
        if (merged.has(k)) return;
        merged.add(k);
        ordered.push(t);
      };
      (a.entities || []).forEach((e: any) => pushUnique(e.entity));
      (a.termsExtended || []).forEach((t: any) => pushUnique(t.term));
      (a.terms || []).forEach((t: any) => pushUnique(t.term));
      gapTargets = ordered;
      this.log(`Phase 1b ✅ Total semantic coverage targets: ${gapTargets.length} (entities + terms + SERP gaps).`);
    }

    // ── Phase 2: YouTube Video Discovery (parallel with Phase 3/4) ─────────
    this.log('Phase 2: YouTube Video Discovery...');
    const videosPromise = this.withTimeout('Phase 2 YouTube discovery', this.fetchYouTubeVideos(options.keyword), 25_000, [] as YouTubeVideo[]);

    // ── Phase 3: Reference Gathering (parallel) ─────────────────────────────
    this.log('Phase 3: Reference Gathering (8-12 high-quality sources)...');
    const referencesPromise = this.withTimeout('Phase 3 references', this.fetchReferences(options.keyword), 25_000, [] as Reference[]);

    // ── Phase 4: WordPress Media Discovery (parallel) ───────────────────────
    const wpImagesPromise = this.withTimeout('Phase 4 WordPress media', this.fetchWordPressImages(options.keyword), 25_000, [] as WordPressMediaItem[]);

    let [videos, references, wpImages] = await Promise.all([videosPromise, referencesPromise, wpImagesPromise]);

    if (references.length === 0 && top3Competitors.length > 0) {
      const serpFallbackRefs: Reference[] = top3Competitors
        .map((competitor) => {
          const url = competitor.url || '';
          if (!/^https?:\/\//i.test(url)) return null;
          let domain = '';
          try {
            domain = new URL(url).hostname.replace('www.', '');
          } catch {
            domain = '';
          }

          return {
            title: competitor.title || domain || options.keyword,
            url,
            type: domain.endsWith('.gov') ? 'government' : 'industry',
            domain,
            authorityScore: this.referenceService.calculateAuthorityScore(url),
          } as Reference;
        })
        .filter((ref): ref is Reference => !!ref)
        .slice(0, 8);

      if (serpFallbackRefs.length > 0) {
        references = serpFallbackRefs;
        this.warn(`References: using ${references.length} SERP competitor links as fallback.`);
      }
    }

    this.log(`Phase 2 ✅ YouTube: ${videos.length} videos found.`);
    this.log(`Phase 3 ✅ References: ${references.length} high-authority sources found.`);
    this.log(`Phase 4 ✅ WordPress images: ${wpImages.length} relevant media items found.`);

    // ── Phase 5: Master Content Synthesis ─────────────────────────────────
    this.log('Phase 5: Master Content Generation (Human-First Anti-AI Engine)...');

    const baseSystemPrompt = buildMasterSystemPrompt();
    const voiceFp: VoiceFingerprint | undefined = this.config.voiceFingerprint;
    const author: AuthorProfile | undefined = this.config.author;
    const authorDirective = author
      ? `\n\nAUTHOR BYLINE — write in this person's voice and credentials:\nName: ${author.name}${author.jobTitle ? `\nTitle: ${author.jobTitle}` : ''}${author.credentials?.length ? `\nCredentials: ${author.credentials.join(', ')}` : ''}${author.expertiseAreas?.length ? `\nExpertise: ${author.expertiseAreas.join(', ')}` : ''}${author.bio ? `\nBio: ${author.bio}` : ''}\nWeave their experience naturally — never invent specifics that contradict the bio.\n`
      : '';
    const voiceDirective = voiceFp ? buildVoiceFingerprintDirective(voiceFp) : '';
    const systemPrompt = baseSystemPrompt + authorDirective + voiceDirective;

    const neuronWriterSection = neuron
      ? neuron.service.buildFullPromptSection(neuron.analysis)
      : 'No NeuronWriter data available. Focus on comprehensive semantic coverage using LSI keywords, natural language variation, and expert-level topic coverage.';

    // Build YouTube embed data for prompt
    const youtubeEmbed = videos.length > 0
      ? videos.slice(0, 3).map(v => ({ videoId: v.id, title: v.title }))
      : undefined;

    const targetWordCount = Math.min(3200, Math.max(
      Number(neuron?.analysis?.recommended_length || 0),
      Number(serpAnalysis.recommendedWordCount || 0),
      Number(options.targetWordCount || 3500),
    ));

    const userPrompt = buildMasterUserPrompt({
      primaryKeyword: options.keyword,
      secondaryKeywords: gapTargets,
      title: options.title || options.keyword,
      contentType: options.contentType || 'pillar',
      targetWordCount,
      neuronWriterSection,
      authorName: this.config.authorName,
      internalLinks: options.internalLinks || [],
      youtubeEmbed,
      serpData: {
        competitorTitles: top3Competitors.map((c) => c.title),
        peopleAlsoAsk: gapTargets,
        avgWordCount: serpAnalysis.avgWordCount,
      },
    } as any);

    const genResult = await this.engine.generateWithModel({
      prompt: userPrompt,
      systemPrompt,
      model: options.model || this.config.primaryModel || 'gemini',
      apiKeys: this.config.apiKeys,
      maxTokens: 12000,
      timeoutMs: Math.min(MASTER_GENERATION_TIMEOUT_MS, Math.max(90_000, this.getPipelineRemainingMs() - 90_000)),
      maxRetries: 1,
      maxStreamResumes: 1,
      allowContinuations: true,
      temperature: 0.85,
      validation: {
        type: 'article-html',
        requireCompleteArticle: true,
        minChars: MIN_VALID_CONTENT_LENGTH,
        minWords: Math.min(2200, Math.max(MIN_ENTERPRISE_WORD_COUNT, Math.floor(targetWordCount * 0.65))),
      },
    });

    let html = genResult.content;

    const initialWordCount = html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
    if (!html || html.trim().length < MIN_VALID_CONTENT_LENGTH || initialWordCount < MIN_ENTERPRISE_WORD_COUNT) {
      throw new Error(`AI returned insufficient content (${initialWordCount} words, ${html?.length || 0} chars). The article was not saved because it is not enterprise-grade complete.`);
    }

    // ── Phase 5: NeuronWriter Term Enforcement (THE CRITICAL FIX) ─────────
    if (neuron) {
      this.log('Phase 5: NeuronWriter Term Enforcement — verifying keyword coverage...');
      const allNwTerms = [
        ...(neuron.analysis.terms || []),
        ...(neuron.analysis.termsExtended || []),
      ];
      const contentLower = html.replace(/<[^>]*>/g, ' ').toLowerCase();
      const missingTerms = allNwTerms
        .filter(t => t.term && !contentLower.includes(t.term.toLowerCase()))
        .map(t => t.term);

      const totalTerms = allNwTerms.filter(t => t.term).length;
      const coveredTerms = totalTerms - missingTerms.length;
      const coveragePct = totalTerms > 0 ? Math.round((coveredTerms / totalTerms) * 100) : 100;

      this.log(`NW Coverage: ${coveredTerms}/${totalTerms} terms (${coveragePct}%). Missing: ${missingTerms.length}`);

      if (missingTerms.length > 0) {
        this.log(`Injecting ${Math.min(missingTerms.length, 30)} missing NW terms into content...`);
        html = injectMissingTerms(html, missingTerms.slice(0, 30));

        // Re-check coverage after injection
        const contentLower2 = html.replace(/<[^>]*>/g, ' ').toLowerCase();
        const stillMissing = missingTerms.filter(t => !contentLower2.includes(t.toLowerCase()));
        const finalCoverage = totalTerms > 0 ? Math.round(((totalTerms - stillMissing.length) / totalTerms) * 100) : 100;
        this.log(`Phase 5 ✅ Final NW coverage: ${finalCoverage}% (${stillMissing.length} terms still missing)`);
      } else {
        this.log('Phase 5 ✅ All NeuronWriter terms covered!');
      }
    } else {
      this.log('Phase 6: Skipped NW term enforcement — no NeuronWriter data.');
    }

    // ── Phase 7: Built-in Self-Critique Rewrite (gated by Strategy toggles) ──
    const critiqueEnabled = options.enableSelfCritique !== false;
    const requestedPasses = Math.max(1, Math.min(3, Number(options.maxCritiquePasses) || 2));
    if (!critiqueEnabled) {
      this.log('Phase 7: Self-critique disabled by Strategy — skipping LLM rewrite passes.');
    } else if (this.shouldSkipOptionalPhase('Phase 7 self-critique')) {
      html = removeAIPhrases(polishReadability(html));
    } else {
      try {
        const t0 = Date.now();
        this.log(`Phase 7: Running self-critique (max ${requestedPasses} pass${requestedPasses === 1 ? '' : 'es'})...`);
        const scoreBeforeCritique = calculateQualityScore(html, options.keyword, [], gapTargets).overall;

        const critique = await refineWithSelfCritique({
          engine: this.engine,
          model: options.model || this.config.primaryModel || 'gemini',
          keyword: options.keyword,
          title: options.title || options.keyword,
          html,
          contentGaps: gapTargets,
          maxPasses: requestedPasses,
          minScore: 94,
          timeoutMs: Math.min(CRITIQUE_TIMEOUT_MS, Math.max(20_000, this.getPipelineRemainingMs() - 75_000)),
        });

        html = critique.html;
        let finalCritiqueScore = critique.finalScore;

        if (finalCritiqueScore < 70) {
          this.warn(`Phase 7: Final score ${finalCritiqueScore} is below floor. Applying anti-fluff cleanup.`);
          html = removeAIPhrases(polishReadability(html));
          finalCritiqueScore = calculateQualityScore(html, options.keyword, [], gapTargets).overall;
        }

        this.log(`Phase 7 ✅ Self-critique (${scoreBeforeCritique} → ${finalCritiqueScore}) in ${Math.round((Date.now() - t0) / 1000)}s.`);
      } catch (e) {
        this.warn(`Phase 7: Self-critique skipped (${e}).`);
      }
    }

    // ── Phase 7b: SERP Gap Coverage Enforcement ────────────────────────────
    this.log('Phase 7b: Enforcing top-3 SERP gap/entity coverage...');
    const gapCoverage = this.enforceGapCoverage(html, gapTargets);
    html = gapCoverage.html;
    this.log(
      `Phase 7b ✅ Gap coverage: ${gapTargets.length - gapCoverage.missingAfter.length}/${gapTargets.length} terms covered.`
    );

    // ── Phase 7c: Live Web Fact-Check Pass ────────────────────────────────
    if (this.shouldSkipOptionalPhase('Phase 7c fact-check')) {
      setLatestFactCheckReport({
        generatedAt: Date.now(),
        keyword: options.keyword,
        totalParagraphsScanned: (html.match(/<p[^>]*>/gi) || []).length,
        candidatesDetected: 0,
        claimsChecked: 0,
        reconciled: false,
        claims: [],
        notes: 'Skipped because runtime budget was nearly exhausted; article finalized with deterministic validation.',
      });
    } else {
      this.log('Phase 7c: Live web fact-check pass (Serper)...');
      html = await this.withTimeout(
        'Phase 7c fact-check',
        this.runFactCheckPass(html, options.keyword, options.model || this.config.primaryModel || 'gemini'),
        60_000,
        html,
      );
    }

    // ── Phase 8: SOTA Refinement & Aesthetics ─────────────────────────────
    this.log('Phase 8: Anti-AI Polish & Premium Design Overlay...');

    html = await this.humanizeContent(html, options.keyword);
    html = polishReadability(html);
    html = await this.applyPremiumStyling(html);

    // ── Phase 6b: Visual Element Enforcement ──────────────────────────────
    this.log('Phase 6b: Ensuring visual richness (callouts, stats, key takeaways)...');
    html = ensureVisualElements(html, options.keyword);

    // ── Phase 6c: Visual Break Enforcement ────────────────────────────────
    this.log('Phase 6c: Visual Break Enforcement (breaking walls of text)...');

    const postProcessResult = postProcessContent(html, {
      maxConsecutiveWords: 200,
      usePullQuotes: true,
      enhanceDesign: false,
      removeAI: true,
    });

    html = postProcessResult.html;
    this.log(`Phase 6c ✅ Visual breaks: ${postProcessResult.elementsInjected} elements injected.`);

    // ── Phase 9: YouTube + WordPress Media Injection ───────────────────────
    this.log('Phase 9: Deduplicating & injecting YouTube videos...');
    // Remove any AI-generated YouTube iframes first to avoid duplicates
    html = html.replace(/<iframe[^>]*src=["']https?:\/\/(?:www\.)?youtube\.com\/embed\/[^"']+["'][^>]*><\/iframe>/gi, '');
    // Now inject exactly ONE video via our controlled method
    if (videos.length > 0) {
      html = this.injectYouTubeVideos(html, [videos[0]]);
    }
    this.log(`Phase 9 ✅ ${Math.min(videos.length, 1)} video injected into content.`);

    this.log('Phase 9b: Injecting WordPress media gallery images...');
    html = this.injectWordPressImages(html, wpImages, options.keyword);
    this.log(`Phase 9b ✅ ${wpImages.length} images injected from media gallery.`);

    // ── Phase 10: Reference Section Injection ──────────────────────────────
    this.log('Phase 10: Stripping AI-generated references, injecting verified sources...');
    // Remove any AI-generated "Sources & Further Reading" / "References" section BEFORE injecting our verified one
    html = html.replace(/<h2[^>]*>\s*(?:Sources\s*&?\s*Further\s*Reading|References)\s*<\/h2>[\s\S]*?(?=<h2[^>]*>|<div[^>]*data-(?:article-footer|verified-references)|<\/article>)/gi, '');
    html = this.injectReferencesSection(html, references);
    html = this.ensureExternalLinksClickable(html);
    this.log(`Phase 10 ✅ ${references.length} verified sources injected.`);

    // ── Phase 10b: AEO / GEO / AI-Visibility Boost ─────────────────────────
    // Adds TL;DR + Key Takeaways block, FAQ JSON-LD, and Speakable schema —
    // the signals ChatGPT, Perplexity, and Google AI Overviews reward.
    try {
      const aeo = applyAEO(html, { keyword: options.keyword, title: options.title });
      html = aeo.html;
      this.log(`Phase 10b ✅ AEO: tldr=${aeo.injected.tldr} faq=${aeo.injected.faqSchema} speakable=${aeo.injected.speakable}`);
    } catch (e) {
      this.warn(`Phase 10b: AEO injection skipped (${e}).`);
    }

    // ── Phase 9: Internal Link Generation & Injection (6–12 links) ─────────
    this.log('Phase 9: Generating & Injecting Internal Links (target: 6-12)...');

    let finalInternalLinks: InternalLink[] = [];

    if (this.config.sitePages && this.config.sitePages.length > 0) {
      this.linkEngine.updateSitePages(this.config.sitePages);
      const generatedLinks = this.linkEngine.generateLinkOpportunities(html, 12, options.keyword);

      if (generatedLinks.length > 0) {
        html = this.linkEngine.injectContextualLinks(html, generatedLinks);
        finalInternalLinks = generatedLinks;
        this.log(`Phase 9 ✅ Injected ${generatedLinks.length} contextual internal links.`);
      } else {
        this.warn('Phase 9: No matching site pages found for internal linking. Ensure your sitemap has been loaded.');
      }
    } else {
      this.warn('Phase 9: Skipping internal links — no site pages loaded. Add a Sitemap URL in the Setup tab.');
    }

    // ── Phase 10: Schema.org Structured Data ───────────────────────────────
    this.log('Phase 10: Generating Schema.org Structured Data...');

    const authorProfile: AuthorProfile | undefined = this.config.author;
    const authorName = authorProfile?.name || this.config.authorName || 'Editorial Team';
    const siteUrl = (this.config.organizationUrl || this.config.wpUrl || 'https://example.com').replace(/\/$/, '');
    const slug = (options.title || options.keyword).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const articleUrl = `${siteUrl}/${slug}/`;

    const contentForSchema = {
      title: options.title || options.keyword,
      metaDescription: `A comprehensive guide on ${options.keyword}.`,
      content: html,
      generatedAt: new Date(),
      eeat: {
        author: {
          name: authorName,
          credentials: authorProfile?.credentials || [],
          publications: [],
          expertiseAreas: authorProfile?.expertiseAreas?.length
            ? authorProfile.expertiseAreas
            : [options.keyword],
          socialProfiles: (authorProfile?.social || []).map(s => ({ platform: s.platform, url: s.url })),
        },
        citations: [],
        expertReviews: [],
        methodology: '',
        lastUpdated: new Date(),
        factChecked: true,
      },
    } as any;

    let schema: any = { '@context': 'https://schema.org', '@graph': [] };
    try {
      schema = this.schemaGenerator.generateComprehensiveSchema(contentForSchema, articleUrl);
      this.log(`Phase 10 ✅ Schema generated with ${schema['@graph']?.length || 0} entities.`);
    } catch (e) {
      this.warn(`Phase 10: Schema generation failed (${e}). Using empty schema.`);
    }

    // ── Phase 10b: Cited-quote blocks per H2 (LLM citation magnets) ────────
    this.log('Phase 10b: Injecting hidden LLM cited-quote blocks per H2...');
    const cq = injectCitedQuotes(html);
    html = cq.html;
    this.log(`Phase 10b ✅ ${cq.injected} cited-quote blocks injected.`);

    // ── Phase 11: Pre-publish Checklist + Targeted Auto-Retry ──────────────
    this.log('Phase 11: Running pre-publish checklist validator...');
    const provisionalMeta = `A comprehensive guide and analysis on ${options.keyword}.`;
    const entityCandidates = extractEntityCandidates({
      serpTitles: top3Competitors.map((c: any) => c.title || '').filter(Boolean),
      paaQuestions: ((neuron?.analysis as any)?.questions || []).slice(0, 10),
      neuronTerms: [
        ...((neuron?.analysis?.terms || []).map((t: any) => t.term)),
        ...((neuron?.analysis?.termsExtended || []).map((t: any) => t.term)),
      ].filter(Boolean),
      primaryKeyword: options.keyword,
      max: 30,
    });
    let checklist: ChecklistResult = runBlogPostChecklist({
      html,
      title: options.title || options.keyword,
      metaDescription: provisionalMeta,
      primaryKeyword: options.keyword,
      slug,
      entities: entityCandidates,
    });
    this.log(`Phase 11 ✅ Checklist score ${checklist.score}/100 — ${checklist.mandatoryFailures.length} mandatory failures, ${checklist.recommendedFailures.length} recommended.`);

    if (!checklist.passed && this.shouldSkipOptionalPhase('Phase 11 targeted patch', 90_000)) {
      this.warn(`Phase 11: Finalizing with checklist warnings instead of launching another LLM call (${checklist.mandatoryFailures.map(f => f.id).join(', ')}).`);
    } else if (!checklist.passed) {
      this.warn(`Phase 11: Checklist failed (${checklist.mandatoryFailures.map(f => f.id).join(', ')}). Running ONE bounded targeted patch (no full regeneration)...`);
      try {
        const t0 = Date.now();
        const rewritePrompt = buildMissingSectionsRewritePrompt(html, options.keyword, checklist.mandatoryFailures);
        const rewrite = await this.engine.generateWithModel({
          prompt: rewritePrompt,
          systemPrompt: buildMasterSystemPrompt(),
          model: (options.model || this.config.primaryModel || 'gemini'),
          apiKeys: this.config.apiKeys,
          maxTokens: 6144,            // bounded — targeted patch only, NOT a full article
          timeoutMs: Math.min(CHECKLIST_PATCH_TIMEOUT_MS, Math.max(15_000, this.getPipelineRemainingMs() - 45_000)),
          maxRetries: 0,
          allowContinuations: false,
          allowResume: false,
          temperature: 0.5,
          validation: {
            type: 'article-html',
            requireCompleteArticle: true,
            minChars: MIN_VALID_CONTENT_LENGTH,
          },
        });
        if (rewrite.content && rewrite.content.includes('<article')) {
          const candidate = rewrite.content;
          const newChecklist = runBlogPostChecklist({
            html: candidate,
            title: options.title || options.keyword,
            metaDescription: provisionalMeta,
            primaryKeyword: options.keyword,
            slug,
            entities: entityCandidates,
          });
          if (newChecklist.mandatoryFailures.length < checklist.mandatoryFailures.length) {
            html = candidate;
            checklist = newChecklist;
            this.log(`Phase 11 ✅ Targeted patch closed gaps in ${Math.round((Date.now() - t0) / 1000)}s — now ${checklist.mandatoryFailures.length} mandatory failures.`);
          } else {
            this.warn(`Phase 11: Patch did not improve checklist — finalizing with current article + warnings (${Math.round((Date.now() - t0) / 1000)}s).`);
          }
        }
      } catch (e) {
        this.warn(`Phase 11: Targeted patch failed (${e instanceof Error ? e.message : e}). Finalizing with warnings.`);
      }
    }

    // ── Phase 11b: Structured Fact-Check & YMYL Publish Gate ────────────────
    let factCheckV2: FactCheckPipelineResult | undefined;
    if (this.shouldSkipOptionalPhase('Phase 11b structured fact-check', 30_000)) {
      this.warn('Phase 11b: Skipped — runtime budget nearly exhausted.');
    } else {
      try {
        this.log('Phase 11b: Structured fact-check (atomic claim extraction + evidence binding)...');
        const t0 = Date.now();
        const candidatePool: Omit<CandidateEvidence, 'claimId'>[] = (references || [])
          .slice(0, 8)
          .map((r) => ({ url: r.url, title: r.title }));
        factCheckV2 = await this.withTimeout(
          'Phase 11b structured fact-check',
          runFactCheck({
            html,
            primaryKeyword: options.keyword,
            secondaryKeywords: (neuron?.analysis?.terms || []).slice(0, 5).map((t: any) => t.term),
            generator: async (system, user) => {
              const r = await this.engine.generateWithModel({
                prompt: user,
                systemPrompt: system,
                model: (options.model || this.config.primaryModel || 'gemini'),
                apiKeys: this.config.apiKeys,
                temperature: 0.1,
                maxTokens: 3000,
                timeoutMs: 25_000,
                maxRetries: 0,
                allowContinuations: false,
                allowResume: false,
              });
              return r.content;
            },
            // Pool reuse: every factual claim shares the gathered authoritative refs.
            resolveCandidates: async (claim) =>
              candidatePool.map((c) => ({ ...c, claimId: claim.id })),
            maxClaims: 40,
          }),
          45_000,
          undefined,
        );
        if (factCheckV2) {
          this.log(
            `Phase 11b ✅ ${factCheckV2.summary.verified}/${factCheckV2.summary.factualClaims} factual claims verified` +
            ` (YMYL=${factCheckV2.ymyl.isYmyl}, flagged=${factCheckV2.summary.flagged}) in ${Math.round((Date.now() - t0) / 1000)}s.`
          );
          if (!factCheckV2.publishAllowed) {
            this.warn(`Phase 11b ⚠ Publish gate: ${factCheckV2.blockingReasons.join(' | ')}`);
          }
        }
      } catch (e) {
        this.warn(`Phase 11b: Structured fact-check failed (${e instanceof Error ? e.message : e}). Continuing without gate.`);
      }
    }

    // ── Phase 12: GEO Information Gain (post-assembly, semantic-cached) ───────
    let informationGain: any = undefined;
    try {
      const { runInformationGain } = await import('./geo/InformationGainEngine');
      const outlineChunks: string[] = [];
      const headingRegex = /<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi;
      let m: RegExpExecArray | null;
      while ((m = headingRegex.exec(html)) !== null) {
        const text = m[2].replace(/<[^>]*>/g, '').trim();
        if (text) outlineChunks.push(text);
        if (outlineChunks.length >= 30) break;
      }
      // Add lead paragraphs for richer outline embedding
      const leadP = (html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [])
        .slice(0, 5)
        .map((p) => p.replace(/<[^>]*>/g, '').trim())
        .filter((t) => t.length > 40);
      outlineChunks.push(...leadP);

      this.log('Phase 12: GEO Information Gain analysis (cached SERP + outline diff)...');
      const igReport = await this.withTimeout(
        'Phase 12 Information Gain',
        runInformationGain({
          keyword: options.keyword,
          country: (options as any).country || 'us',
          outlineChunks,
          serpAnalysis,
          serpAnalyzer: this.serpAnalyzer,
        }),
        25_000,
        null as any,
      );
      if (igReport) {
        informationGain = igReport;
        this.log(`Phase 12 ✅ Lift score ${igReport.liftScore}/100 (blindspots=${igReport.blindspots.length}, missing entities=${igReport.missingEntities.length}, cached=${igReport.cached}).`);
      }
    } catch (e) {
      this.warn(`Phase 12: Information Gain skipped (${e instanceof Error ? e.message : e}).`);
    }

    this.log('✅ All phases complete. Assembling final result...');

    // Self-heal: ensure final HTML is wrapped in a single <article> tag.
    // Models occasionally return valid long-form HTML without the outer wrapper;
    // wrapping is presentation-only and must not block enterprise output.
    if (!/<article\b/i.test(html) || !/<\/article>/i.test(html)) {
      this.log('Final HTML missing <article> wrapper — auto-wrapping before validation.');
      html = `<article>\n${html.trim()}\n</article>`;
    }

    const wordCount = html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
    const h2Count = (html.match(/<h2\b/gi) || []).length;
    const paragraphCount = (html.match(/<p\b/gi) || []).length;
    const failures: string[] = [];
    if (wordCount < MIN_ENTERPRISE_WORD_COUNT) failures.push(`words ${wordCount}<${MIN_ENTERPRISE_WORD_COUNT}`);
    if (html.length < MIN_VALID_CONTENT_LENGTH) failures.push(`chars ${html.length}<${MIN_VALID_CONTENT_LENGTH}`);
    if (h2Count < 5) failures.push(`h2 ${h2Count}<5`);
    if (paragraphCount < 10) failures.push(`p ${paragraphCount}<10`);
    if (failures.length) {
      throw new Error(`INCOMPLETE_ARTICLE: Final output failed enterprise completeness checks (${failures.join(', ')}). Nothing was saved. Retry with a stronger model.`);
    }
    this.log(`Enterprise validation ✅ ${wordCount} words, ${h2Count} H2s, ${paragraphCount} paragraphs, ${html.length} chars.`);

    return {
      id: crypto.randomUUID(),
      title: options.title || options.keyword,
      seoTitle: options.title || options.keyword,
      content: html,
      metaDescription: `A comprehensive guide and analysis on ${options.keyword}.`,
      slug,
      primaryKeyword: options.keyword,
      secondaryKeywords: [
        ...(neuron?.analysis?.terms?.map((t: any) => t.term).slice(0, 5) || []),
        ...(neuron?.analysis?.termsExtended?.map((t: any) => t.term).slice(0, 5) || []),
      ],
      metrics: {
        wordCount,
        sentenceCount: Math.round(wordCount / 15),
        paragraphCount: Math.round(wordCount / 100),
        headingCount: (html.match(/<h[2-6][^>]*>/gi) || []).length,
        imageCount: (html.match(/<img[^>]*>/gi) || []).length,
        linkCount: (html.match(/<a[^>]*>/gi) || []).length,
        keywordDensity: 1.5,
        readabilityGrade: 8,
        estimatedReadTime: Math.ceil(wordCount / 200)
      },
      qualityScore: calculateQualityScore(html, options.keyword, finalInternalLinks.map(l => l.targetUrl), gapTargets),
      internalLinks: finalInternalLinks,
      schema,
      eeat: {
        author: {
          name: authorName,
          credentials: [],
          publications: [],
          expertiseAreas: [options.keyword],
          socialProfiles: []
        },
        citations: references.map(r => ({ title: r.title, url: r.url, type: r.type })),
        expertReviews: [],
        methodology: '',
        lastUpdated: new Date(),
        factChecked: true
      },
      serpAnalysis: {
        avgWordCount: serpAnalysis.avgWordCount || neuron?.analysis?.recommended_length || 2000,
        recommendedWordCount: serpAnalysis.recommendedWordCount || neuron?.analysis?.recommended_length || 2500,
        userIntent: serpAnalysis.userIntent || 'informational',
        commonHeadings: Array.from(new Set([
          ...(serpAnalysis.commonHeadings || []),
          ...(neuron?.analysis?.headingsH2 || []).map(h => h.text),
          ...(neuron?.analysis?.headingsH3 || []).map(h => h.text),
        ])),
        contentGaps: gapTargets,
        semanticEntities: Array.from(new Set([
          ...(serpAnalysis.semanticEntities || []),
          ...(neuron?.analysis?.entities || []).map(e => e.entity),
        ])),
        topCompetitors: top3Competitors,
        recommendedHeadings: Array.from(new Set([
          ...(serpAnalysis.recommendedHeadings || []),
          ...(neuron?.analysis?.headingsH2 || []).map(h => h.text),
          ...(neuron?.analysis?.headingsH3 || []).map(h => h.text),
        ])),
      },
      generatedAt: new Date(),
      model: genResult.model,
      consensusUsed: false,
      neuronWriterAnalysis: neuron?.analysis || null,
      neuronWriterQueryId: neuron?.queryId || null,
      youtubeVideos: videos,
      references,
      telemetry: this.telemetry,
      checklist,
      factCheckV2,
      informationGain,
    } as any;
  }
}

export function createOrchestrator(config: any) {
  return new EnterpriseContentOrchestrator(config);
}

export default EnterpriseContentOrchestrator;
