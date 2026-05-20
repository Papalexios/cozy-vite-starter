// src/lib/store.ts
// ═══════════════════════════════════════════════════════════════════════════════
// ZUSTAND STORE v2.2
// ═══════════════════════════════════════════════════════════════════════════════
//
// v2.2 Fix:
//   • FIXED: Added custom `merge` function + `rehydrateAllDates()` to persist
//     middleware so Date objects survive JSON round-trip through localStorage.
//
// ═══════════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  GodModeState,
  GodModeActivityItem,
  GodModeHistoryItem,
  GodModeConfig,
} from './sota/GodModeTypes';
import type { AuthorProfile, VoiceFingerprint } from './sota/AuthorProfiles';
import {
  DEFAULT_GOD_MODE_STATE,
  DEFAULT_GOD_MODE_CONFIG,
  DEFAULT_GOD_MODE_STATS,
} from './sota/GodModeTypes';

/** Pipeline generation config attached to each content item */
export interface GenerationPipelineConfig {
  model?: string;
  tone?: 'hormozi' | 'professional' | 'conversational' | 'academic';
  targetWordCount?: number;
  targetAudience?: string;
  contentType?: string;
  enableSerpAnalysis?: boolean;
  enableSelfCritique?: boolean;
  enableWpImages?: boolean;
  enableYouTube?: boolean;
  enableReferences?: boolean;
  maxCritiquePasses?: number;
  /** Pre-computed gap analysis data to inject into generation */
  gapData?: {
    contentGaps: string[];
    semanticEntities: string[];
    commonHeadings: string[];
    avgWordCount: number;
    recommendedWordCount: number;
    userIntent: string;
  };
  /** Secondary keywords to weave in */
  secondaryKeywords?: string[];
}

export interface ContentItem {
  id: string;
  title: string;
  type: 'pillar' | 'cluster' | 'single' | 'refresh';
  status: 'pending' | 'generating' | 'completed' | 'error';
  primaryKeyword: string;
  url?: string;
  content?: string;
  wordCount?: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  generatedContentId?: string;
  /** Pipeline config that flows to the orchestrator */
  pipelineConfig?: GenerationPipelineConfig;
}

export interface GeneratedContentStore {
  [itemId: string]: {
    id: string;
    title: string;
    seoTitle?: string;
    content: string;
    metaDescription: string;
    slug: string;
    primaryKeyword: string;
    secondaryKeywords: string[];
    wordCount: number;
    qualityScore: {
      overall: number;
      readability: number;
      seo: number;
      eeat: number;
      uniqueness: number;
      factAccuracy: number;
    };
    internalLinks: Array<{ anchorText?: string; anchor?: string; targetUrl: string; context: string }>;
    schema?: unknown;
    serpAnalysis?: {
      avgWordCount: number;
      recommendedWordCount: number;
      userIntent: string;
    };
    neuronWriterQueryId?: string;
    generatedAt: string;
    model: string;
    /** Phase 5 — populated after a successful WordPress publish. Enables rollback. */
    publishedPostId?: number;
    publishedPostUrl?: string;
    publishedAt?: string;
    /** Phase 1 draft id (if Supabase content-memory is wired). Required for rollback. */
    draftId?: string;
    /** Phase 5 — per-item publish overrides (featured image, terms, schedule). */
    publishOverrides?: {
      featuredImage?: { url: string; alt?: string; caption?: string };
      categoryNames?: string[];
      tagNames?: string[];
      scheduledDate?: string;
      canonicalUrl?: string;
    };
    /** Pre-publish checklist results (populated after generation). */
    checklist?: {
      passed: boolean;
      score: number;
      items: Array<{
        id: string;
        label: string;
        category: 'seo' | 'aeo' | 'geo' | 'eeat' | 'ux';
        severity: 'mandatory' | 'recommended';
        passed: boolean;
        detail?: string;
        fix?: string;
      }>;
    };
    /** Phase 4 — structured fact-check report (atomic claims + evidence binding). */
    factCheckV2?: {
      ymyl: { isYmyl: boolean; confidence: number; matchedTerms: string[] };
      summary: {
        totalClaims: number;
        factualClaims: number;
        verified: number;
        unverified: number;
        insufficient: number;
        stale: number;
        skipped: number;
        flagged: number;
      };
      publishAllowed: boolean;
      blockingReasons: string[];
      claims: Array<{
        claim: { id: string; paragraphIndex: number; text: string; type: 'factual' | 'opinion' | 'definitional'; rationale?: string };
        status: 'verified' | 'unverified' | 'insufficient' | 'stale' | 'skipped';
        evidence: Array<{ url: string; domain: string; lastModified?: string | null; ageDays?: number | null }>;
        reason?: string;
      }>;
    };
    /** Phase 7 — GEO Information Gain report (semantic-cached SERP diff). */
    informationGain?: {
      keyword: string;
      liftScore: number;
      blindspots: string[];
      missingEntities: Array<{ name: string; wikidataUrl?: string }>;
      contrarianAngles: string[];
      competitorUrls: string[];
      cached: boolean;
      generatedAt: string;
    };
  };
}

