import { useState, useCallback, useMemo, useRef } from "react";
import { useOptimizerStore, type ContentItem, type GeneratedContentStore, type NeuronWriterDataStore } from "@/lib/store";
import {
  FileText, Check, X, AlertCircle, Trash2,
  Sparkles, ArrowUpDown, Eye, Brain, ArrowRight,
  CheckCircle, Clock, XCircle, Loader2, Database, Upload,
  Image as ImageIcon, Tag, Calendar as CalendarIcon, Undo2, ChevronDown
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createOrchestrator, globalPerformanceTracker, type GeneratedContent, type NeuronWriterAnalysis } from "@/lib/sota";
import { ContentViewerPanel } from "../ContentViewerPanel";
import { EnhancedGenerationModal, type GenerationStep } from "../EnhancedGenerationModal";
import { ContentIntelligenceDashboard } from "../ContentIntelligenceDashboard";
import { useSupabaseSyncContext } from "@/providers/SupabaseSyncProvider";
import { useWordPressPublish } from "@/hooks/useWordPressPublish";
import { rollbackToRevision } from "@/lib/wordpress/rollback";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import PublishVerificationChecklist from "../PublishVerificationChecklist";

// Helper to reconstruct GeneratedContent from persisted store (minimal shape for viewer)
function reconstructGeneratedContent(stored: GeneratedContentStore[string] | undefined): GeneratedContent | null {
  if (!stored) return null;
  return {
    id: stored.id,
    title: stored.title,
    seoTitle: stored.seoTitle,
    content: stored.content,
    metaDescription: stored.metaDescription,
    slug: stored.slug,
    primaryKeyword: stored.primaryKeyword,
    secondaryKeywords: stored.secondaryKeywords,
    metrics: {
      wordCount: stored.wordCount,
      sentenceCount: Math.round(stored.wordCount / 15),
      paragraphCount: Math.round(stored.wordCount / 100),
      headingCount: 10,
      imageCount: 0,
      linkCount: stored.internalLinks?.length || 0,
      keywordDensity: 1.5,
      readabilityGrade: 7,
      estimatedReadTime: Math.ceil(stored.wordCount / 200),
    },
    qualityScore: {
      ...stored.qualityScore,
      passed: stored.qualityScore.overall >= 95,
      improvements: [],
    },
    internalLinks: (stored.internalLinks || []).map(l => ({
      ...l,
      priority: 1,
      relevanceScore: 0.8,
    })),
    schema: (stored.schema as GeneratedContent['schema']) || { '@context': 'https://schema.org', '@graph': [] },
    eeat: {
      author: { name: '', credentials: [], publications: [], expertiseAreas: [], socialProfiles: [] },
      citations: [],
      expertReviews: [],
      methodology: '',
      lastUpdated: new Date(),
      factChecked: false,
    },
    serpAnalysis: stored.serpAnalysis ? {
      avgWordCount: stored.serpAnalysis.avgWordCount,
      recommendedWordCount: stored.serpAnalysis.recommendedWordCount,
      userIntent: stored.serpAnalysis.userIntent as 'informational' | 'transactional' | 'navigational' | 'commercial',
      commonHeadings: [],
      contentGaps: [],
      semanticEntities: [],
      topCompetitors: [],
      recommendedHeadings: [],
    } : {
      avgWordCount: stored.wordCount,
      recommendedWordCount: 2500,
      userIntent: 'informational' as const,
      commonHeadings: [],
      contentGaps: [],
      semanticEntities: [],
      topCompetitors: [],
      recommendedHeadings: [],
    },
    generatedAt: new Date(stored.generatedAt),
    model: stored.model as GeneratedContent['model'],
    consensusUsed: false,
    neuronWriterQueryId: stored.neuronWriterQueryId,
  };
}

// Helper to reconstruct NeuronWriterAnalysis from persisted store
// Populates BOTH old-style (terms, headingsH2) AND new-style (basicKeywords, h2Suggestions) fields
// so the structured NeuronWriterTab view renders correctly instead of falling to legacy view.
function reconstructNeuronData(stored: NeuronWriterDataStore[string] | undefined): NeuronWriterAnalysis | null {
  if (!stored) return null;

  const terms = stored.terms.map(t => ({ ...t, type: t.type as 'required' | 'recommended' | 'optional' }));
  const termsExtended = stored.termsExtended?.map(t => ({ ...t, type: t.type as 'required' | 'recommended' | 'optional' })) || [];
  const entities = stored.entities?.map(e => ({ entity: e.entity, type: e.type, usage_pc: e.usage_pc })) || [];
  const headingsH2 = stored.headingsH2?.map(h => ({ text: h.text, level: 'h2' as const, usage_pc: h.usage_pc })) || [];
  const headingsH3 = stored.headingsH3?.map(h => ({ text: h.text, level: 'h3' as const, usage_pc: h.usage_pc })) || [];

  // Map old-style terms → new-style basicKeywords/extendedKeywords for NeuronWriterTab structured view
  const basicKeywords = terms.map(t => ({
    term: t.term,
    type: 'basic' as const,
    weight: t.weight,
    recommended: t.sugg_usage ? t.sugg_usage[1] : Math.max(1, Math.round(t.weight * 3)),
    frequency: 0,
    found: 0,
    status: 'missing' as const,
  }));

  const extendedKeywords = termsExtended.map(t => ({
    term: t.term,
    type: 'extended' as const,
    weight: t.weight,
    recommended: Math.max(1, Math.round(t.weight * 2)),
    frequency: 0,
    found: 0,
    status: 'missing' as const,
  }));

  const h2Suggestions = headingsH2.map(h => ({
    text: h.text,
    level: 'h2' as const,
    relevanceScore: h.usage_pc ? Math.round(h.usage_pc * 100) : undefined,
  }));

  const h3Suggestions = headingsH3.map(h => ({
    text: h.text,
    level: 'h3' as const,
    relevanceScore: h.usage_pc ? Math.round(h.usage_pc * 100) : undefined,
  }));

  return {
    query_id: stored.query_id,
    keyword: stored.keyword,
    status: stored.status,
    // Old-style fields (for live scoring, backward compat)
    terms,
    termsExtended,
    entities,
    headingsH2,
    headingsH3,
    recommended_length: stored.recommended_length,
    content_score: stored.content_score,
    // New-style fields (for NeuronWriterTab structured view)
    basicKeywords,
    extendedKeywords,
    h2Suggestions,
    h3Suggestions,
    recommendations: {
      targetWordCount: stored.recommended_length || 2500,
      targetScore: 90,
      minH2Count: headingsH2.length > 0 ? Math.min(6, headingsH2.length) : 6,
      minH3Count: headingsH3.length > 0 ? Math.min(8, headingsH3.length) : 8,
      contentGaps: [],
    },
  };
}