export interface NeuronWriterDataStore {
  [itemId: string]: {
    query_id: string;
    keyword: string;
    status: string;
    terms: Array<{ term: string; weight: number; frequency: number; type: string; usage_pc?: number; sugg_usage?: [number, number] }>;
    termsExtended?: Array<{ term: string; weight: number; frequency: number; type: string }>;
    entities?: Array<{ entity: string; type?: string; usage_pc?: number }>;
    headingsH2?: Array<{ text: string; level: string; usage_pc?: number }>;
    headingsH3?: Array<{ text: string; level: string; usage_pc?: number }>;
    recommended_length: number;
    content_score?: number;
  };
}

export interface PriorityUrl {
  id: string;
  url: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  addedAt: Date;
}

export interface NeuronWriterProject {
  id: string;
  name: string;
  queries_count?: number;
}

export interface AppConfig {
  geminiApiKey: string;
  serperApiKey: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  openrouterApiKey: string;
  groqApiKey: string;
  primaryModel: 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'groq';
  enableGoogleGrounding: boolean;
  openrouterModelId: string;
  groqModelId: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  wpUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  organizationName: string;
  logoUrl: string;
  authorName: string;
  enableNeuronWriter: boolean;
  neuronWriterApiKey: string;
  neuronWriterProjectId: string;
  neuronWriterProjectName: string;
  fallbackModels: string[]; // Ordered list: "provider:modelId" e.g. "openrouter:anthropic/claude-3.5-sonnet"
  enableGeoTargeting: boolean;
  targetCountry: string;
  targetLanguage: string;
}

interface OptimizerStore {
  // Navigation
  showOptimizer: boolean;
  setShowOptimizer: (show: boolean) => void;
  currentStep: number;
  setCurrentStep: (step: number) => void;

  // Configuration
  config: AppConfig;
  setConfig: (config: Partial<AppConfig>) => void;

  // NeuronWriter Projects
  neuronWriterProjects: NeuronWriterProject[];
  setNeuronWriterProjects: (projects: NeuronWriterProject[]) => void;
  neuronWriterLoading: boolean;
  setNeuronWriterLoading: (loading: boolean) => void;
  neuronWriterError: string | null;
  setNeuronWriterError: (error: string | null) => void;

  // Content Queue
  contentItems: ContentItem[];
  addContentItem: (item: Omit<ContentItem, 'id' | 'createdAt' | 'updatedAt'>) => void;
  addContentItemWithId: (item: ContentItem) => void;
  updateContentItem: (id: string, updates: Partial<ContentItem>) => void;
  removeContentItem: (id: string) => void;
  clearContentItems: () => void;

  // Priority URLs
  priorityUrls: PriorityUrl[];
  addPriorityUrl: (url: string, priority: PriorityUrl['priority']) => void;
  removePriorityUrl: (id: string) => void;
  clearPriorityUrls: () => void;

  // Exclusions
  excludedUrls: string[];
  excludedCategories: string[];
  setExcludedUrls: (urls: string[]) => void;
  setExcludedCategories: (categories: string[]) => void;

  // Sitemap
  sitemapUrls: string[];
  setSitemapUrls: (urls: string[]) => void;

  // God Mode Legacy
  godModeEnabled: boolean;
  priorityOnlyMode: boolean;
  setGodModeEnabled: (enabled: boolean) => void;
  setPriorityOnlyMode: (enabled: boolean) => void;

  // God Mode 2.0 State
  godModeState: GodModeState;
  setGodModeState: (updates: Partial<GodModeState>) => void;
  addGodModeActivity: (item: Omit<GodModeActivityItem, 'id' | 'timestamp'>) => void;
  addGodModeHistory: (item: GodModeHistoryItem) => void;
  updateGodModeStats: (updates: {
    totalProcessed?: number;
    successCount?: number;
    errorCount?: number;
    qualityScore?: number;
    wordCount?: number;
    cycleCount?: number;
    sessionStartedAt?: Date | null;
    lastScanAt?: Date | null;
    nextScanAt?: Date | null;
  }) => void;

  // Persisted Generated Content
  generatedContentsStore: GeneratedContentStore;
  setGeneratedContent: (itemId: string, content: GeneratedContentStore[string]) => void;
  removeGeneratedContent: (itemId: string) => void;

  // Persisted NeuronWriter Data
  neuronWriterDataStore: NeuronWriterDataStore;
  setNeuronWriterData: (itemId: string, data: NeuronWriterDataStore[string]) => void;
  removeNeuronWriterData: (itemId: string) => void;

  // Persisted Editor Auto-Save Store
  editedContentsStore: Record<string, string>;
  setEditedContent: (itemId: string, content: string) => void;
  removeEditedContent: (itemId: string) => void;
  clearEditedContents: () => void;