export function ReviewExport() {
  const {
    contentItems,
    updateContentItem,
    removeContentItem,
    config,
    sitemapUrls,
    // Persisted stores - survives navigation!
    generatedContentsStore,
    setGeneratedContent,
    removeGeneratedContent,
    neuronWriterDataStore,
    setNeuronWriterData,
    removeNeuronWriterData,
  } = useOptimizerStore();

  // Supabase sync for database persistence
  const { saveToSupabase, isConnected: dbConnected, isLoading: dbLoading, tableMissing, error: dbError, isOfflineMode } = useSupabaseSyncContext();
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [sortField, setSortField] = useState<'title' | 'type' | 'status' | 'generatedAt'>('generatedAt');
  const [sortAsc, setSortAsc] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);

  // Content Viewer State - now uses persisted store
  const [viewingItem, setViewingItem] = useState<ContentItem | null>(null);

  // Generation State
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [currentItemIndex, setCurrentItemIndex] = useState(0);
  const [generationSteps, setGenerationSteps] = useState<GenerationStep[]>([]);
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [generatingItems, setGeneratingItems] = useState<Array<{
    id: string;
    title: string;
    keyword: string;
    status: 'pending' | 'generating' | 'completed' | 'error';
    progress: number;
    currentStep?: string;
    error?: string;
  }>>([]);
  const [streamTelemetry, setStreamTelemetry] = useState<{
    status: 'idle' | 'connecting' | 'streaming' | 'resuming' | 'completed' | 'aborted';
    chars: number;
    tokens: number;
    cps?: number;
    phase?: number;
    phaseLabel?: string;
    snippet?: string;
    modelId?: string;
    note?: string;
  }>({ status: 'idle', chars: 0, tokens: 0 });
  const [generationLog, setGenerationLog] = useState<Array<{ t: number; msg: string; phase?: number; level: 'info' | 'sse' | 'warn' | 'error' }>>([]);
  const orchestratorRef = useRef<{ abort: (reason?: string) => void } | null>(null);
  const userAbortRef = useRef(false);

  const handleStopGeneration = useCallback(() => {
    userAbortRef.current = true;
    try { orchestratorRef.current?.abort('user clicked STOP'); } catch { /* noop */ }
    setStreamTelemetry(prev => ({ ...prev, status: 'aborted', note: 'Stopped by user' }));
    setGenerationLog(prev => [...prev, { t: Date.now(), msg: '🛑 STOP requested by user — aborting all in-flight requests…', level: 'warn' }]);
    toast.warning('Generation stop requested. Finishing current network call then aborting…');
  }, []);

  // ── Bulk Publish State ──
  const { publish, isConfigured: wpConfigured } = useWordPressPublish();
  const [isBulkPublishing, setIsBulkPublishing] = useState(false);
  const [showBulkPublishModal, setShowBulkPublishModal] = useState(false);
  const [bulkPublishStatus, setBulkPublishStatus] = useState<'idle' | 'draft' | 'publish'>('draft');
  const [bulkPublishItems, setBulkPublishItems] = useState<Array<{
    id: string;
    title: string;
    status: 'pending' | 'publishing' | 'published' | 'error';
    error?: string;
    postUrl?: string;
  }>>([]);

  // ── Phase 5 — bulk publish overrides (apply to every item in the queue) ──
  const [showAdvancedPublish, setShowAdvancedPublish] = useState(false);
  const [pubFeaturedImageUrl, setPubFeaturedImageUrl] = useState('');
  const [pubFeaturedImageAlt, setPubFeaturedImageAlt] = useState('');
  const [pubCategoryNames, setPubCategoryNames] = useState('');
  const [pubTagNames, setPubTagNames] = useState('');
  const [pubScheduledDate, setPubScheduledDate] = useState(''); // datetime-local value
  const [pubCanonicalUrl, setPubCanonicalUrl] = useState('');

  // ── Phase 5 — per-row rollback state ──
  const [rollbackBusyId, setRollbackBusyId] = useState<string | null>(null);

  const handleRollback = useCallback(async (itemId: string) => {
    const stored = generatedContentsStore[itemId];
    if (!stored) return;
    if (!stored.draftId) {
      toast.error('Rollback unavailable: no Supabase draft history for this item.');
      return;
    }
    if (!stored.publishedPostId) {
      toast.error('Rollback unavailable: this item has not been published yet.');
      return;
    }
    if (!config.wpUrl || !config.wpUsername || !config.wpAppPassword) {
      toast.error('WordPress credentials missing. Configure them in Setup first.');
      return;
    }
    if (!confirm('Rollback this post to the previous saved revision? This will overwrite the live WordPress post.')) return;

    setRollbackBusyId(itemId);
    try {
      const res = await rollbackToRevision({
        draftId: stored.draftId,
        wp: {
          wpUrl: config.wpUrl,
          username: config.wpUsername,
          appPassword: config.wpAppPassword,
          title: stored.seoTitle || stored.title,
          existingPostId: stored.publishedPostId,
          slug: stored.slug,
        },
        status: 'publish',
        metaDescription: stored.metaDescription,
        seoTitle: stored.seoTitle,
      });
      if (res.success) {
        toast.success(`Rolled back to v${res.restoredVersion}.`);
      } else {
        toast.error(`Rollback failed: ${res.error || 'unknown error'}`);
      }
    } catch (e) {
      toast.error(`Rollback error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRollbackBusyId(null);
    }
  }, [generatedContentsStore, config]);

  // Count selected completed items that can be published
  const publishableSelected = useMemo(() => {
    return contentItems.filter(
      i => selectedItems.includes(i.id) && i.status === 'completed' && generatedContentsStore[i.id]
    );
  }, [contentItems, selectedItems, generatedContentsStore]);

  const allPublishable = useMemo(() => {
    return contentItems.filter(
      i => i.status === 'completed' && generatedContentsStore[i.id]
    );
  }, [contentItems, generatedContentsStore]);

  // Items blocked from publishing because the pre-publish checklist failed.
  const checklistBlocked = useMemo(() => {
    const blocked: Array<{ id: string; title: string; failures: Array<{ id: string; label: string; fix?: string }> }> = [];
    for (const item of allPublishable) {
      const cl = generatedContentsStore[item.id]?.checklist;
      if (cl && !cl.passed) {
        blocked.push({
          id: item.id,
          title: item.title,
          failures: cl.items.filter(i => i.severity === 'mandatory' && !i.passed)
            .map(i => ({ id: i.id, label: i.label, fix: i.fix })),
        });
      }
    }
    return blocked;
  }, [allPublishable, generatedContentsStore]);

  // Items blocked because the YMYL fact-check publish gate failed (Phase 4).
  const factCheckBlocked = useMemo(() => {
    const blocked: Array<{ id: string; title: string; flagged: number; reasons: string[] }> = [];
    for (const item of allPublishable) {
      const fc = generatedContentsStore[item.id]?.factCheckV2;
      if (fc && !fc.publishAllowed) {
        blocked.push({
          id: item.id,
          title: item.title,
          flagged: fc.summary.flagged,
          reasons: fc.blockingReasons,
        });
      }
    }
    return blocked;
  }, [allPublishable, generatedContentsStore]);

  const [showChecklistReport, setShowChecklistReport] = useState<string | null>(null);

  const handleBulkPublish = useCallback(async () => {
    const candidates = publishableSelected.length > 0 ? publishableSelected : allPublishable;
    // PRE-PUBLISH GATE: block items whose checklist failed OR YMYL fact-check denied publish.
    const itemsToPublish = candidates.filter(item => {
      const stored = generatedContentsStore[item.id];
      const cl = stored?.checklist;
      const fc = stored?.factCheckV2;
      if (cl && !cl.passed) return false;
      if (fc && !fc.publishAllowed) return false;
      return true;
    });
    const blocked = candidates.length - itemsToPublish.length;
    if (blocked > 0) {
      toast.error(`${blocked} post(s) blocked: pre-publish checklist or YMYL fact-check failed. Open the row to see what's missing.`);
    }
    if (itemsToPublish.length === 0 || !wpConfigured) return;

    setIsBulkPublishing(true);
    const items = itemsToPublish.map(item => ({
      id: item.id,
      title: item.title,
      status: 'pending' as const,
    }));
    setBulkPublishItems(items);

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < itemsToPublish.length; i++) {
      const item = itemsToPublish[i];
      const stored = generatedContentsStore[item.id];
      if (!stored) continue;

      setBulkPublishItems(prev =>
        prev.map((p, idx) => idx === i ? { ...p, status: 'publishing' } : p)
      );

      try {
        const cleanTitle = (stored.seoTitle || stored.title || item.title)
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .trim();

        // Phase 5 — bulk overrides + per-item overrides (per-item wins)
        const itemOverrides = stored.publishOverrides || {};
        const bulkCategoryNames = pubCategoryNames.split(',').map(s => s.trim()).filter(Boolean);
        const bulkTagNames = pubTagNames.split(',').map(s => s.trim()).filter(Boolean);
        const featuredImage = itemOverrides.featuredImage
          ?? (pubFeaturedImageUrl ? { url: pubFeaturedImageUrl, alt: pubFeaturedImageAlt || cleanTitle } : undefined);
        const categoryNames = itemOverrides.categoryNames ?? (bulkCategoryNames.length ? bulkCategoryNames : undefined);
        const tagNames = itemOverrides.tagNames ?? (bulkTagNames.length ? bulkTagNames : undefined);
        const scheduledDate = itemOverrides.scheduledDate
          ?? (pubScheduledDate ? new Date(pubScheduledDate).toISOString() : undefined);
        const canonicalUrl = itemOverrides.canonicalUrl ?? (pubCanonicalUrl || undefined);

        const result = await publish(cleanTitle, stored.content, {
          status: scheduledDate ? 'future' : (bulkPublishStatus === 'publish' ? 'publish' : 'draft'),
          slug: stored.slug,
          metaDescription: stored.metaDescription,
          seoTitle: stored.seoTitle,
          sourceUrl: item.url,
          existingPostId: stored.publishedPostId,
          draftId: stored.draftId,
          featuredImage,
          categoryNames,
          tagNames,
          scheduledDate,
          canonicalUrl,
          schemaJson: stored.schema,
        });

        if (result.success) {
          successCount++;
          // Phase 5 — persist publishedPostId so rollback can target it later
          setGeneratedContent(item.id, {
            ...stored,
            publishedPostId: result.postId ?? stored.publishedPostId,
            publishedPostUrl: result.postUrl ?? stored.publishedPostUrl,
            publishedAt: new Date().toISOString(),
          });
          setBulkPublishItems(prev =>
            prev.map((p, idx) => idx === i ? { ...p, status: 'published', postUrl: result.postUrl } : p)
          );
        } else {
          errorCount++;
          setBulkPublishItems(prev =>
            prev.map((p, idx) => idx === i ? { ...p, status: 'error', error: result.error } : p)
          );
        }
      } catch (err) {
        errorCount++;
        setBulkPublishItems(prev =>
          prev.map((p, idx) => idx === i ? {
            ...p,
            status: 'error',
            error: err instanceof Error ? err.message : 'Unknown error',
          } : p)
        );
      }

      // Small delay between publishes to avoid overwhelming the API
      if (i < itemsToPublish.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    setIsBulkPublishing(false);

    if (successCount > 0 && errorCount === 0) {
      toast.success(`✅ All ${successCount} posts published successfully!`);
    } else if (successCount > 0) {
      toast.warning(`Published ${successCount} posts, ${errorCount} failed`);
    } else {
      toast.error(`Failed to publish all ${errorCount} posts`);
    }
  }, [publishableSelected, allPublishable, wpConfigured, generatedContentsStore, publish, bulkPublishStatus]);

  const toggleSelect = (id: string) => {
    setSelectedItems(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedItems.length === contentItems.length) {
      setSelectedItems([]);
    } else {
      setSelectedItems(contentItems.map(i => i.id));
    }
  };

  // Create default steps
  const createDefaultSteps = (): GenerationStep[] => [
    { id: 'research', label: 'SERP Analysis', description: 'Analyzing top-ranking content', status: 'pending', icon: null },
    { id: 'videos', label: 'YouTube Discovery', description: 'Finding relevant video content', status: 'pending', icon: null },
    { id: 'references', label: 'Reference Gathering', description: 'Collecting authoritative sources', status: 'pending', icon: null },
    { id: 'outline', label: 'Content Outline', description: 'Structuring the article', status: 'pending', icon: null },
    { id: 'content', label: 'AI Generation', description: 'Creating comprehensive content', status: 'pending', icon: null },
    { id: 'enhance', label: 'Content Enhancement', description: 'Optimizing for readability', status: 'pending', icon: null },
    { id: 'links', label: 'Internal Linking', description: 'Adding strategic links', status: 'pending', icon: null },
    { id: 'validate', label: 'Quality Validation', description: 'Ensuring content standards', status: 'pending', icon: null },
    { id: 'schema', label: 'Schema Generation', description: 'Creating structured data', status: 'pending', icon: null },
  ];

  const updateStep = useCallback((stepId: string, status: GenerationStep['status'], message?: string) => {
    setGenerationSteps(prev => prev.map(s =>
      s.id === stepId ? { ...s, status, message } : s
    ));
  }, []);

  const handleGenerate = async () => {
    const toGenerate = contentItems.filter(i => selectedItems.includes(i.id) && (i.status === 'pending' || i.status === 'error'));
    if (toGenerate.length === 0) return;

    // Initialize generation state
    setIsGenerating(true);
    setGenerationProgress(0);
    setCurrentItemIndex(0);
    setGenerationError(undefined);
    setStreamTelemetry({ status: 'idle', chars: 0, tokens: 0 });
    setGenerationLog([{ t: Date.now(), msg: `🚀 Engaging SOTA pipeline for ${toGenerate.length} item(s)…`, level: 'info' }]);
    userAbortRef.current = false;
    setGenerationSteps(createDefaultSteps());
    setGeneratingItems(toGenerate.map(item => ({
      id: item.id,
      title: item.title,
      keyword: item.primaryKeyword,
      status: 'pending',
      progress: 0,
    })));

    // Build site pages with proper titles extracted from URLs
    const sitePages = sitemapUrls.map(url => {
      try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        // Extract slug and convert to title
        const slug = pathname.split('/').filter(Boolean).pop() || '';
        const title = slug
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
          .trim() || urlObj.hostname;
        return { url, title, keywords: slug.split('-').filter(w => w.length > 2) };
      } catch {
        return { url, title: url, keywords: [] };
      }
    });

    console.log(`[ReviewExport] Creating orchestrator with ${sitePages.length} site pages for internal linking`);

    const orchestrator = createOrchestrator({
      apiKeys: {
        geminiApiKey: config.geminiApiKey,
        openaiApiKey: config.openaiApiKey,
        anthropicApiKey: config.anthropicApiKey,
        openrouterApiKey: config.openrouterApiKey,
        groqApiKey: config.groqApiKey,
        serperApiKey: config.serperApiKey,
        openrouterModelId: config.openrouterModelId,
        groqModelId: config.groqModelId,
        fallbackModels: config.fallbackModels || [],
      },
      organizationName: config.organizationName || 'Content Hub',
      organizationUrl: config.wpUrl || 'https://example.com',
      logoUrl: config.logoUrl,
      authorName: config.authorName || 'Content Team',
      author: useOptimizerStore.getState().authors.find(a => a.id === useOptimizerStore.getState().activeAuthorId) || undefined,
      voiceFingerprint: useOptimizerStore.getState().voiceFingerprint || undefined,
      wpUrl: config.wpUrl,
      wpUsername: config.wpUsername,
      wpAppPassword: config.wpAppPassword,
      sitePages,
      primaryModel: config.primaryModel,
      useConsensus: false,
      // NeuronWriter integration - FAILSAFE: Use key if present even if flag is flaky
      neuronWriterApiKey: (config.enableNeuronWriter || (config.neuronWriterApiKey && config.neuronWriterApiKey.length > 10)) ? config.neuronWriterApiKey : undefined,
      neuronWriterProjectId: (config.enableNeuronWriter || (config.neuronWriterApiKey && config.neuronWriterApiKey.length > 10)) ? config.neuronWriterProjectId : undefined,
    });
    orchestratorRef.current = orchestrator as unknown as { abort: (reason?: string) => void };

    if (config.enableNeuronWriter || (config.neuronWriterApiKey && config.neuronWriterApiKey.length > 10)) {
      console.log(`[ReviewExport] NeuronWriter ACTIVATED with project: ${config.neuronWriterProjectName || config.neuronWriterProjectId} (Flag: ${config.enableNeuronWriter}, Key Present: ${!!config.neuronWriterApiKey})`);
    } else {
      console.warn('[ReviewExport] NeuronWriter SKIPPED - No API Key found or explicitly disabled');
    }

    let completed = 0;
    for (let i = 0; i < toGenerate.length; i++) {
      const item = toGenerate[i];
      setCurrentItemIndex(i);

      // Reset steps for new item
      setGenerationSteps(createDefaultSteps());

      updateContentItem(item.id, { status: 'generating' });
      setGeneratingItems(prev => prev.map(gi =>
        gi.id === item.id ? { ...gi, status: 'generating', progress: 0 } : gi
      ));
      const generationStartTime = Date.now();

      try {
        let currentStepIdx = 0;
        const stepIds = ['research', 'videos', 'references', 'outline', 'content', 'enhance', 'links', 'validate', 'schema'];

        const result = await orchestrator.generateContent({
          keyword: item.primaryKeyword,
          title: item.title,
          contentType: item.type,
          url: item.url,
          onTitleRewritten: (newTitle: string) => {
            // Persist the SOTA-rewritten title back to the item so the UI reflects it
            updateContentItem(item.id, { title: newTitle });
          },
          onProgress: (msg) => {
            const lowerMsg = msg.toLowerCase();
            let detectedStep = -1;
            let detectedPhase: number | undefined;
            let isSSE = false;
            // ── Append to live log feed (capped to last 200 entries) ──
            const logLevel: 'info' | 'sse' | 'warn' | 'error' =
              msg.startsWith('SSE:') ? 'sse' :
              /error|fail|abort|stalled|incompat/i.test(msg) ? 'error' :
              /warn|skip|fallback|retry|continuation|slow/i.test(msg) ? 'warn' : 'info';
            const phaseGuess = msg.match(/Phase\s+(\d+)/i)?.[1];
            setGenerationLog(prev => {
              const next = [...prev, { t: Date.now(), msg, level: logLevel, phase: phaseGuess ? parseInt(phaseGuess, 10) : undefined }];
              return next.length > 200 ? next.slice(-200) : next;
            });

            // ── SSE telemetry parser (live stream progress) ──
            if (msg.startsWith('SSE:')) {
              isSSE = true;
              const charsMatch = msg.match(/([\d,]+)\s*chars/i);
              const chars = charsMatch ? Number(charsMatch[1].replace(/,/g, '')) : undefined;
              const cpsMatch = msg.match(/([\d.]+)\s*cps/i);
              const cps = cpsMatch ? Number(cpsMatch[1]) : undefined;
              const modelMatch = msg.match(/(?:to|streaming)\s+([^\s—]+)/i);
              const modelId = modelMatch?.[1];
              setStreamTelemetry(prev => {
                let status: typeof prev.status = prev.status;
                if (msg.includes('connecting')) status = 'connecting';
                else if (msg.includes('auto-resuming') || msg.includes('resuming')) status = 'resuming';
                else if (msg.includes('max resumes') || msg.includes('aborted') || msg.includes('slow-throughput')) status = 'aborted';
                else if (msg.includes('streaming')) status = 'streaming';
                else if (msg.includes('completed') || msg.includes('done')) status = 'completed';
                return {
                  ...prev,
                  status,
                  chars: chars ?? prev.chars,
                  cps: cps ?? prev.cps,
                  modelId: modelId ?? prev.modelId,
                  snippet: msg.replace(/^SSE:\s*/, '').slice(0, 140),
                  note: msg.replace(/^SSE:\s*/, ''),
                };
              });
              // Streaming = AI Generation phase. Force-advance to step 4 ("content").
              detectedStep = 4;
              detectedPhase = 5;
            }

            if (!isSSE) {
              // Match by SPECIFIC phase markers first to avoid keyword collisions
              const phaseMatch = msg.match(/Phase\s+(\d+)([a-z])?/i);
              if (phaseMatch) {
                const n = parseInt(phaseMatch[1], 10);
                detectedPhase = n;
                if (n <= 1) detectedStep = 0;
                else if (n === 2) detectedStep = 1;
                else if (n === 3) detectedStep = 2;
                else if (n === 4) detectedStep = 2;
                else if (n === 5 || n === 6) detectedStep = 4;
                else if (n === 7 || n === 8) detectedStep = 5;
                else if (n === 9) detectedStep = 6;
                else if (n === 10) detectedStep = 8;
                else if (n === 11) detectedStep = 7;
              } else if (lowerMsg.includes('serp') || lowerMsg.includes('research') || lowerMsg.includes('analyzing')) {
                detectedStep = 0;
              } else if (lowerMsg.includes('youtube') || lowerMsg.includes('video')) {
                detectedStep = 1;
              } else if (lowerMsg.includes('reference') || lowerMsg.includes('source') || lowerMsg.includes('citation')) {
                detectedStep = 2;
              } else if (lowerMsg.includes('outline') || lowerMsg.includes('structure')) {
                detectedStep = 3;
              } else if (lowerMsg.includes('generat') || lowerMsg.includes('writing') || lowerMsg.includes('creating') || lowerMsg.includes('synthes')) {
                detectedStep = 4;
              } else if (lowerMsg.includes('enhance') || lowerMsg.includes('optimi') || lowerMsg.includes('critique') || lowerMsg.includes('polish')) {
                detectedStep = 5;
              } else if (lowerMsg.includes('link')) {
                detectedStep = 6;
              } else if (lowerMsg.includes('valid') || lowerMsg.includes('quality') || lowerMsg.includes('checklist')) {
                detectedStep = 7;
              } else if (lowerMsg.includes('schema') || lowerMsg.includes('structured')) {
                detectedStep = 8;
              }
            }

            if (detectedPhase !== undefined) {
              setStreamTelemetry(prev => ({
                ...prev,
                phase: Math.max(prev.phase ?? 0, detectedPhase!),
                phaseLabel: msg.slice(0, 140),
                snippet: prev.snippet ?? msg.slice(0, 140),
              }));
            }

            if (detectedStep >= 0) {
              currentStepIdx = Math.max(currentStepIdx, detectedStep);
              setGenerationSteps(prev => prev.map((s, idx) => {
                if (idx < currentStepIdx) {
                  return s.status === 'error' ? s : { ...s, status: 'completed' as const };
                }
                if (idx === currentStepIdx) {
                  const phaseTag = detectedPhase !== undefined ? `Phase ${detectedPhase} • ` : '';
                  return { ...s, status: 'running' as const, message: `${phaseTag}${msg}`.slice(0, 200) };
                }
                return s.status === 'pending' ? s : { ...s, status: 'pending' as const };
              }));
            }

            // ── Global per-item progress: phase-weighted with char-based bonus ──
            // Phases 1-11 map roughly to portions of the pipeline.
            // While streaming, use chars to grow progress smoothly inside Phase 5.
            const TARGET_CHARS = 12000;
            const phaseFloor: Record<number, number> = {
              0: 2, 1: 5, 2: 12, 3: 18, 4: 25, 5: 32, 6: 75, 7: 82, 8: 88, 9: 92, 10: 96, 11: 99,
            };
            const stepFloor = Math.round(((currentStepIdx + 1) / stepIds.length) * 100);
            let itemProgress = stepFloor;
            const phaseNum = detectedPhase ?? (isSSE ? 5 : undefined);
            if (phaseNum !== undefined) {
              const floor = phaseFloor[phaseNum] ?? stepFloor;
              const next = phaseFloor[phaseNum + 1] ?? Math.min(99, floor + 10);
              if (isSSE) {
                const charsMatch = msg.match(/([\d,]+)\s*chars/i);
                const chars = charsMatch ? Number(charsMatch[1].replace(/,/g, '')) : 0;
                const ratio = Math.min(1, chars / TARGET_CHARS);
                itemProgress = Math.round(floor + (next - floor) * ratio);
              } else {
                itemProgress = floor;
              }
            }
            itemProgress = Math.min(99, Math.max(itemProgress, stepFloor));

            const liveLabel = isSSE ? msg.replace(/^SSE:\s*/, '') : msg;
            setGeneratingItems(prev => prev.map(gi =>
              gi.id === item.id ? { ...gi, progress: itemProgress, currentStep: liveLabel } : gi
            ));
          },
        });

        // Mark all steps complete
        setGenerationSteps(prev => prev.map(s => ({ ...s, status: 'completed' })));

        // Build content object for storage and database
        const contentToStore = {
          id: result.id,
          title: result.title,
          seoTitle: result.seoTitle,
          content: result.content,
          metaDescription: result.metaDescription,
          slug: result.slug,
          primaryKeyword: result.primaryKeyword,
          secondaryKeywords: result.secondaryKeywords,
          wordCount: result.metrics.wordCount,
          qualityScore: {
            overall: result.qualityScore.overall,
            readability: result.qualityScore.readability,
            seo: result.qualityScore.seo,
            eeat: result.qualityScore.eeat,
            uniqueness: result.qualityScore.uniqueness,
            factAccuracy: result.qualityScore.factAccuracy,
          },
          internalLinks: result.internalLinks.map(l => ({
            anchorText: l.anchorText,
            anchor: l.anchor,
            targetUrl: l.targetUrl,
            context: l.context,
          })),
          schema: result.schema,
          serpAnalysis: result.serpAnalysis ? {
            avgWordCount: result.serpAnalysis.avgWordCount,
            recommendedWordCount: result.serpAnalysis.recommendedWordCount,
            userIntent: result.serpAnalysis.userIntent,
          } : undefined,
          neuronWriterQueryId: result.neuronWriterQueryId,
          generatedAt: result.generatedAt.toISOString(),
          model: result.model,
          checklist: result.checklist ? {
            passed: result.checklist.passed,
            score: result.checklist.score,
            items: result.checklist.items,
          } : undefined,
          factCheckV2: (result as any).factCheckV2 ? {
            ymyl: (result as any).factCheckV2.ymyl,
            summary: (result as any).factCheckV2.summary,
            publishAllowed: (result as any).factCheckV2.publishAllowed,
            blockingReasons: (result as any).factCheckV2.blockingReasons,
            claims: (result as any).factCheckV2.claims,
          } : undefined,
        };

        // Store the generated content in persisted store (survives navigation)
        setGeneratedContent(item.id, contentToStore);

        // Store NeuronWriter analysis (if available) in persisted store
        if (result.neuronWriterAnalysis) {
          setNeuronWriterData(item.id, {
            query_id: result.neuronWriterAnalysis.query_id,
            keyword: result.neuronWriterAnalysis.keyword,
            status: result.neuronWriterAnalysis.status,
            terms: result.neuronWriterAnalysis.terms || [],
            termsExtended: result.neuronWriterAnalysis.termsExtended,
            entities: result.neuronWriterAnalysis.entities as any,
            headingsH2: result.neuronWriterAnalysis.headingsH2 as any,
            headingsH3: result.neuronWriterAnalysis.headingsH3 as any,
            recommended_length: result.neuronWriterAnalysis.recommended_length,
            content_score: result.neuronWriterAnalysis.content_score,
          });
        }

        updateContentItem(item.id, {
          status: 'completed',
          content: result.content,
          wordCount: result.metrics.wordCount,
        });

        setGeneratingItems(prev => prev.map(gi =>
          gi.id === item.id ? { ...gi, status: 'completed', progress: 100 } : gi
        ));

        // SOTA: Save content + NeuronWriter data to Supabase together
        const neuronDataToSave = result.neuronWriterAnalysis ? {
          query_id: result.neuronWriterAnalysis.query_id,
          keyword: result.neuronWriterAnalysis.keyword,
          status: result.neuronWriterAnalysis.status,
          terms: result.neuronWriterAnalysis.terms || [],
          termsExtended: result.neuronWriterAnalysis.termsExtended,
          entities: result.neuronWriterAnalysis.entities as any,
          headingsH2: result.neuronWriterAnalysis.headingsH2 as any,
          headingsH3: result.neuronWriterAnalysis.headingsH3 as any,
          recommended_length: result.neuronWriterAnalysis.recommended_length,
          content_score: result.neuronWriterAnalysis.content_score,
        } : null;

        saveToSupabase(item.id, contentToStore, neuronDataToSave).catch(err => {
          console.warn('[ReviewExport] Failed to save to Supabase:', err);
          toast.error(`Database save failed for "${item.title}". Content is preserved locally.`);
        });

        globalPerformanceTracker.recordMetrics({
          timestamp: Date.now(),
          contentQualityScore: result.qualityScore.overall,
          aeoScore: result.qualityScore.seo,
          internalLinkDensity: result.internalLinks.length * 10,
          semanticRichness: result.qualityScore.eeat,
          processingSpeed: Date.now() - generationStartTime,
          wordCount: result.metrics.wordCount,
          modelUsed: result.model,
          cacheHit: false,
          keyword: item.primaryKeyword,
        });
      } catch (error) {
        const errorMsg = error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error) || 'Unknown generation error';

        // ── USER STOP — abort the whole queue, do not show as error ──
        if (userAbortRef.current || errorMsg.includes('USER_ABORT')) {
          console.warn('[ReviewExport] Generation aborted by user.');
          toast.info(`Generation stopped by user at "${item.title}".`);
          updateContentItem(item.id, { status: 'pending' });
          setGeneratingItems(prev => prev.map(gi =>
            gi.id === item.id ? { ...gi, status: 'pending', error: 'Stopped by user' } : gi
          ));
          setGenerationError(undefined);
          setGenerationLog(prev => [...prev, { t: Date.now(), msg: '🛑 Generation halted. Pipeline released.', level: 'warn' }]);
          break;
        }

        // Classify error for user-friendly message
        const friendlyMsg = errorMsg.includes('MODEL_INCOMPATIBLE')
          ? errorMsg.replace(/^.*MODEL_INCOMPATIBLE:\s*/, '⚠️ Incompatible model: ')
          : errorMsg.includes('AbortError') || errorMsg.includes('timed out')
            ? 'Generation timed out — the AI provider stalled. Switch to a faster model (Gemini 2.0 Flash, GPT-4o, or Groq Llama 3.3) in Setup.'
            : errorMsg.includes('401') || errorMsg.includes('auth') || errorMsg.includes('API key')
              ? 'Invalid API key. Check your AI provider key in Setup.'
              : errorMsg.includes('429') || errorMsg.includes('rate limit')
                ? 'API rate limit hit. Wait 30s and retry.'
                : errorMsg.includes('empty content')
                  ? 'AI returned empty content. Try switching to a different model (e.g., Gemini → GPT-4o).'
                  : errorMsg;
        console.error(`[ReviewExport] Generation failed for "${item.title}":`, errorMsg, error);
        toast.error(`Generation failed: ${friendlyMsg.slice(0, 150)}`);
        updateContentItem(item.id, { status: 'error', error: friendlyMsg });
        setGeneratingItems(prev => prev.map(gi =>
          gi.id === item.id ? { ...gi, status: 'error', error: friendlyMsg } : gi
        ));
        setGenerationError(friendlyMsg);
      }

      completed++;
      setGenerationProgress(Math.round((completed / toGenerate.length) * 100));
    }

    setIsGenerating(false);
    setSelectedItems([]);
  };

  const sortedItems = useMemo(() => [...contentItems].sort((a, b) => {
    if (sortField === 'generatedAt') {
      const aDate = generatedContentsStore[a.id]?.generatedAt || '';
      const bDate = generatedContentsStore[b.id]?.generatedAt || '';
      // Empty (not yet generated) items sort to the bottom regardless of asc/desc
      if (!aDate && bDate) return 1;
      if (aDate && !bDate) return -1;
      if (aDate < bDate) return sortAsc ? -1 : 1;
      if (aDate > bDate) return sortAsc ? 1 : -1;
      return 0;
    }
    const aVal = a[sortField];
    const bVal = b[sortField];
    if (aVal < bVal) return sortAsc ? -1 : 1;
    if (aVal > bVal) return sortAsc ? 1 : -1;
    return 0;
  }), [contentItems, sortField, sortAsc, generatedContentsStore]);

  // Content viewer navigation
  const viewingIndex = viewingItem ? sortedItems.findIndex(i => i.id === viewingItem.id) : -1;
  const handlePreviousItem = () => {
    if (viewingIndex > 0) {
      setViewingItem(sortedItems[viewingIndex - 1]);
    }
  };
  const handleNextItem = () => {
    if (viewingIndex < sortedItems.length - 1) {
      setViewingItem(sortedItems[viewingIndex + 1]);
    }
  };

  const stats = {
    total: contentItems.length,
    completed: contentItems.filter(i => i.status === 'completed').length,
    pending: contentItems.filter(i => i.status === 'pending').length,
    errors: contentItems.filter(i => i.status === 'error').length,
  };

  // Check if any AI provider key is configured
  const hasAiProvider = !!(
    config.geminiApiKey ||
    config.openaiApiKey ||
    config.anthropicApiKey ||
    config.openrouterApiKey ||
    config.groqApiKey
  );
  const hasSerper = !!config.serperApiKey;

  return (
    <div className="space-y-5 md:space-y-7">
      {/* ── Premium Hero Header ── */}
      <div className="relative overflow-hidden rounded-2xl md:rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-950/40 via-background/60 to-background/30 p-5 md:p-8 shadow-2xl">
        <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-primary/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -left-20 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-5">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-primary/15 border border-primary/30 text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-3">
              <Sparkles className="w-3 h-3" /> Step 3 · Final Mile
            </div>
            <h1 className="text-2xl md:text-4xl font-black text-foreground tracking-tight flex items-center gap-3">
              <span className="hidden md:inline-flex w-11 h-11 items-center justify-center rounded-xl bg-gradient-to-br from-primary/30 to-emerald-700/20 border border-primary/40 shadow-lg shadow-primary/20">
                <FileText className="w-5 h-5 text-primary" />
              </span>
              <span className="bg-gradient-to-r from-foreground via-foreground to-primary bg-clip-text text-transparent">
                Review &amp; Export
              </span>
            </h1>
            <p className="text-muted-foreground mt-2 text-sm md:text-base max-w-xl">
              Inspect quality scores, run pre-publish checks, then ship to WordPress in one click.
            </p>
          </div>

          {/* Inline KPI strip */}
          <div className="grid grid-cols-4 gap-2 md:gap-3 md:flex md:items-stretch md:gap-2 shrink-0">
            <HeroStat label="Total" value={stats.total} tone="neutral" />
            <HeroStat label="Done" value={stats.completed} tone="success" />
            <HeroStat label="Queued" value={stats.pending} tone="warn" />
            <HeroStat label="Errors" value={stats.errors} tone={stats.errors > 0 ? 'danger' : 'neutral'} />
          </div>
        </div>
      </div>

      {/* Publish & Search Console verification */}
      <PublishVerificationChecklist />


      <div className="flex flex-wrap gap-2 md:gap-3 text-sm">
        <StatusBadge
          ok={!!hasAiProvider}
          label="AI Provider"
        />
        <StatusBadge
          ok={!!hasSerper}
          label="Serper (YouTube/References)"
        />
        <StatusBadge
          ok={!!(config.enableNeuronWriter && config.neuronWriterApiKey)}
          label="NeuronWriter (Optional)"
          optional
        />
        <StatusBadge
          ok={sitemapUrls.length > 0}
          label={`Sitemap (${sitemapUrls.length} pages)`}
          optional
        />
        <div className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-lg border",
          dbLoading ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-400" :
            dbConnected ? "bg-green-500/10 border-green-500/30 text-green-400" :
              isOfflineMode ? "bg-green-500/10 border-green-500/30 text-green-400" :
                tableMissing ? "bg-red-500/10 border-red-500/30 text-red-400" :
                  dbError ? "bg-red-500/10 border-red-500/30 text-red-400" :
                    "bg-green-500/10 border-green-500/30 text-green-400"
        )}>
          <Database className="w-4 h-4" />
          <span>
            {dbLoading ? 'Syncing...' :
              dbConnected ? '✓ Database Connected' :
                isOfflineMode ? '✓ Auto-Save Active (Local)' :
                  tableMissing ? '⚠ Database Setup Required' :
                    dbError ? '⚠ Database Error' :
                      '✓ Auto-Save Active'}
          </span>
        </div>
      </div>

      {!hasSerper && (
        <div className="flex items-center gap-2 px-4 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-yellow-400 text-sm">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>
            Missing Serper API Key: YouTube videos and reference citations will NOT be added.{" "}
            <a href="https://serper.dev" target="_blank" rel="noopener noreferrer" className="underline">
              Get your free key at serper.dev
            </a>
          </span>
        </div>
      )}

      {tableMissing && (
        <div className="glass-card border border-red-500/30 bg-red-500/10 p-5 rounded-2xl flex items-start gap-4 animate-in fade-in slide-in-from-top-2">
          <div className="p-2 bg-red-500/20 rounded-lg">
            <Database className="w-6 h-6 text-red-400" />
          </div>
          <div>
            <h3 className="font-bold text-red-400 text-lg mb-1">Database Schema Missing</h3>
            <p className="text-red-300/80 mb-3 text-sm">Your generated content cannot be saved to the database. Run the migration to enable persistence.</p>
            <div className="bg-black/30 rounded-lg p-3 border border-red-500/20 font-mono text-xs text-red-300">
              supabase/migrations/001_create_blog_posts_table.sql
            </div>
          </div>
        </div>
      )}

      {factCheckBlocked.length > 0 && (
        <div className="glass-card border border-amber-500/30 bg-amber-500/10 p-5 rounded-2xl flex items-start gap-4">
          <div className="p-2 bg-amber-500/20 rounded-lg">
            <Database className="w-6 h-6 text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-amber-300 text-lg mb-1">
              YMYL Fact-Check Gate — {factCheckBlocked.length} post{factCheckBlocked.length === 1 ? '' : 's'} blocked
            </h3>
            <p className="text-amber-200/80 text-sm mb-2">
              These articles contain unverified factual claims in YMYL (health/finance/legal/safety) territory. Resolve flagged claims before publishing.
            </p>
            <ul className="text-amber-200/90 text-xs space-y-1 max-h-32 overflow-auto">
              {factCheckBlocked.slice(0, 5).map((b) => (
                <li key={b.id} className="truncate">
                  • <span className="font-semibold">{b.title}</span> — {b.flagged} flagged claim{b.flagged === 1 ? '' : 's'}
                </li>
              ))}
              {factCheckBlocked.length > 5 && (
                <li className="text-amber-200/60">…and {factCheckBlocked.length - 5} more</li>
              )}
            </ul>
          </div>
        </div>
      )}

      {/* Action Bar */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4">
        <div className="flex flex-col sm:flex-row gap-2.5 md:gap-3 w-full md:w-auto">
          <button
            onClick={handleGenerate}
            disabled={selectedItems.length === 0 || !hasAiProvider || isGenerating}
            className="w-full sm:w-auto px-6 md:px-8 py-3.5 md:py-4 bg-gradient-to-r from-primary to-emerald-500 text-white font-bold text-base md:text-lg rounded-2xl hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2.5 shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_32px_rgba(16,185,129,0.45)] hover:-translate-y-0.5 transition-all duration-300"
          >
            {isGenerating ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5 fill-current" />}
            <span className="truncate">{isGenerating ? 'Forging…' : `Generate (${selectedItems.length})`}</span>
          </button>

          {(publishableSelected.length > 0 || allPublishable.length > 0) && (
            <button
              onClick={() => setShowBulkPublishModal(true)}
              disabled={isBulkPublishing}
              className="w-full sm:w-auto px-5 md:px-6 py-3.5 md:py-4 bg-white/5 border border-white/10 text-white font-bold rounded-2xl hover:bg-white/10 disabled:opacity-50 flex items-center justify-center gap-2.5 transition-all hover:-translate-y-0.5"
            >
              {isBulkPublishing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
              <span className="truncate">{isBulkPublishing ? 'Publishing…' : publishableSelected.length > 0
                ? `Publish (${publishableSelected.length})`
                : `Publish All`}</span>
            </button>
          )}

          <button
            onClick={() => setShowAnalytics(!showAnalytics)}
            className={cn(
              "w-full sm:w-auto px-5 py-3.5 md:py-4 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all border",
              showAnalytics
                ? "bg-primary/20 border-primary/50 text-primary shadow-[0_0_15px_rgba(16,185,129,0.2)]"
                : "bg-white/5 border-white/10 text-zinc-400 hover:text-white hover:bg-white/10"
            )}
          >
            <Brain className="w-5 h-5" />
            Analytics
          </button>
        </div>

        {selectedItems.length > 0 && (
          <div className="text-xs md:text-sm text-muted-foreground bg-white/5 border border-white/10 rounded-xl px-3 py-2 self-start md:self-auto">
            <span className="font-bold text-primary">{selectedItems.length}</span> selected
          </div>
        )}
      </div>

      {/* Content Table */}
      <div className="glass-card rounded-2xl overflow-hidden shadow-2xl border border-white/10">
        <div className="overflow-x-auto custom-scrollbar">
        <table className="w-full min-w-[720px] md:min-w-0">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="p-4 text-left">
                <input
                  type="checkbox"
                  checked={selectedItems.length === contentItems.length && contentItems.length > 0}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
                />
              </th>
              <th
                className="p-4 text-left text-sm font-medium text-foreground cursor-pointer hover:text-primary"
                onClick={() => { setSortField('title'); setSortAsc(!sortAsc); }}
              >
                <span className="flex items-center gap-1">
                  Title <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th
                className="hidden md:table-cell p-4 text-left text-sm font-medium text-foreground cursor-pointer hover:text-primary"
                onClick={() => { setSortField('type'); setSortAsc(!sortAsc); }}
              >
                <span className="flex items-center gap-1">
                  Type <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th
                className="p-4 text-left text-sm font-medium text-foreground cursor-pointer hover:text-primary"
                onClick={() => { setSortField('status'); setSortAsc(!sortAsc); }}
              >
                <span className="flex items-center gap-1">
                  Status <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th className="hidden lg:table-cell p-4 text-left text-sm font-medium text-foreground">
                Website
              </th>
              <th className="p-4 text-left text-sm font-medium text-foreground">
                Quality / Words
              </th>
              <th
                className="hidden md:table-cell p-4 text-left text-sm font-medium text-foreground cursor-pointer hover:text-primary"
                onClick={() => { setSortField('generatedAt'); setSortAsc(!sortAsc); }}
                title="Sort by generation date/time"
              >
                <span className="flex items-center gap-1">
                  Generated <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th className="hidden md:table-cell p-4 text-left text-sm font-medium text-foreground">Checklist</th>
              <th className="p-4 text-left text-sm font-medium text-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.length === 0 ? (
              dbLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="border-b border-white/5">
                    <td className="p-4"><Skeleton className="w-4 h-4 rounded" /></td>
                    <td className="p-4"><Skeleton className="h-3 w-48 mb-2" /><Skeleton className="h-2.5 w-32" /></td>
                    <td className="p-4"><Skeleton className="h-5 w-14 rounded-md" /></td>
                    <td className="p-4"><Skeleton className="h-4 w-20" /></td>
                    <td className="p-4"><Skeleton className="h-3 w-32" /></td>
                    <td className="p-4"><Skeleton className="h-3 w-24" /></td>
                    <td className="p-4"><Skeleton className="h-3 w-20" /></td>
                    <td className="p-4"><Skeleton className="h-5 w-14 rounded-md" /></td>
                    <td className="p-4"><Skeleton className="h-7 w-24 rounded-md" /></td>
                  </tr>
                ))
              ) : (
              <tr>
                <td colSpan={9} className="p-0">
                  <div className="p-6 md:p-10">
                    <EmptyState
                      icon={FileText}
                      title="No content yet"
                      description="Go to Strategy to discover topics, or add URLs in Setup. Generated articles will appear here ready for review and one-click WordPress publishing."
                      tone="primary"
                      action={
                        <button
                          onClick={() => useOptimizerStore.getState().setCurrentStep(2)}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors"
                        >
                          <Sparkles className="w-4 h-4" /> Go to Strategy
                        </button>
                      }
                    />
                  </div>
                </td>
              </tr>
              )
            ) : (
              sortedItems.map(item => {
                const stored = generatedContentsStore[item.id];
                const generatedDate = stored?.generatedAt ? new Date(stored.generatedAt) : null;
                const qualityScore = stored?.qualityScore?.overall;
                const wordCount = stored?.wordCount ?? item.wordCount;

                const formatDate = (d: Date) => {
                  const now = new Date();
                  const diffMs = now.getTime() - d.getTime();
                  const diffMin = Math.floor(diffMs / 60000);
                  const diffHr = Math.floor(diffMin / 60);
                  const diffDay = Math.floor(diffHr / 24);
                  let relative = '';
                  if (diffMin < 1) relative = 'just now';
                  else if (diffMin < 60) relative = `${diffMin}m ago`;
                  else if (diffHr < 24) relative = `${diffHr}h ago`;
                  else if (diffDay < 7) relative = `${diffDay}d ago`;
                  else relative = d.toLocaleDateString();
                  const absolute = d.toLocaleString(undefined, {
                    year: 'numeric', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  });
                  return { relative, absolute };
                };

                return (
                <tr key={item.id} className="border-b border-white/5 hover:bg-white/5 transition-colors duration-200 group">
                  <td className="p-4">
                    <input
                      type="checkbox"
                      checked={selectedItems.includes(item.id)}
                      onChange={() => toggleSelect(item.id)}
                      className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
                    />
                  </td>
                  <td className="p-4">
                    <div className="font-medium text-foreground line-clamp-2">{item.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{item.primaryKeyword}</div>
                    <div className="md:hidden mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                        item.type === 'pillar' && "bg-purple-500/20 text-purple-400",
                        item.type === 'cluster' && "bg-blue-500/20 text-blue-400",
                        item.type === 'single' && "bg-green-500/20 text-green-400",
                        item.type === 'refresh' && "bg-yellow-500/20 text-yellow-400"
                      )}>{item.type}</span>
                    </div>
                  </td>
                  <td className="hidden md:table-cell p-4">
                    <span className={cn(
                      "px-2 py-1 rounded text-xs font-medium",
                      item.type === 'pillar' && "bg-purple-500/20 text-purple-400",
                      item.type === 'cluster' && "bg-blue-500/20 text-blue-400",
                      item.type === 'single' && "bg-green-500/20 text-green-400",
                      item.type === 'refresh' && "bg-yellow-500/20 text-yellow-400"
                    )}>
                      {item.type}
                    </span>
                  </td>
                  <td className="p-4">
                    <span className={cn(
                      "flex items-center gap-1.5 text-sm",
                      item.status === 'pending' && "text-yellow-400",
                      item.status === 'generating' && "text-blue-400",
                      item.status === 'completed' && "text-green-400",
                      item.status === 'error' && "text-red-400"
                    )}>
                      {item.status === 'pending' && <Clock className="w-4 h-4" />}
                      {item.status === 'generating' && <Loader2 className="w-4 h-4 animate-spin" />}
                      {item.status === 'completed' && <CheckCircle className="w-4 h-4" />}
                      {item.status === 'error' && <XCircle className="w-4 h-4" />}
                      {item.status === 'error' && item.error ? (
                        <span title={item.error}>{item.error.slice(0, 60)}{item.error.length > 60 ? '…' : ''}</span>
                      ) : item.status}
                    </span>
                  </td>
                  <td className="hidden lg:table-cell p-4">
                    {(() => {
                      try {
                        const u = new URL(item.url);
                        const host = u.hostname.replace(/^www\./, '');
                        const path = u.pathname.length > 28 ? u.pathname.slice(0, 26) + '…' : u.pathname;
                        return (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={item.url}
                            className="flex flex-col gap-0.5 hover:text-primary transition-colors max-w-[220px]"
                          >
                            <span className="text-sm font-medium text-foreground truncate">{host}</span>
                            <span className="text-xs text-muted-foreground truncate">{path}</span>
                          </a>
                        );
                      } catch {
                        return <span className="text-xs text-muted-foreground italic">—</span>;
                      }
                    })()}
                  </td>
                  <td className="p-4">
                    {qualityScore !== undefined ? (
                      <div className="flex flex-col gap-1">
                        <span className={cn(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold w-fit",
                          qualityScore >= 90 && "bg-emerald-500/20 text-emerald-400",
                          qualityScore >= 75 && qualityScore < 90 && "bg-yellow-500/20 text-yellow-400",
                          qualityScore < 75 && "bg-red-500/20 text-red-400",
                        )}>
                          ⚡ {Math.round(qualityScore)}/100
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {wordCount?.toLocaleString() || 0} words
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="hidden md:table-cell p-4">
                    {generatedDate ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm text-foreground font-medium" title={formatDate(generatedDate).absolute}>
                          {formatDate(generatedDate).relative}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(generatedDate).absolute}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">Not yet generated</span>
                    )}
                  </td>
                  <td className="hidden md:table-cell p-4">
                    {(() => {
                      const cl = stored?.checklist;
                      if (!cl) return <span className="text-xs text-muted-foreground italic">—</span>;
                      const failCount = cl.items.filter(i => i.severity === 'mandatory' && !i.passed).length;
                      return (
                        <button
                          onClick={() => setShowChecklistReport(item.id)}
                          className={cn(
                            "inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-bold transition-all hover:brightness-125",
                            cl.passed
                              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                              : "bg-red-500/15 text-red-400 border border-red-500/30"
                          )}
                          title={cl.passed ? "All mandatory checks passed" : `${failCount} mandatory failure(s) — click for report`}
                        >
                          {cl.passed ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                          {cl.passed ? `Pass · ${cl.score}` : `${failCount} missing · ${cl.score}`}
                        </button>
                      );
                    })()}
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setViewingItem(item)}
                        className={cn(
                          "p-1.5 rounded transition-all",
                          item.status === 'completed'
                            ? "text-primary hover:text-primary hover:bg-primary/20"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        )}
                        title={item.status === 'completed' ? "View Content" : "Preview (content not generated yet)"}
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => removeContentItem(item.id)}
                        className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-all"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Analytics Dashboard */}
      {showAnalytics && (
        <div className="bg-card border border-border rounded-2xl p-6">
          <ContentIntelligenceDashboard />
        </div>
      )}

      {/* Enhanced Generation Modal */}
      <EnhancedGenerationModal
        isOpen={isGenerating}
        onClose={() => setIsGenerating(false)}
        items={generatingItems}
        currentItemIndex={currentItemIndex}
        overallProgress={generationProgress}
        steps={generationSteps}
        error={generationError}
        streamTelemetry={streamTelemetry}
        logFeed={generationLog}
        onStop={handleStopGeneration}
        canStop={isGenerating}
      />

      {/* Content Viewer Panel */}
      {viewingItem && (
        <ContentViewerPanel
          item={viewingItem}
          generatedContent={reconstructGeneratedContent(generatedContentsStore[viewingItem.id])}
          neuronData={reconstructNeuronData(neuronWriterDataStore[viewingItem.id])}
          factCheckV2={generatedContentsStore[viewingItem.id]?.factCheckV2 ?? null}
          onClose={() => setViewingItem(null)}
          onPrevious={handlePreviousItem}
          onNext={handleNextItem}
          hasPrevious={viewingIndex > 0}
          hasNext={viewingIndex < sortedItems.length - 1}
          onSaveContent={(itemId, newContent) => {
            updateContentItem(itemId, { content: newContent, wordCount: newContent.split(/\s+/).filter(Boolean).length });
            const existing = generatedContentsStore[itemId];
            if (existing) {
              setGeneratedContent(itemId, { ...existing, content: newContent, wordCount: newContent.split(/\s+/).filter(Boolean).length });
            }
          }}
        />
      )}

      {/* ── Bulk Publish Modal ── */}
      {showBulkPublishModal && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-xl z-[60] flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="glass-card border border-white/10 rounded-3xl w-full max-w-lg p-8 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/20 rounded-full blur-3xl -z-10 translate-x-1/2 -translate-y-1/2" />

            <div className="flex items-center justify-between mb-8">
              <h3 className="text-2xl font-bold text-white flex items-center gap-3">
                <div className="p-2 bg-emerald-500/20 rounded-xl">
                  <Upload className="w-6 h-6 text-emerald-400" />
                </div>
                Bulk Publish
              </h3>
              <button
                onClick={() => { setShowBulkPublishModal(false); setBulkPublishItems([]); }}
                className="p-2 text-zinc-400 hover:text-white rounded-xl hover:bg-white/10 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {!wpConfigured ? (
              <div className="text-center py-10 bg-white/5 rounded-2xl border border-white/10">
                <AlertCircle className="w-16 h-16 text-yellow-400 mx-auto mb-6" />
                <h4 className="text-xl font-bold text-white mb-2">WordPress Not Configured</h4>
                <p className="text-zinc-400 mb-8 max-w-xs mx-auto">
                  Add your WordPress URL, username, and application password in the Setup tab to enable publishing.
                </p>
                <button
                  onClick={() => setShowBulkPublishModal(false)}
                  className="px-6 py-3 bg-white/10 text-white font-bold rounded-xl hover:bg-white/20 transition-all"
                >
                  Close & Configure
                </button>
              </div>
            ) : bulkPublishItems.length === 0 ? (
              /* Pre-publish confirmation */
              <>
                <div className="space-y-6 mb-8">
                  <div>
                    <label className="block text-sm font-bold text-zinc-300 mb-3 ml-1">
                      Publication Status
                    </label>
                    <div className="flex gap-3 p-1 bg-black/20 rounded-2xl border border-white/5">
                      <button
                        onClick={() => setBulkPublishStatus('draft')}
                        className={cn(
                          "flex-1 px-4 py-3 rounded-xl font-bold transition-all",
                          bulkPublishStatus === 'draft'
                            ? "bg-primary text-white shadow-lg"
                            : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                        )}
                      >
                        📝 Draft
                      </button>
                      <button
                        onClick={() => setBulkPublishStatus('publish')}
                        className={cn(
                          "flex-1 px-4 py-3 rounded-xl font-bold transition-all",
                          bulkPublishStatus === 'publish'
                            ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/20"
                            : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                        )}
                      >
                        🚀 Publish Live
                      </button>
                    </div>
                  </div>

                  <div className="p-5 bg-black/20 border border-white/10 rounded-2xl">
                    <h4 className="text-sm font-bold text-zinc-300 mb-4 flex items-center justify-between">
                      <span>Publishing Queue</span>
                      <span className="text-xs font-normal text-zinc-500">{(publishableSelected.length > 0 ? publishableSelected : allPublishable).length} items</span>
                    </h4>
                    <ul className="text-sm text-zinc-400 space-y-3 max-h-48 overflow-y-auto custom-scrollbar pr-2">
                      {(publishableSelected.length > 0 ? publishableSelected : allPublishable).map((item, i) => {
                        const stored = generatedContentsStore[item.id];
                        return (
                          <li key={item.id} className="flex items-center gap-3 group">
                            <span className="text-emerald-500/50 font-mono text-xs w-6 text-right">{i + 1}.</span>
                            <div className="flex-1 min-w-0">
                              <span className="text-zinc-200 font-medium truncate block group-hover:text-emerald-400 transition-colors">{item.title}</span>
                              {stored && (
                                <span className="text-zinc-600 text-xs">
                                  {stored.wordCount?.toLocaleString() || '0'} words • {stored.seoTitle ? 'SEO Ready' : 'Raw Title'}
                                </span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => setShowBulkPublishModal(false)}
                    className="flex-1 px-6 py-4 bg-white/5 text-zinc-300 rounded-2xl font-bold hover:bg-white/10 transition-all border border-white/5"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { handleBulkPublish(); }}
                    className="flex-1 px-6 py-4 bg-gradient-to-r from-emerald-600 to-emerald-400 text-white rounded-2xl font-bold hover:brightness-110 transition-all flex items-center justify-center gap-3 shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_30px_rgba(16,185,129,0.4)] hover:-translate-y-1"
                  >
                    <Upload className="w-5 h-5 fill-current" />
                    Start Publishing
                  </button>
                </div>
              </>
            ) : (
              /* Publishing progress */
              <>
                <div className="space-y-3 max-h-[400px] overflow-y-auto mb-8 custom-scrollbar pr-2">
                  {bulkPublishItems.map((item, i) => (
                    <div
                      key={item.id}
                      className={cn(
                        "flex items-center gap-4 p-4 rounded-xl border transition-all",
                        item.status === 'published' && "bg-emerald-500/10 border-emerald-500/20",
                        item.status === 'publishing' && "bg-primary/10 border-primary/20",
                        item.status === 'error' && "bg-red-500/10 border-red-500/20",
                        item.status === 'pending' && "bg-white/5 border-white/5"
                      )}
                    >
                      <div className="flex-shrink-0">
                        {item.status === 'pending' && <Clock className="w-5 h-5 text-zinc-600" />}
                        {item.status === 'publishing' && <Loader2 className="w-5 h-5 text-primary animate-spin" />}
                        {item.status === 'published' && <CheckCircle className="w-5 h-5 text-emerald-400" />}
                        {item.status === 'error' && <XCircle className="w-5 h-5 text-red-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-white truncate mb-0.5">{item.title}</div>
                        {item.status === 'published' && item.postUrl ? (
                          <a
                            href={item.postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-emerald-400 hover:text-emerald-300 hover:underline flex items-center gap-1"
                          >
                            View post <ArrowRight className="w-3 h-3" />
                          </a>
                        ) : item.status === 'error' && item.error ? (
                          <div className="text-xs text-red-400 truncate">{item.error}</div>
                        ) : (
                          <div className="text-xs text-zinc-500 capitalize">{item.status}...</div>
                        )}
                      </div>
                      <span className="text-xs text-zinc-600 font-mono">{i + 1}/{bulkPublishItems.length}</span>
                    </div>
                  ))}
                </div>

                {!isBulkPublishing && (
                  <button
                    onClick={() => { setShowBulkPublishModal(false); setBulkPublishItems([]); }}
                    className="w-full px-6 py-4 bg-white/10 text-white rounded-2xl font-bold hover:bg-white/20 transition-all border border-white/10"
                  >
                    Close
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Checklist Report Modal ── */}
      {showChecklistReport && (() => {
        const stored = generatedContentsStore[showChecklistReport];
        const cl = stored?.checklist;
        if (!cl) return null;
        const item = contentItems.find(i => i.id === showChecklistReport);
        const grouped = ['seo', 'aeo', 'geo', 'eeat', 'ux'].map(cat => ({
          cat,
          items: cl.items.filter(i => i.category === cat),
        }));
        const catLabel: Record<string, string> = {
          seo: 'SEO Foundation',
          aeo: 'Answer Engine (AI Overviews)',
          geo: 'Generative Engine (Sources & Stats)',
          eeat: 'E-E-A-T Signals',
          ux: 'UX & Visual Structure',
        };
        return (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-xl z-[70] flex items-center justify-center p-4 animate-in fade-in duration-300"
               onClick={() => setShowChecklistReport(null)}>
            <div className="glass-card border border-white/10 rounded-3xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-8 shadow-2xl"
                 onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h3 className="text-2xl font-bold text-white flex items-center gap-3">
                    {cl.passed
                      ? <CheckCircle className="w-7 h-7 text-emerald-400" />
                      : <AlertCircle className="w-7 h-7 text-red-400" />}
                    Pre-publish Checklist
                  </h3>
                  <p className="text-zinc-400 text-sm mt-1 truncate max-w-xl" title={item?.title}>{item?.title}</p>
                  <div className={cn(
                    "inline-flex items-center gap-2 mt-3 px-3 py-1 rounded-lg text-xs font-bold",
                    cl.passed ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
                  )}>
                    Score {cl.score}/100 · {cl.items.filter(i => !i.passed && i.severity === 'mandatory').length} mandatory missing · {cl.items.filter(i => !i.passed && i.severity === 'recommended').length} recommended missing
                  </div>
                </div>
                <button onClick={() => setShowChecklistReport(null)}
                        className="p-2 text-zinc-400 hover:text-white rounded-xl hover:bg-white/10 transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>

              {!cl.passed && (
                <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-200 flex items-center justify-between gap-3 flex-wrap">
                  <span><strong>Publish blocked.</strong> Fix the mandatory items below or rerun targeted retry.</span>
                  <button
                    onClick={() => {
                      const id = showChecklistReport!;
                      const it = contentItems.find(i => i.id === id);
                      if (!it) return;
                      setShowChecklistReport(null);
                      setSelectedItems([id]);
                      // Reset to 'pending' so handleGenerate picks it up; orchestrator's
                      // Phase 11 auto-retry will close gaps with the user's chosen model + fallback.
                      useOptimizerStore.getState().updateContentItem(id, { status: 'pending' });
                      setTimeout(() => handleGenerate(), 100);
                      toast.info('Rerunning targeted retry…');
                    }}
                    className="px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-100 text-xs font-bold"
                  >
                    Rerun targeted retry
                  </button>
                </div>
              )}

              <div className="space-y-6">
                {grouped.map(g => (
                  <div key={g.cat}>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">{catLabel[g.cat]}</h4>
                    <div className="space-y-2">
                      {g.items.map(it => (
                        <div key={it.id} className={cn(
                          "p-3 rounded-xl border flex items-start gap-3",
                          it.passed
                            ? "bg-emerald-500/5 border-emerald-500/20"
                            : it.severity === 'mandatory'
                              ? "bg-red-500/5 border-red-500/30"
                              : "bg-yellow-500/5 border-yellow-500/20"
                        )}>
                          {it.passed
                            ? <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
                            : <XCircle className={cn("w-5 h-5 flex-shrink-0 mt-0.5", it.severity === 'mandatory' ? "text-red-400" : "text-yellow-400")} />}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium text-foreground">{it.label}</span>
                              <span className={cn(
                                "text-[10px] px-1.5 py-0.5 rounded uppercase font-bold tracking-wider",
                                it.severity === 'mandatory' ? "bg-red-500/20 text-red-300" : "bg-zinc-700/40 text-zinc-400"
                              )}>{it.severity}</span>
                              {it.detail && (
                                <span className="text-xs text-zinc-500 font-mono">{it.detail}</span>
                              )}
                            </div>
                            {!it.passed && it.fix && (
                              <p className="text-xs text-zinc-400 mt-1">↳ {it.fix}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function StatusBadge({ ok, label, optional }: { ok: boolean; label: string; optional?: boolean }) {
  if (optional && !ok) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/5 bg-white/5 text-zinc-400 text-xs font-medium">
        <div className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
        {label}
      </div>
    );
  }

  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium backdrop-blur-sm transition-all",
      ok ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.1)]" : "bg-red-500/10 border-red-500/20 text-red-400"
    )}>
      {ok ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
      {label}
    </div>
  );
}

function HeroStat({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'success' | 'warn' | 'danger' }) {
  const toneCls =
    tone === 'success' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10 shadow-[0_0_18px_rgba(16,185,129,0.15)]'
    : tone === 'warn' ? 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10'
    : tone === 'danger' ? 'text-red-400 border-red-500/30 bg-red-500/10'
    : 'text-foreground border-white/10 bg-white/5';
  return (
    <div className={cn(
      "min-w-0 rounded-xl md:rounded-2xl border px-3 py-2 md:px-4 md:py-3 backdrop-blur-sm flex flex-col items-center md:items-start justify-center text-center md:text-left transition-transform hover:-translate-y-0.5",
      toneCls
    )}>
      <div className="text-xl md:text-2xl font-black tabular-nums leading-none">{value}</div>
      <div className="mt-1 text-[9px] md:text-[10px] uppercase tracking-[0.18em] font-bold opacity-80">{label}</div>
    </div>
  );
}