  // Author Profiles + Brand Voice (M2 — E-E-A-T)
  authors: AuthorProfile[];
  activeAuthorId: string | null;
  upsertAuthor: (author: AuthorProfile) => void;
  removeAuthor: (id: string) => void;
  setActiveAuthor: (id: string | null) => void;
  voiceFingerprint: VoiceFingerprint | null;
  voiceSamples: string[];
  setVoiceSamples: (samples: string[]) => void;
  setVoiceFingerprint: (fp: VoiceFingerprint | null) => void;
  /** Toggle visibility of Author Library + Brand Voice Fingerprint panel */
  eeatPanelEnabled: boolean;
  setEeatPanelEnabled: (enabled: boolean) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// ✅ FIX #5: Date rehydration helpers for persist middleware
//
// JSON.stringify converts Date objects to ISO strings ("2026-01-15T10:30:00.000Z").
// On reload, JSON.parse leaves them as strings. Any code calling .getTime(),
// .toLocaleString(), etc. would crash with "is not a function".
// These helpers convert them back to Date objects during persist rehydration.
// ─────────────────────────────────────────────────────────────────────────────

function rehydrateDateField(obj: any, key: string): void {
  if (obj && key in obj && typeof obj[key] === 'string') {
    const d = new Date(obj[key]);
    if (!isNaN(d.getTime())) {
      obj[key] = d;
    }
  }
}

/**
 * Walk targeted paths in the rehydrated state and convert ISO date strings
 * back to Date objects. Only touches fields that are typed as Date in their
 * respective interfaces — NOT the `generatedAt: string` in GeneratedContentStore.
 */
function rehydrateAllDates(state: any): void {
  // godModeState.stats
  const stats = state?.godModeState?.stats;
  if (stats) {
    rehydrateDateField(stats, 'sessionStartedAt');
    rehydrateDateField(stats, 'lastScanAt');
    rehydrateDateField(stats, 'nextScanAt');
  }

  // godModeState.activityLog[].timestamp
  if (Array.isArray(state?.godModeState?.activityLog)) {
    for (const item of state.godModeState.activityLog) {
      rehydrateDateField(item, 'timestamp');
    }
  }

  // godModeState.history[].timestamp
  if (Array.isArray(state?.godModeState?.history)) {
    for (const item of state.godModeState.history) {
      rehydrateDateField(item, 'timestamp');
    }
  }

  // godModeState.queue[].addedAt
  if (Array.isArray(state?.godModeState?.queue)) {
    for (const item of state.godModeState.queue) {
      rehydrateDateField(item, 'addedAt');
    }
  }

  // priorityUrls[].addedAt
  if (Array.isArray(state?.priorityUrls)) {
    for (const item of state.priorityUrls) {
      rehydrateDateField(item, 'addedAt');
    }
  }

  // contentItems[].createdAt, .updatedAt
  if (Array.isArray(state?.contentItems)) {
    for (const item of state.contentItems) {
      rehydrateDateField(item, 'createdAt');
      rehydrateDateField(item, 'updatedAt');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STORE
// ─────────────────────────────────────────────────────────────────────────────

export const useOptimizerStore = create<OptimizerStore>()(
  persist(
    (set) => ({
      // Navigation
      showOptimizer: false,
      setShowOptimizer: (show) => set({ showOptimizer: show }),
      currentStep: 1,
      setCurrentStep: (step) => set({ currentStep: step }),

      // Configuration
      config: {
        geminiApiKey: '',
        serperApiKey: '',
        openaiApiKey: '',
        anthropicApiKey: '',
        openrouterApiKey: '',
        groqApiKey: '',
        primaryModel: 'gemini',
        enableGoogleGrounding: false,
        openrouterModelId: 'anthropic/claude-3.5-sonnet',
        groqModelId: 'llama-3.3-70b-versatile',
        supabaseUrl: '',
        supabaseAnonKey: '',
        wpUrl: '',
        wpUsername: '',
        wpAppPassword: '',
        organizationName: '',
        logoUrl: '',
        authorName: '',
        enableNeuronWriter: false,
        neuronWriterApiKey: '',
        neuronWriterProjectId: '',
        neuronWriterProjectName: '',
        fallbackModels: [],
        enableGeoTargeting: false,
        targetCountry: 'US',
        targetLanguage: 'en',
      },
      setConfig: (updates) => set((state) => ({
        config: { ...state.config, ...updates }
      })),

      // NeuronWriter Projects
      neuronWriterProjects: [],
      setNeuronWriterProjects: (projects) => set({ neuronWriterProjects: projects }),
      neuronWriterLoading: false,
      setNeuronWriterLoading: (loading) => set({ neuronWriterLoading: loading }),
      neuronWriterError: null,
      setNeuronWriterError: (error) => set({ neuronWriterError: error }),

      // Content Queue
      contentItems: [],
      addContentItem: (item) => set((state) => ({
        contentItems: [
          ...state.contentItems,
          {
            ...item,
            id: crypto.randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      })),
      addContentItemWithId: (item) => set((state) => ({
        contentItems: [
          ...state.contentItems.filter(existing => existing.id !== item.id),
          item,
        ],
      })),
      updateContentItem: (id, updates) => set((state) => ({
        contentItems: state.contentItems.map((item) =>
          item.id === id ? { ...item, ...updates, updatedAt: new Date() } : item
        ),
      })),
      removeContentItem: (id) => set((state) => ({
        contentItems: state.contentItems.filter((item) => item.id !== id),
      })),
      clearContentItems: () => set({ contentItems: [] }),

      // Priority URLs
      priorityUrls: [],
      addPriorityUrl: (url, priority) => set((state) => ({
        priorityUrls: [
          ...state.priorityUrls,
          { id: crypto.randomUUID(), url, priority, addedAt: new Date() },
        ],
      })),
      removePriorityUrl: (id) => set((state) => ({
        priorityUrls: state.priorityUrls.filter((u) => u.id !== id),
      })),
      clearPriorityUrls: () => set({ priorityUrls: [] }),

      // Exclusions
      excludedUrls: [],
      excludedCategories: [],
      setExcludedUrls: (urls) => set({ excludedUrls: urls }),
      setExcludedCategories: (categories) => set({ excludedCategories: categories }),

      // Sitemap
      sitemapUrls: [],
      setSitemapUrls: (urls) => set({ sitemapUrls: urls }),

      // God Mode
      godModeEnabled: false,
      priorityOnlyMode: false,
      setGodModeEnabled: (enabled) => set({ godModeEnabled: enabled }),
      setPriorityOnlyMode: (enabled) => set({ priorityOnlyMode: enabled }),

      // God Mode 2.0 State
      godModeState: DEFAULT_GOD_MODE_STATE,
      setGodModeState: (updates) => set((state) => ({
        godModeState: { ...state.godModeState, ...updates }
      })),
      addGodModeActivity: (item) => set((state) => ({
        godModeState: {
          ...state.godModeState,
          activityLog: [
            {
              id: crypto.randomUUID(),
              timestamp: new Date(),
              ...item,
            },
            ...state.godModeState.activityLog.slice(0, 99),
          ],
        }
      })),
      addGodModeHistory: (item) => set((state) => ({
        godModeState: {
          ...state.godModeState,
          history: [item, ...state.godModeState.history.slice(0, 99)],
        }
      })),
      updateGodModeStats: (updates) => set((state) => {
        const stats = state.godModeState.stats;
        const newTotal = stats.totalProcessed + (updates.totalProcessed || 0);
        const newSuccess = stats.successCount + (updates.successCount || 0);
        const newError = stats.errorCount + (updates.errorCount || 0);
        const newWords = stats.totalWordsGenerated + (updates.wordCount || 0);

        let newAvgQuality = stats.avgQualityScore;
        if (updates.qualityScore && updates.qualityScore > 0) {
          const totalQuality = stats.avgQualityScore * stats.totalProcessed + updates.qualityScore;
          newAvgQuality = newTotal > 0 ? totalQuality / newTotal : updates.qualityScore;
        }

        return {
          godModeState: {
            ...state.godModeState,
            stats: {
              ...stats,
              totalProcessed: newTotal,
              successCount: newSuccess,
              errorCount: newError,
              avgQualityScore: newAvgQuality,
              totalWordsGenerated: newWords,
              ...(updates.cycleCount !== undefined && { cycleCount: updates.cycleCount }),
              ...(updates.sessionStartedAt !== undefined && { sessionStartedAt: updates.sessionStartedAt }),
              ...(updates.lastScanAt !== undefined && { lastScanAt: updates.lastScanAt }),
              ...(updates.nextScanAt !== undefined && { nextScanAt: updates.nextScanAt }),
            }
          }
        };
      }),

      // Persisted Generated Content Store
      generatedContentsStore: {},
      setGeneratedContent: (itemId, content) => set((state) => ({
        generatedContentsStore: { ...state.generatedContentsStore, [itemId]: content }
      })),
      removeGeneratedContent: (itemId) => set((state) => {
        const { [itemId]: _, ...rest } = state.generatedContentsStore;
        return { generatedContentsStore: rest };
      }),

      // Persisted NeuronWriter Data Store
      neuronWriterDataStore: {},
      setNeuronWriterData: (itemId, data) => set((state) => ({
        neuronWriterDataStore: { ...state.neuronWriterDataStore, [itemId]: data }
      })),
      removeNeuronWriterData: (itemId) => set((state) => {
        const { [itemId]: _, ...rest } = state.neuronWriterDataStore;
        return { neuronWriterDataStore: rest };
      }),

      // Persisted Editor Auto-Save Store
      editedContentsStore: {},
      setEditedContent: (itemId, content) => set((state) => ({
        editedContentsStore: { ...state.editedContentsStore, [itemId]: content }
      })),
      removeEditedContent: (itemId) => set((state) => {
        const { [itemId]: _, ...rest } = state.editedContentsStore;
        return { editedContentsStore: rest };
      }),
      clearEditedContents: () => set({ editedContentsStore: {} }),

      // Author Profiles + Brand Voice
      authors: [],
      activeAuthorId: null,
      upsertAuthor: (author) => set((state) => {
        const exists = state.authors.some(a => a.id === author.id);
        return {
          authors: exists
            ? state.authors.map(a => a.id === author.id ? author : a)
            : [...state.authors, author],
          activeAuthorId: state.activeAuthorId || author.id,
        };
      }),
      removeAuthor: (id) => set((state) => ({
        authors: state.authors.filter(a => a.id !== id),
        activeAuthorId: state.activeAuthorId === id ? null : state.activeAuthorId,
      })),
      setActiveAuthor: (id) => set({ activeAuthorId: id }),
      voiceFingerprint: null,
      voiceSamples: [],
      setVoiceSamples: (samples) => set({ voiceSamples: samples }),
      setVoiceFingerprint: (fp) => set({ voiceFingerprint: fp }),
      eeatPanelEnabled: true,
      setEeatPanelEnabled: (enabled) => set({ eeatPanelEnabled: enabled }),
    }),
    {
      name: 'wp-optimizer-storage',

      // ✅ FIX #5: Rehydrate Date objects that were serialized to ISO strings
      merge: (persistedState, currentState) => {
        const merged = {
          ...currentState,
          ...(persistedState as object),
        };
        rehydrateAllDates(merged);
        return merged;
      },
    }
  )
);
