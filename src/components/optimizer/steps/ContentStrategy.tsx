import { useRef, useState, useEffect, useCallback } from "react";
import { useOptimizerStore } from "@/lib/store";
import type { GenerationPipelineConfig } from "@/lib/store";
import {
  BookOpen, FileText, Target, RefreshCw, FolderOpen, Image,
  Zap, Plus, Upload, Link, Trash2, AlertCircle, ArrowRight,
  BarChart3, Search, Sparkles, Loader2, Bot, XCircle,
  Settings2, Globe, Hash, TrendingUp, CheckCircle2, Clock,
  Layers, ChevronDown, ChevronUp, Eye, Gauge, LayoutGrid,
  ListChecks, Brain, Rocket, ShieldCheck, Star, Wand2,
  Activity, Crown, Crosshair, BarChart, Flame, MessageSquare,
  PenTool, Network, Cpu, Database, Trophy, Siren
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { crawlSitemapUrls, type SitemapCrawlProgress } from "@/lib/sitemap/crawlSitemap";
import { fetchSitemapTextRaced } from "@/lib/sitemap/fetchSitemapText";
import { discoverWordPressUrls } from "@/lib/sitemap/wordpressDiscovery";
import { GodModeDashboard } from "../GodModeDashboard";

// ─── Tab Configuration ──────────────────────────────────────────────────────

const tabs = [
  { id: "bulk", label: "📚 Bulk Planner", icon: BookOpen, desc: "AI-powered topic clustering" },
  { id: "single", label: "📝 Single Article", icon: FileText, desc: "Full-control generation" },
  { id: "godmode", label: "⚡ God Mode 2.0", icon: Bot, desc: "Autonomous engine" },
  { id: "gap", label: "🎯 Gap Analysis", icon: Target, desc: "SERP competitive intel" },
  { id: "clusters", label: "🕸️ Clusters", icon: Network, desc: "Topical authority planner" },
  { id: "refresh", label: "🔄 Quick Refresh", icon: RefreshCw, desc: "Update existing content" },
  { id: "hub", label: "🗂️ Content Hub", icon: FolderOpen, desc: "Sitemap crawling" },
];

// ─── Cluster type definitions ───────────────────────────────────────────────

const CLUSTER_TYPES = [
  { value: "how-to", label: "How-To Guide", icon: "🔧", desc: "Step-by-step instructional content" },
  { value: "guide", label: "Ultimate Guide", icon: "📖", desc: "Comprehensive deep-dive on a topic" },
  { value: "comparison", label: "Comparison", icon: "⚖️", desc: "X vs Y analysis with data" },
  { value: "listicle", label: "Listicle", icon: "📋", desc: "Numbered list format (Top 10, Best 5)" },
  { value: "deep-dive", label: "Deep Dive", icon: "🔬", desc: "Expert-level analysis" },
  { value: "case-study", label: "Case Study", icon: "📊", desc: "Real-world success story" },
  { value: "beginner", label: "Beginner's Guide", icon: "🌱", desc: "Entry-level explainer" },
  { value: "mistakes", label: "Common Mistakes", icon: "⚠️", desc: "What to avoid" },
] as const;

const CONTENT_TYPES = [
  { value: "pillar", label: "Pillar Page", desc: "3500-5000 words, covers entire topic", words: 4500 },
  { value: "cluster", label: "Cluster Article", desc: "2000-3500 words, specific subtopic", words: 3000 },
  { value: "single", label: "Standalone Article", desc: "2500-4000 words, single keyword", words: 3500 },
  { value: "refresh", label: "Content Refresh", desc: "Rewrite/update existing content", words: 3000 },
] as const;

const TONE_OPTIONS = [
  { value: "hormozi", label: "Hormozi/Ferriss", desc: "Direct, tactical, zero-fluff", icon: Flame },
  { value: "professional", label: "Professional", desc: "Authoritative, polished", icon: Crown },
  { value: "conversational", label: "Conversational", desc: "Friendly, accessible", icon: MessageSquare },
  { value: "academic", label: "Academic", desc: "Research-backed, formal", icon: BookOpen },
] as const;

// ─── Shared pipeline config builder ─────────────────────────────────────────

function buildPipelineConfig(overrides: Partial<GenerationPipelineConfig> & {
  model?: string;
  tone?: GenerationPipelineConfig['tone'];
  targetWordCount?: number;
  targetAudience?: string;
}): GenerationPipelineConfig {
  return {
    enableSerpAnalysis: true,
    enableSelfCritique: true,
    enableWpImages: true,
    enableYouTube: true,
    enableReferences: true,
    maxCritiquePasses: 3,
    ...overrides,
  };
}

// ─── Shared UI Components ───────────────────────────────────────────────────

function PipelineStatusBar({ config }: { config: GenerationPipelineConfig }) {
  const features = [
    { key: 'serp', label: 'SERP Gap', on: config.enableSerpAnalysis !== false, color: 'text-blue-400' },
    { key: 'critique', label: `Critique ×${config.maxCritiquePasses || 3}`, on: config.enableSelfCritique !== false, color: 'text-amber-400' },
    { key: 'images', label: 'WP Images', on: config.enableWpImages !== false, color: 'text-purple-400' },
    { key: 'youtube', label: 'YouTube', on: config.enableYouTube !== false, color: 'text-red-400' },
    { key: 'refs', label: 'References', on: config.enableReferences !== false, color: 'text-emerald-400' },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {features.map(f => (
        <span key={f.key} className={cn(
          "px-2.5 py-1 rounded-lg text-xs font-bold border",
          f.on ? `${f.color} bg-white/5 border-white/10` : "text-zinc-600 bg-black/10 border-white/5 line-through"
        )}>
          {f.on ? '✓' : '✗'} {f.label}
        </span>
      ))}
    </div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle, gradient }: {
  icon: React.ElementType; title: string; subtitle: string; gradient: string;
}) {
  return (
    <div className="flex items-start gap-3 md:gap-4">
      <div className={cn("w-11 h-11 md:w-14 md:h-14 rounded-xl md:rounded-2xl flex items-center justify-center shadow-lg flex-shrink-0", gradient)}>
        <Icon className="w-5 h-5 md:w-7 md:h-7 text-primary-foreground" />
      </div>
      <div className="min-w-0">
        <h3 className="text-lg md:text-xl font-bold text-foreground">{title}</h3>
        <p className="text-xs md:text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function ContentStrategy() {
  const [activeTab, setActiveTab] = useState("bulk");
  const {
    config: appConfig,
    godModeEnabled, setGodModeEnabled,
    priorityOnlyMode, setPriorityOnlyMode,
    priorityUrls, addPriorityUrl, removePriorityUrl,
    excludedUrls, setExcludedUrls,
    excludedCategories, setExcludedCategories,
    sitemapUrls, setSitemapUrls,
    addContentItem,
    contentItems,
    setCurrentStep,
  } = useOptimizerStore();

  // ── Bulk Planner State ──────────────────────────────────────────────────
  const [broadTopic, setBroadTopic] = useState("");
  const [bulkTargetAudience, setBulkTargetAudience] = useState("");
  const [bulkWordCount, setBulkWordCount] = useState(3500);
  const [bulkTone, setBulkTone] = useState<GenerationPipelineConfig['tone']>("hormozi");
  const [selectedClusterTypes, setSelectedClusterTypes] = useState<Set<string>>(
    new Set(["how-to", "guide", "comparison", "listicle", "deep-dive"])
  );
  const [bulkPriority, setBulkPriority] = useState<"high" | "medium" | "low">("high");
  const [showAdvancedBulk, setShowAdvancedBulk] = useState(false);
  const [bulkSecondaryKeywords, setBulkSecondaryKeywords] = useState("");
  const [bulkEnableSerpAnalysis, setBulkEnableSerpAnalysis] = useState(true);
  const [bulkEnableSelfCritique, setBulkEnableSelfCritique] = useState(true);
  const [bulkEnableWpImages, setBulkEnableWpImages] = useState(true);
  const [bulkEnableYouTube, setBulkEnableYouTube] = useState(true);
  const [bulkEnableReferences, setBulkEnableReferences] = useState(true);

  // ── Single Article State ────────────────────────────────────────────────
  const [keywords, setKeywords] = useState("");
  const [singleContentType, setSingleContentType] = useState<string>("single");
  const [singleWordCount, setSingleWordCount] = useState(3500);
  const [singleTone, setSingleTone] = useState<GenerationPipelineConfig['tone']>("hormozi");
  const [singleTargetAudience, setSingleTargetAudience] = useState("");
  const [singleModel, setSingleModel] = useState(appConfig.primaryModel || "gemini");
  const [showAdvancedSingle, setShowAdvancedSingle] = useState(false);
  const [enableSerpAnalysis, setEnableSerpAnalysis] = useState(true);
  const [enableSelfCritique, setEnableSelfCritique] = useState(true);
  const [enableWpImages, setEnableWpImages] = useState(true);
  const [enableYouTube, setEnableYouTube] = useState(true);
  const [enableReferences, setEnableReferences] = useState(true);
  const [maxCritiquePasses, setMaxCritiquePasses] = useState(3);
  const [singleSecondaryKws, setSingleSecondaryKws] = useState("");

  // ── Gap Analysis State ──────────────────────────────────────────────────
  const [gapKeyword, setGapKeyword] = useState("");
  const [gapAnalysisRunning, setGapAnalysisRunning] = useState(false);
  const [gapResults, setGapResults] = useState<{
    keyword: string;
    competitors: Array<{ title: string; url: string; snippet: string; position: number }>;
    contentGaps: string[];
    semanticEntities: string[];
    avgWordCount: number;
    recommendedWordCount: number;
    userIntent: string;
    commonHeadings: string[];
  } | null>(null);
  const [gapAutoGenerate, setGapAutoGenerate] = useState(false);
  const [gapSelectedGaps, setGapSelectedGaps] = useState<Set<string>>(new Set());
  const [gapSelectedEntities, setGapSelectedEntities] = useState<Set<string>>(new Set());

  // ── Quick Refresh State ─────────────────────────────────────────────────
  const [singleUrl, setSingleUrl] = useState("");
  const [refreshMode, setRefreshMode] = useState<"single" | "bulk">("single");
  const [refreshUrls, setRefreshUrls] = useState("");
  const [refreshWordCount, setRefreshWordCount] = useState(3000);
  const [refreshKeepStructure, setRefreshKeepStructure] = useState(true);
  const [refreshEnableSerpAnalysis, setRefreshEnableSerpAnalysis] = useState(true);
  const [refreshEnableSelfCritique, setRefreshEnableSelfCritique] = useState(true);
  const [refreshEnableWpImages, setRefreshEnableWpImages] = useState(true);
  const [refreshEnableYouTube, setRefreshEnableYouTube] = useState(true);

  // ── Content Hub State ───────────────────────────────────────────────────
  const [sitemapUrl, setSitemapUrl] = useState("");
  const [newPriorityUrl, setNewPriorityUrl] = useState("");
  const [newPriority, setNewPriority] = useState<'critical' | 'high' | 'medium' | 'low'>('medium');
  const [isCrawling, setIsCrawling] = useState(false);
  const [crawledUrls, setCrawledUrls] = useState<string[]>([]);
  const [crawlFoundCount, setCrawlFoundCount] = useState(0);
  const [crawlStatus, setCrawlStatus] = useState<string>("");
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [hubSearch, setHubSearch] = useState("");
  const [hubSort, setHubSort] = useState<'a-z' | 'z-a' | 'shortest' | 'longest' | 'default'>('default');
  const [hubPageSize, setHubPageSize] = useState<number>(100);
  const [hubVisibleCount, setHubVisibleCount] = useState<number>(100);
  const crawlRunIdRef = useRef(0);
  const crawlAbortRef = useRef<AbortController | null>(null);

  // ── Restore crawled URLs from store ─────────────────────────────────────
  useEffect(() => {
    if (sitemapUrls.length > 0 && crawledUrls.length === 0 && !isCrawling) {
      setCrawledUrls(sitemapUrls);
      setCrawlFoundCount(sitemapUrls.length);
      setCrawlStatus(`Previously crawled • ${sitemapUrls.length.toLocaleString()} blog posts loaded`);
    }
  }, [sitemapUrls, crawledUrls.length, isCrawling]);

  // Auto-select all gaps/entities when gap results come in
  useEffect(() => {
    if (gapResults) {
      setGapSelectedGaps(new Set(gapResults.contentGaps));
      setGapSelectedEntities(new Set(gapResults.semanticEntities));
    }
  }, [gapResults]);

  // ── URL Filtering ──────────────────────────────────────────────────────
  const filterBlogPostUrls = (urls: string[]): string[] => {
    const excludePatterns = [
      /\/wp-content\//i, /\/wp-includes\//i, /\/wp-admin\//i,
      /\/feed\/?$/i, /\/rss\/?$/i, /\/atom\/?$/i,
      /\/category\//i, /\/tag\//i, /\/author\//i, /\/page\/\d+/i,
      /\/attachment\//i, /\/trackback\/?$/i,
      /\.(jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|mp3|mp4|avi|mov)$/i,
      /\/sitemap[^/]*\.xml/i, /\/robots\.txt$/i, /\/favicon/i, /\/cdn-cgi\//i,
      /\/cart\/?$/i, /\/checkout\/?$/i, /\/my-account\/?$/i,
      /\/privacy-policy\/?$/i, /\/terms/i, /\/contact\/?$/i, /\/about\/?$/i,
      /\/search\/?/i, /\?/,
    ];
    return urls.filter(url => {
      try {
        const parsed = new URL(url);
        if (parsed.pathname === '/' || parsed.pathname === '') return false;
        for (const pattern of excludePatterns) {
          if (pattern.test(url)) return false;
        }
        return true;
      } catch { return false; }
    });
  };

  // ── Sitemap Fetching ───────────────────────────────────────────────────
  const fetchSitemapText = async (targetUrl: string, externalSignal?: AbortSignal): Promise<string> => {
    return fetchSitemapTextRaced(targetUrl, {
      signal: externalSignal,
      perStrategyTimeoutMs: 25000,
      overallTimeoutMs: 35000,
    });
  };

  // ═══════════════════════════════════════════════════════════════════════
  // HANDLERS
  // ═══════════════════════════════════════════════════════════════════════

  const handleGenerateContentPlan = () => {
    if (!broadTopic.trim()) return;

    const secondaryKws = bulkSecondaryKeywords.split('\n').map(k => k.trim()).filter(Boolean);

    const sharedPipeline = buildPipelineConfig({
      tone: bulkTone,
      targetWordCount: bulkWordCount,
      targetAudience: bulkTargetAudience || undefined,
      enableSerpAnalysis: bulkEnableSerpAnalysis,
      enableSelfCritique: bulkEnableSelfCritique,
      enableWpImages: bulkEnableWpImages,
      enableYouTube: bulkEnableYouTube,
      enableReferences: bulkEnableReferences,
      secondaryKeywords: secondaryKws.length > 0 ? secondaryKws : undefined,
    });

    // Add pillar content
    addContentItem({
      title: `${broadTopic}: The Complete Guide`,
      type: 'pillar',
      status: 'pending',
      primaryKeyword: broadTopic,
      pipelineConfig: { ...sharedPipeline, targetWordCount: Math.max(bulkWordCount, 4500), contentType: 'pillar' },
    });

    // Generate cluster content based on selected types
    const selectedTypes = Array.from(selectedClusterTypes);
    const clusterTemplates: Record<string, (topic: string) => string> = {
      "how-to": (t) => `How to ${t}: A Step-by-Step Guide`,
      "guide": (t) => `The Ultimate ${t} Guide for ${new Date().getFullYear()}`,
      "comparison": (t) => `${t}: Comparing the Top Methods & Tools`,
      "listicle": (t) => `Top 10 ${t} Tips That Actually Work`,
      "deep-dive": (t) => `${t} Deep Dive: What the Research Really Says`,
      "case-study": (t) => `${t} Case Study: Real Results From Real People`,
      "beginner": (t) => `${t} for Beginners: Everything You Need to Know`,
      "mistakes": (t) => `The 7 Biggest ${t} Mistakes (And How to Fix Them)`,
    };

    selectedTypes.forEach(type => {
      const templateFn = clusterTemplates[type];
      if (templateFn) {
        addContentItem({
          title: templateFn(broadTopic),
          type: 'cluster',
          status: 'pending',
          primaryKeyword: `${broadTopic} ${type.replace(/-/g, ' ')}`,
          pipelineConfig: { ...sharedPipeline, contentType: 'cluster' },
        });
      }
    });

    // Add secondary keyword articles
    secondaryKws.forEach(kw => {
      addContentItem({
        title: kw,
        type: 'cluster',
        status: 'pending',
        primaryKeyword: kw,
        pipelineConfig: { ...sharedPipeline, contentType: 'cluster' },
      });
    });

    const totalArticles = 1 + selectedTypes.length + secondaryKws.length;
    const estWords = totalArticles * bulkWordCount;
    const estHours = Math.ceil(totalArticles * 0.5);

    toast.success(
      `Content plan created! ${totalArticles} articles • ~${estWords.toLocaleString()} total words • ~${estHours}h generation time`,
      { duration: 5000 }
    );

    setBroadTopic("");
    setBulkSecondaryKeywords("");
    setCurrentStep(3);
  };

  const handleAddKeywords = (goToReview = false) => {
    if (!keywords.trim()) return;
    const lines = keywords.split('\n').filter(k => k.trim());
    const secondaryKws = singleSecondaryKws.split('\n').map(k => k.trim()).filter(Boolean);

    const pipeline = buildPipelineConfig({
      model: singleModel,
      tone: singleTone,
      targetWordCount: singleWordCount,
      targetAudience: singleTargetAudience || undefined,
      contentType: singleContentType,
      enableSerpAnalysis,
      enableSelfCritique,
      enableWpImages,
      enableYouTube,
      enableReferences,
      maxCritiquePasses,
      secondaryKeywords: secondaryKws.length > 0 ? secondaryKws : undefined,
    });

    lines.forEach(keyword => {
      addContentItem({
        title: keyword.trim(),
        type: singleContentType as any,
        status: 'pending',
        primaryKeyword: keyword.trim(),
        pipelineConfig: pipeline,
      });
    });
    toast.success(`Added ${lines.length} article${lines.length > 1 ? 's' : ''} to generation queue with full pipeline config`);
    setKeywords("");
    if (goToReview) setCurrentStep(3);
  };

  const handleRunGapAnalysis = async () => {
    if (!gapKeyword.trim()) return;
    const serperKey = appConfig.serperApiKey;
    if (!serperKey) {
      toast.error("Serper API key required for SERP analysis. Add it in Setup.");
      return;
    }

    setGapAnalysisRunning(true);
    setGapResults(null);

    try {
      const { createSERPAnalyzer } = await import("@/lib/sota/SERPAnalyzer");
      const analyzer = createSERPAnalyzer(serperKey);
      const analysis = await analyzer.analyze(gapKeyword.trim());

      setGapResults({
        keyword: gapKeyword.trim(),
        competitors: (analysis.topCompetitors || []).slice(0, 10).map((c: any, i: number) => ({
          title: c.title,
          url: c.url,
          snippet: c.snippet,
          position: c.position || i + 1,
        })),
        contentGaps: analysis.contentGaps || [],
        semanticEntities: analysis.semanticEntities || [],
        avgWordCount: analysis.avgWordCount || 2000,
        recommendedWordCount: analysis.recommendedWordCount || 3000,
        userIntent: analysis.userIntent || 'informational',
        commonHeadings: analysis.commonHeadings || [],
      });
      toast.success(`Gap analysis complete for "${gapKeyword}"! Found ${(analysis.contentGaps || []).length} gaps & ${(analysis.semanticEntities || []).length} entities.`);
    } catch (e) {
      toast.error(`Gap analysis failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setGapAnalysisRunning(false);
    }
  };

  const handleCreateFromGapAnalysis = () => {
    if (!gapResults) return;

    const selectedGaps = Array.from(gapSelectedGaps);
    const selectedEntities = Array.from(gapSelectedEntities);

    const pipeline = buildPipelineConfig({
      tone: 'hormozi',
      targetWordCount: Math.max(gapResults.recommendedWordCount, 3500),
      enableSerpAnalysis: true,
      enableSelfCritique: true,
      enableWpImages: true,
      enableYouTube: true,
      enableReferences: true,
      maxCritiquePasses: 3,
      gapData: {
        contentGaps: selectedGaps,
        semanticEntities: selectedEntities,
        commonHeadings: gapResults.commonHeadings,
        avgWordCount: gapResults.avgWordCount,
        recommendedWordCount: gapResults.recommendedWordCount,
        userIntent: gapResults.userIntent,
      },
    });

    addContentItem({
      title: `${gapResults.keyword}: Complete Guide (Gap-Optimized)`,
      type: 'single',
      status: 'pending',
      primaryKeyword: gapResults.keyword,
      pipelineConfig: pipeline,
    });
    toast.success(`Gap-optimized article queued with ${selectedGaps.length} gaps & ${selectedEntities.length} entities injected!`);
    setCurrentStep(3);
  };

  const handleRefreshSingle = () => {
    if (!singleUrl.trim()) return;
    try {
      const urlObj = new URL(singleUrl.trim());
      const slug = urlObj.pathname.split('/').filter(Boolean).pop() || 'untitled';
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

      const pipeline = buildPipelineConfig({
        tone: 'hormozi',
        targetWordCount: refreshWordCount,
        enableSerpAnalysis: refreshEnableSerpAnalysis,
        enableSelfCritique: refreshEnableSelfCritique,
        enableWpImages: refreshEnableWpImages,
        enableYouTube: refreshEnableYouTube,
        enableReferences: true,
        contentType: 'refresh',
      });

      // NO "Refresh:" prefix — the orchestrator will rewrite the title to a SOTA SEO/AEO/GEO title
      addContentItem({
        title,
        type: 'refresh',
        status: 'pending',
        primaryKeyword: title.toLowerCase(),
        url: singleUrl.trim(),
        pipelineConfig: pipeline,
      });
      toast.success("URL queued — title will be rewritten to a SOTA SEO/AEO/GEO version during generation.");
      setSingleUrl("");
      setCurrentStep(3);
    } catch {
      toast.error("Invalid URL. Please enter a valid URL.");
    }
  };

  const handleBulkRefresh = () => {
    const urls = refreshUrls.split('\n').map(u => u.trim()).filter(u => {
      try { new URL(u); return true; } catch { return false; }
    });
    if (urls.length === 0) { toast.error("No valid URLs found."); return; }

    const pipeline = buildPipelineConfig({
      tone: 'hormozi',
      targetWordCount: refreshWordCount,
      enableSerpAnalysis: refreshEnableSerpAnalysis,
      enableSelfCritique: refreshEnableSelfCritique,
      enableWpImages: refreshEnableWpImages,
      enableYouTube: refreshEnableYouTube,
      enableReferences: true,
      contentType: 'refresh',
    });

    urls.forEach(url => {
      const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || 'untitled';
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      // NO "Refresh:" prefix — orchestrator rewrites the title to a SOTA version
      addContentItem({
        title,
        type: 'refresh',
        status: 'pending',
        primaryKeyword: title.toLowerCase(),
        url,
        pipelineConfig: pipeline,
      });
    });

    toast.success(`${urls.length} URLs queued — titles will be rewritten to SOTA versions during generation.`);
    setRefreshUrls("");
    setCurrentStep(3);
  };

  const handleAddPriorityUrl = () => {
    if (!newPriorityUrl.trim()) return;
    addPriorityUrl(newPriorityUrl.trim(), newPriority);
    setNewPriorityUrl("");
  };

  // ── Sitemap Crawl Handler ──────────────────────────────────────────────
  const handleCrawlSitemap = async () => {
    if (!sitemapUrl.trim()) return;
    crawlAbortRef.current?.abort();
    const controller = new AbortController();
    crawlAbortRef.current = controller;
    const signal = controller.signal;
    const runId = (crawlRunIdRef.current += 1);
    setIsCrawling(true);
    setCrawledUrls([]);
    setCrawlFoundCount(0);
    setCrawlStatus("Starting…");
    setSelectedUrls(new Set());

    try {
      const input = sitemapUrl.trim();

      // WordPress API fast path
      try {
        const tryWpApi = async (): Promise<string[] | null> => {
          const ctrl = new AbortController();
          const tid = window.setTimeout(() => ctrl.abort(), 20000);
          if (signal.aborted) throw new Error("Cancelled");
          signal.addEventListener("abort", () => ctrl.abort(), { once: true });
          try {
            const res = await fetch('/api/wp-discover', {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ siteUrl: input, perPage: 100, maxPages: 250, maxUrls: 100000 }),
              signal: ctrl.signal,
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success || !Array.isArray(data?.urls)) return null;
            return data.urls as string[];
          } finally { window.clearTimeout(tid); }
        };

        setCrawlStatus("Trying WordPress API…");
        const wpUrls = (await tryWpApi()) ?? (await discoverWordPressUrls(input, {
          signal, timeoutMs: 8000, perPage: 100, maxPages: 50, maxUrls: 50000,
          onProgress: (p) => {
            if (crawlRunIdRef.current !== runId) return;
            setCrawlStatus(`WP API • ${p.endpoint} page ${p.page} • ${p.discovered.toLocaleString()} URLs`);
            setCrawlFoundCount(p.discovered);
          },
        }));

        if (wpUrls.length > 0) {
          if (crawlRunIdRef.current !== runId) return;
          const blogPostUrls = filterBlogPostUrls(wpUrls);
          setCrawledUrls(blogPostUrls);
          setSitemapUrls(blogPostUrls);
          setCrawlFoundCount(blogPostUrls.length);
          setCrawlStatus(`Done (WP API) • ${blogPostUrls.length.toLocaleString()} blog posts`);
          toast.success(`Found ${blogPostUrls.length.toLocaleString()} URLs via WordPress API!`);
          return;
        }
      } catch (e) {
        console.info("[Sitemap] WordPress API discovery skipped:", e instanceof Error ? e.message : String(e));
      }

      // Sitemap XML fallback
      const candidates: string[] = (() => {
        const normalize = (u: string) => {
          const t = u.trim();
          if (!t) return t;
          return t.startsWith("http") ? t : `https://${t}`;
        };
        const primary = normalize(input);
        const out: string[] = [];
        try {
          const origin = new URL(primary).origin;
          [`${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`, `${origin}/sitemap.xml`]
            .forEach(c => { if (!out.includes(c)) out.push(c); });
        } catch { /* noop */ }
        if (primary && !out.includes(primary)) out.push(primary);
        return out;
      })();

      let allUrls: string[] = [];
      for (const candidate of candidates) {
        if (crawlRunIdRef.current !== runId) return;
        setCrawlStatus(`Trying: ${candidate}`);
        try {
          allUrls = await crawlSitemapUrls(candidate, fetchSitemapText, {
            concurrency: 8, fetchTimeoutMs: 35000, signal,
            onProgress: (p: SitemapCrawlProgress) => {
              if (crawlRunIdRef.current !== runId) return;
              setCrawlFoundCount(p.discoveredUrls);
              setCrawlStatus(`⚡ ${p.processedSitemaps} sitemaps • ${p.discoveredUrls} URLs`);
            },
            onUrlsBatch: (batch: string[]) => {
              if (crawlRunIdRef.current !== runId) return;
              setCrawledUrls(prev => Array.from(new Set([...prev, ...filterBlogPostUrls(batch)])));
            },
          });
          if (allUrls.length > 0) break;
        } catch (e) {
          if (signal.aborted) throw new Error("Crawl cancelled");
        }
      }

      if (allUrls.length === 0) throw new Error("No URLs found from any sitemap source.");
      if (crawlRunIdRef.current !== runId) return;

      const blogPostUrls = filterBlogPostUrls(allUrls);
      setCrawledUrls(blogPostUrls);
      setSitemapUrls(blogPostUrls);
      setCrawlFoundCount(blogPostUrls.length);
      setCrawlStatus(`Done • ${blogPostUrls.length.toLocaleString()} blog posts`);
      toast.success(`Found ${blogPostUrls.length} blog post URLs!`);
    } catch (error) {
      if (crawlAbortRef.current?.signal.aborted) {
        setCrawlStatus("Cancelled.");
        toast.info("Crawl cancelled");
        return;
      }
      toast.error(error instanceof Error ? error.message : "Failed to crawl sitemap");
    } finally {
      if (crawlAbortRef.current === controller) crawlAbortRef.current = null;
      if (crawlRunIdRef.current === runId) setIsCrawling(false);
    }
  };

  const cancelCrawl = () => {
    crawlRunIdRef.current += 1;
    crawlAbortRef.current?.abort();
    crawlAbortRef.current = null;
    setIsCrawling(false);
    setCrawlStatus("Cancelled.");
  };

  const toggleUrlSelection = (url: string) => {
    setSelectedUrls(prev => { const n = new Set(prev); n.has(url) ? n.delete(url) : n.add(url); return n; });
  };

  const handleAddSelectedToRewrite = () => {
    if (selectedUrls.size === 0) return;
    const pipeline = buildPipelineConfig({ tone: 'hormozi', contentType: 'refresh' });
    selectedUrls.forEach(url => {
      const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || 'untitled';
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      addContentItem({ title, type: 'refresh', status: 'pending', primaryKeyword: title.toLowerCase(), url, pipelineConfig: pipeline });
    });
    toast.success(`Added ${selectedUrls.size} URLs to rewrite queue!`);
    setSelectedUrls(new Set());
    setCurrentStep(3);
  };

  // ── Available models ───────────────────────────────────────────────────
  const availableModels = [
    ...(appConfig.geminiApiKey ? [{ value: "gemini", label: "Google Gemini" }] : []),
    ...(appConfig.openaiApiKey ? [{ value: "openai", label: "OpenAI GPT-4o" }] : []),
    ...(appConfig.anthropicApiKey ? [{ value: "anthropic", label: "Claude 3.5 Sonnet" }] : []),
    ...(appConfig.openrouterApiKey ? [{ value: "openrouter", label: `OpenRouter${appConfig.openrouterModelId ? ` (${appConfig.openrouterModelId})` : ''}` }] : []),
    ...(appConfig.groqApiKey ? [{ value: "groq", label: `Groq${appConfig.groqModelId ? ` (${appConfig.groqModelId})` : ''}` }] : []),
  ];

  // ── Current pipeline preview for Bulk Planner ──────────────────────────
  const bulkPipeline = buildPipelineConfig({
    tone: bulkTone,
    targetWordCount: bulkWordCount,
    enableSerpAnalysis: bulkEnableSerpAnalysis,
    enableSelfCritique: bulkEnableSelfCritique,
    enableWpImages: bulkEnableWpImages,
    enableYouTube: bulkEnableYouTube,
    enableReferences: bulkEnableReferences,
  });

  const singlePipeline = buildPipelineConfig({
    model: singleModel,
    tone: singleTone,
    targetWordCount: singleWordCount,
    enableSerpAnalysis,
    enableSelfCritique,
    enableWpImages,
    enableYouTube,
    enableReferences,
    maxCritiquePasses,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════

  return (
    <div className="space-y-5 md:space-y-7">
      {/* ── Premium Hero Header ── */}
      <div className="relative overflow-hidden rounded-2xl md:rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-950/40 via-background/60 to-background/30 p-5 md:p-8 shadow-2xl">
        <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-primary/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -left-20 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-5">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-primary/15 border border-primary/30 text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-3">
              <Sparkles className="w-3 h-3" /> Step 2 · Engine Room
              {godModeEnabled && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[9px]">
                  <Bot className="w-2.5 h-2.5" /> God Mode
                </span>
              )}
            </div>
            <h1 className="text-2xl md:text-4xl font-black text-foreground tracking-tight flex items-center gap-3">
              <span className="hidden md:inline-flex w-11 h-11 items-center justify-center rounded-xl bg-gradient-to-br from-primary/30 to-emerald-700/20 border border-primary/40 shadow-lg shadow-primary/20">
                <BarChart3 className="w-5 h-5 text-primary" />
              </span>
              <span className="bg-gradient-to-r from-foreground via-foreground to-primary bg-clip-text text-transparent">
                Strategy &amp; Planning
              </span>
            </h1>
            <p className="text-muted-foreground mt-2 text-sm md:text-base max-w-xl">
              Plan pillar clusters, single articles, gap attacks, or unleash autonomous God Mode on your sitemap.
            </p>
          </div>

          <div className="grid grid-cols-4 gap-2 md:gap-3 md:flex md:items-stretch md:gap-2 shrink-0">
            <StrategyStat label="Sitemap" value={sitemapUrls.length} tone="neutral" />
            <StrategyStat label="Queued" value={contentItems.length} tone="primary" />
            <StrategyStat label="Priority" value={priorityUrls.length} tone={priorityUrls.length > 0 ? "warn" : "neutral"} />
            <StrategyStat label="Excluded" value={excludedUrls.length} tone="muted" />
          </div>
        </div>
      </div>

      {/* Tab Bar */}
      <div className="glass-card p-1.5 md:p-2 backdrop-blur-md overflow-x-auto custom-scrollbar">
        <div className="flex gap-1 md:gap-2 min-w-max md:min-w-0 md:flex-wrap">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "px-3 md:px-4 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-semibold transition-all duration-300 flex items-center gap-1.5 md:gap-2 whitespace-nowrap",
                activeTab === tab.id
                  ? "bg-primary text-primary-foreground shadow-[0_0_15px_rgba(16,185,129,0.3)]"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/20"
              )}
            >
              <tab.icon className={cn("w-3.5 h-3.5 md:w-4 md:h-4", activeTab === tab.id ? "text-primary-foreground" : "text-muted-foreground")} />
              <span className="hidden sm:inline">{tab.label}</span>
              <span className="sm:hidden">{tab.label.replace(/^[^\w]*/, '').split(' ')[0]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="glass-card p-4 md:p-8 rounded-2xl md:rounded-3xl relative overflow-hidden min-h-[400px] md:min-h-[500px]">
        <div className="absolute top-0 right-0 w-96 h-96 bg-primary/5 rounded-full blur-3xl -z-10 translate-x-1/3 -translate-y-1/3" />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-purple-500/5 rounded-full blur-3xl -z-10 -translate-x-1/3 translate-y-1/3" />

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* BULK PLANNER                                                    */}
        {/* ════════════════════════════════════════════════════════════════ */}
        {activeTab === "bulk" && (
          <div className="space-y-6">
            <SectionHeader
              icon={BookOpen}
              title="AI-Powered Bulk Content Planner"
              subtitle="Enter a topic → get a full pillar + cluster content plan with pipeline config for every article."
              gradient="bg-gradient-to-br from-primary/60 to-emerald-600/40"
            />

            {/* Topic Input */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-white">
                Core Topic / Pillar Theme <span className="text-red-400">*</span>
              </label>
              <div className="relative group">
                <input
                  type="text"
                  value={broadTopic}
                  onChange={(e) => setBroadTopic(e.target.value)}
                  placeholder="e.g., 'Trail Running Nutrition' or 'SaaS Customer Retention'"
                  className="w-full px-5 py-4 bg-black/20 backdrop-blur-sm border border-white/10 rounded-2xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all shadow-inner group-hover:bg-black/30 text-lg"
                />
                <Brain className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within:text-primary transition-colors" />
              </div>
            </div>

            {/* Writing Tone Selection */}
            <div className="space-y-3">
              <label className="block text-sm font-semibold text-white">Writing Tone</label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {TONE_OPTIONS.map(t => {
                  const selected = bulkTone === t.value;
                  return (
                    <button
                      key={t.value}
                      onClick={() => setBulkTone(t.value as any)}
                      className={cn(
                        "p-3 rounded-xl border text-left transition-all duration-200",
                        selected
                          ? "bg-primary/10 border-primary/40 shadow-lg shadow-primary/5"
                          : "bg-white/5 border-white/10 hover:border-white/20"
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <t.icon className={cn("w-4 h-4", selected ? "text-primary" : "text-zinc-400")} />
                        <span className={cn("text-sm font-bold", selected ? "text-primary" : "text-zinc-300")}>{t.label}</span>
                        {selected && <CheckCircle2 className="w-3.5 h-3.5 text-primary ml-auto" />}
                      </div>
                      <p className="text-xs text-zinc-500">{t.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Cluster Type Selection */}
            <div className="space-y-3">
              <label className="block text-sm font-semibold text-white">
                Cluster Article Types <span className="text-zinc-500 font-normal">(select which types to generate)</span>
              </label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {CLUSTER_TYPES.map(ct => {
                  const selected = selectedClusterTypes.has(ct.value);
                  return (
                    <button
                      key={ct.value}
                      onClick={() => {
                        setSelectedClusterTypes(prev => {
                          const next = new Set(prev);
                          next.has(ct.value) ? next.delete(ct.value) : next.add(ct.value);
                          return next;
                        });
                      }}
                      className={cn(
                        "p-4 rounded-xl border text-left transition-all duration-200 group",
                        selected
                          ? "bg-primary/10 border-primary/40 shadow-lg shadow-primary/5"
                          : "bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/8"
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-lg">{ct.icon}</span>
                        <span className={cn("text-sm font-bold", selected ? "text-primary" : "text-zinc-300")}>{ct.label}</span>
                        {selected && <CheckCircle2 className="w-4 h-4 text-primary ml-auto" />}
                      </div>
                      <p className="text-xs text-zinc-500 leading-relaxed">{ct.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Pipeline Status Bar */}
            <div className="p-4 bg-white/5 border border-white/10 rounded-xl space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold text-zinc-400 uppercase tracking-wider">
                <Cpu className="w-3.5 h-3.5" />
                Pipeline Configuration (applied to every article)
              </div>
              <PipelineStatusBar config={bulkPipeline} />
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {[
                  { label: 'SERP Gap Analysis', state: bulkEnableSerpAnalysis, setter: setBulkEnableSerpAnalysis },
                  { label: 'Self-Critique ×3', state: bulkEnableSelfCritique, setter: setBulkEnableSelfCritique },
                  { label: 'WP Media Images', state: bulkEnableWpImages, setter: setBulkEnableWpImages },
                  { label: 'YouTube Embed', state: bulkEnableYouTube, setter: setBulkEnableYouTube },
                  { label: 'Verified References', state: bulkEnableReferences, setter: setBulkEnableReferences },
                ].map(f => (
                  <label key={f.label} className="flex items-center gap-2 cursor-pointer group">
                    <div className={cn("w-7 h-4 rounded-full transition-colors relative",
                      f.state ? "bg-primary" : "bg-zinc-700"
                    )}>
                      <div className={cn("absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform",
                        f.state ? "translate-x-3.5" : "translate-x-0.5"
                      )} />
                    </div>
                    <input type="checkbox" checked={f.state} onChange={() => f.setter(!f.state)} className="sr-only" />
                    <span className="text-xs text-zinc-400 group-hover:text-white transition-colors">{f.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Advanced Options */}
            <button
              onClick={() => setShowAdvancedBulk(!showAdvancedBulk)}
              className="flex items-center gap-2 text-sm font-semibold text-zinc-400 hover:text-white transition-colors"
            >
              <Settings2 className="w-4 h-4" />
              Advanced Options
              {showAdvancedBulk ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showAdvancedBulk && (
              <div className="space-y-4 p-5 bg-white/5 rounded-2xl border border-white/10">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 mb-2">Target Word Count per Article</label>
                    <select
                      value={bulkWordCount}
                      onChange={(e) => setBulkWordCount(Number(e.target.value))}
                      className="w-full px-4 py-3 bg-black/20 text-white border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      <option value={2000}>2,000 words (Standard)</option>
                      <option value={3000}>3,000 words (Comprehensive)</option>
                      <option value={3500}>3,500 words (Enterprise)</option>
                      <option value={4500}>4,500 words (Pillar-grade)</option>
                      <option value={6000}>6,000+ words (Ultimate Guide)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 mb-2">Priority Level</label>
                    <select
                      value={bulkPriority}
                      onChange={(e) => setBulkPriority(e.target.value as any)}
                      className="w-full px-4 py-3 bg-black/20 text-white border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      <option value="high">High Priority</option>
                      <option value="medium">Medium Priority</option>
                      <option value="low">Low Priority</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 mb-2">Target Audience</label>
                    <input
                      type="text"
                      value={bulkTargetAudience}
                      onChange={(e) => setBulkTargetAudience(e.target.value)}
                      placeholder="e.g., 'Ultra marathon runners'"
                      className="w-full px-4 py-3 bg-black/20 text-white border border-white/10 rounded-xl placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-2">
                    Additional Keywords <span className="text-zinc-600">(one per line — each becomes an article)</span>
                  </label>
                  <textarea
                    value={bulkSecondaryKeywords}
                    onChange={(e) => setBulkSecondaryKeywords(e.target.value)}
                    placeholder={"trail running nutrition for beginners\nbest energy gels for ultra marathons\nelectrolyte management during long runs"}
                    rows={4}
                    className="w-full px-4 py-3 bg-black/20 text-white border border-white/10 rounded-xl placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                  />
                </div>
              </div>
            )}

            {/* Plan Summary */}
            {broadTopic.trim() && (
              <div className="p-5 bg-gradient-to-r from-primary/10 to-emerald-600/5 rounded-2xl border border-primary/20">
                <div className="flex items-center gap-2 mb-3">
                  <Layers className="w-4 h-4 text-primary" />
                  <span className="text-sm font-bold text-primary">Content Plan Preview</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
                  <div>
                    <div className="text-2xl font-black text-white">{1 + selectedClusterTypes.size + bulkSecondaryKeywords.split('\n').filter(k => k.trim()).length}</div>
                    <div className="text-xs text-zinc-400">Total Articles</div>
                  </div>
                  <div>
                    <div className="text-2xl font-black text-white">{((1 + selectedClusterTypes.size + bulkSecondaryKeywords.split('\n').filter(k => k.trim()).length) * bulkWordCount).toLocaleString()}</div>
                    <div className="text-xs text-zinc-400">Est. Total Words</div>
                  </div>
                  <div>
                    <div className="text-2xl font-black text-white">{Math.ceil((1 + selectedClusterTypes.size) * 0.5)}h</div>
                    <div className="text-xs text-zinc-400">Est. Gen Time</div>
                  </div>
                  <div>
                    <div className="text-2xl font-black text-white">1</div>
                    <div className="text-xs text-zinc-400">Pillar Page</div>
                  </div>
                  <div>
                    <div className="text-2xl font-black text-white">{selectedClusterTypes.size}</div>
                    <div className="text-xs text-zinc-400">Cluster Types</div>
                  </div>
                </div>
              </div>
            )}

            {/* Generate Button */}
            <button
              onClick={handleGenerateContentPlan}
              disabled={!broadTopic.trim()}
              className="w-full px-6 py-5 bg-gradient-to-r from-primary to-emerald-600 text-white font-bold text-lg rounded-2xl hover:brightness-110 disabled:opacity-50 disabled:grayscale transition-all duration-300 shadow-[0_4px_20px_rgba(16,185,129,0.3)] hover:shadow-[0_8px_30px_rgba(16,185,129,0.4)] hover:-translate-y-1 flex items-center justify-center gap-3 active:scale-[0.98]"
            >
              <Rocket className="w-6 h-6" />
              Generate {1 + selectedClusterTypes.size + bulkSecondaryKeywords.split('\n').filter(k => k.trim()).length}-Article Content Plan
            </button>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* SINGLE ARTICLE                                                  */}
        {/* ════════════════════════════════════════════════════════════════ */}
        {activeTab === "single" && (
          <div className="space-y-6">
            <SectionHeader
              icon={FileText}
              title="Single Article Generator"
              subtitle="Full control over every aspect of content generation. Pipeline config flows directly to the orchestrator."
              gradient="bg-gradient-to-br from-blue-500/60 to-indigo-600/40"
            />

            {/* Keywords Input */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-white">
                Primary Keywords <span className="text-zinc-500 font-normal">(one per line — each becomes an article)</span>
              </label>
              <textarea
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder={"best running shoes 2026\nhow to train for marathon\nrunning injury prevention tips"}
                rows={5}
                className="w-full px-5 py-4 bg-black/20 backdrop-blur-sm border border-white/10 rounded-2xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all shadow-inner resize-none font-mono text-sm"
              />
            </div>

            {/* Quick Config Row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-2">Content Type</label>
                <select
                  value={singleContentType}
                  onChange={(e) => {
                    setSingleContentType(e.target.value);
                    const ct = CONTENT_TYPES.find(c => c.value === e.target.value);
                    if (ct) setSingleWordCount(ct.words);
                  }}
                  className="w-full px-4 py-3 bg-black/20 text-white border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {CONTENT_TYPES.map(ct => (
                    <option key={ct.value} value={ct.value}>{ct.label} — {ct.desc}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-2">AI Model</label>
                <select
                  value={singleModel}
                  onChange={(e) => setSingleModel(e.target.value as any)}
                  className="w-full px-4 py-3 bg-black/20 text-white border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {availableModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  {availableModels.length === 0 && <option disabled>No API keys configured</option>}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-2">Target Word Count</label>
                <input
                  type="number"
                  value={singleWordCount}
                  onChange={(e) => setSingleWordCount(Number(e.target.value))}
                  min={1500}
                  max={8000}
                  step={500}
                  className="w-full px-4 py-3 bg-black/20 text-white border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
            </div>

            {/* Writing Tone */}
            <div className="space-y-3">
              <label className="block text-sm font-semibold text-white">Writing Tone</label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {TONE_OPTIONS.map(t => {
                  const selected = singleTone === t.value;
                  return (
                    <button
                      key={t.value}
                      onClick={() => setSingleTone(t.value as any)}
                      className={cn(
                        "p-3 rounded-xl border text-left transition-all duration-200",
                        selected
                          ? "bg-blue-500/10 border-blue-500/40 shadow-lg shadow-blue-500/5"
                          : "bg-white/5 border-white/10 hover:border-white/20"
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <t.icon className={cn("w-4 h-4", selected ? "text-blue-400" : "text-zinc-400")} />
                        <span className={cn("text-sm font-bold", selected ? "text-blue-400" : "text-zinc-300")}>{t.label}</span>
                        {selected && <CheckCircle2 className="w-3.5 h-3.5 text-blue-400 ml-auto" />}
                      </div>
                      <p className="text-xs text-zinc-500">{t.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Pipeline Status Bar */}
            <div className="p-4 bg-white/5 border border-white/10 rounded-xl space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold text-zinc-400 uppercase tracking-wider">
                <Cpu className="w-3.5 h-3.5" />
                Active Pipeline
              </div>
              <PipelineStatusBar config={singlePipeline} />
            </div>

            {/* Advanced Toggle */}
            <button
              onClick={() => setShowAdvancedSingle(!showAdvancedSingle)}
              className="flex items-center gap-2 text-sm font-semibold text-zinc-400 hover:text-white transition-colors"
            >
              <Settings2 className="w-4 h-4" />
              Pipeline Configuration
              {showAdvancedSingle ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showAdvancedSingle && (
              <div className="space-y-5 p-5 bg-white/5 rounded-2xl border border-white/10">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 mb-2">Target Audience</label>
                    <input
                      type="text"
                      value={singleTargetAudience}
                      onChange={(e) => setSingleTargetAudience(e.target.value)}
                      placeholder="e.g., 'SaaS founders with $1M+ ARR'"
                      className="w-full px-4 py-3 bg-black/20 text-white border border-white/10 rounded-xl placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 mb-2">Secondary Keywords (one per line)</label>
                    <textarea
                      value={singleSecondaryKws}
                      onChange={(e) => setSingleSecondaryKws(e.target.value)}
                      placeholder={"related keyword 1\nrelated keyword 2"}
                      rows={2}
                      className="w-full px-4 py-3 bg-black/20 text-white border border-white/10 rounded-xl placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                    />
                  </div>
                </div>

                {/* Pipeline Feature Toggles */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-3">Pipeline Features</label>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {[
                      { key: 'serp', label: 'SERP Gap Analysis', icon: TrendingUp, state: enableSerpAnalysis, setter: setEnableSerpAnalysis, color: 'text-blue-400', desc: 'Analyze top SERP results and inject missing gaps' },
                      { key: 'critique', label: 'Self-Critique Engine', icon: ShieldCheck, state: enableSelfCritique, setter: setEnableSelfCritique, color: 'text-amber-400', desc: 'Up to 3 ruthless rewrite passes for 92+ quality' },
                      { key: 'wpimg', label: 'WP Media Images', icon: Image, state: enableWpImages, setter: setEnableWpImages, color: 'text-purple-400', desc: '2 relevant images from your WP media library' },
                      { key: 'yt', label: 'YouTube Video Embed', icon: Globe, state: enableYouTube, setter: setEnableYouTube, color: 'text-red-400', desc: '1 verified relevant YouTube video embedded' },
                      { key: 'refs', label: 'Verified References', icon: Link, state: enableReferences, setter: setEnableReferences, color: 'text-emerald-400', desc: 'Clickable citations from authoritative sources' },
                    ].map(f => (
                      <label key={f.key} className={cn(
                        "flex flex-col gap-2 p-3 rounded-xl border cursor-pointer transition-all",
                        f.state ? "bg-white/5 border-white/20" : "bg-black/10 border-white/5 opacity-60"
                      )}>
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={f.state}
                            onChange={() => f.setter(!f.state)}
                            className="sr-only peer"
                          />
                          <div className={cn("w-8 h-5 rounded-full transition-colors relative",
                            f.state ? "bg-primary" : "bg-zinc-700"
                          )}>
                            <div className={cn("absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform",
                              f.state ? "translate-x-3.5" : "translate-x-0.5"
                            )} />
                          </div>
                          <div className="flex items-center gap-2">
                            <f.icon className={cn("w-4 h-4", f.color)} />
                            <span className="text-xs font-semibold text-zinc-300">{f.label}</span>
                          </div>
                        </div>
                        <p className="text-[11px] text-zinc-500 pl-11">{f.desc}</p>
                      </label>
                    ))}
                  </div>
                </div>

                {enableSelfCritique && (
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 mb-2">Max Self-Critique Passes</label>
                    <div className="flex items-center gap-4">
                      {[1, 2, 3].map(n => (
                        <button
                          key={n}
                          onClick={() => setMaxCritiquePasses(n)}
                          className={cn(
                            "px-4 py-2 rounded-lg text-sm font-bold transition-all",
                            maxCritiquePasses === n
                              ? "bg-primary text-white shadow-lg shadow-primary/20"
                              : "bg-white/5 text-zinc-400 hover:text-white"
                          )}
                        >
                          {n} {n === 1 ? 'pass' : 'passes'}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3">
              <button
                onClick={() => handleAddKeywords(false)}
                disabled={!keywords.trim()}
                className="flex-1 px-6 py-4 bg-white/5 border border-white/10 text-foreground font-semibold rounded-xl hover:bg-white/10 disabled:opacity-50 flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
              >
                <Plus className="w-5 h-5" />
                Add to Queue
              </button>
              <button
                onClick={() => handleAddKeywords(true)}
                disabled={!keywords.trim()}
                className="flex-1 px-6 py-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold rounded-xl hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-blue-600/20 transition-all hover:-translate-y-0.5 active:scale-[0.98]"
              >
                <Zap className="w-5 h-5 fill-current" />
                Add & Generate Now
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* GOD MODE 2.0                                                    */}
        {/* ════════════════════════════════════════════════════════════════ */}
        {activeTab === "godmode" && <GodModeDashboard />}

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* GAP ANALYSIS                                                    */}
        {/* ════════════════════════════════════════════════════════════════ */}
        {activeTab === "gap" && (
          <div className="space-y-6">
            <SectionHeader
              icon={Target}
              title="SERP Gap Analysis Engine"
              subtitle="Analyze top SERP results → identify 20+ content gaps → generate gap-optimized articles with selected gaps/entities injected."
              gradient="bg-gradient-to-br from-amber-500/60 to-orange-600/40"
            />

            {/* Gap Analysis Input */}
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="flex-1 relative group">
                  <input
                    type="text"
                    value={gapKeyword}
                    onChange={(e) => setGapKeyword(e.target.value)}
                    placeholder="Enter keyword to analyze (e.g., 'best trail running shoes 2026')"
                    onKeyDown={(e) => e.key === 'Enter' && handleRunGapAnalysis()}
                    className="w-full px-5 py-4 bg-black/20 backdrop-blur-sm border border-white/10 rounded-2xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50 transition-all shadow-inner group-hover:bg-black/30 text-lg"
                  />
                  <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within:text-amber-400 transition-colors" />
                </div>
                <button
                  onClick={handleRunGapAnalysis}
                  disabled={!gapKeyword.trim() || gapAnalysisRunning || !appConfig.serperApiKey}
                  className="px-8 py-4 bg-gradient-to-r from-amber-500 to-orange-600 text-white font-bold rounded-2xl hover:brightness-110 disabled:opacity-50 disabled:grayscale transition-all shadow-lg shadow-amber-500/20 flex items-center gap-2 active:scale-[0.98]"
                >
                  {gapAnalysisRunning ? (
                    <><Loader2 className="w-5 h-5 animate-spin" /> Analyzing...</>
                  ) : (
                    <><TrendingUp className="w-5 h-5" /> Analyze SERP</>
                  )}
                </button>
              </div>

              {!appConfig.serperApiKey && (
                <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  Serper API key required. Add it in Setup → AI Provider config.
                </div>
              )}
            </div>

            {/* Loading skeleton while SERP analysis runs */}
            {gapAnalysisRunning && !gapResults && (
              <div className="space-y-5 animate-fade-in" aria-busy="true" aria-live="polite">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="p-4 bg-white/5 border border-white/10 rounded-xl space-y-2">
                      <div className="h-3 w-24 rounded bg-white/10 animate-shimmer" />
                      <div className="h-6 w-16 rounded bg-white/10 animate-shimmer" />
                    </div>
                  ))}
                </div>
                <div className="p-5 bg-white/5 border border-white/10 rounded-2xl space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-start gap-3 p-3 bg-black/20 rounded-xl">
                      <div className="w-7 h-7 rounded-lg bg-white/10 animate-shimmer flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 w-2/3 rounded bg-white/10 animate-shimmer" />
                        <div className="h-2.5 w-1/2 rounded bg-white/5 animate-shimmer" />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-center text-xs text-amber-300/70 flex items-center justify-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Scanning top SERP competitors…
                </div>
              </div>
            )}

            {/* Gap Results */}
            {gapResults && (
              <div className="space-y-5">
                {/* Overview Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: "User Intent", value: gapResults.userIntent.toUpperCase(), icon: Eye, color: "text-blue-400" },
                    { label: "Avg Competitor Words", value: gapResults.avgWordCount.toLocaleString(), icon: Hash, color: "text-emerald-400" },
                    { label: "Recommended Length", value: `${gapResults.recommendedWordCount.toLocaleString()}+`, icon: Gauge, color: "text-amber-400" },
                    { label: "Content Gaps Found", value: gapResults.contentGaps.length.toString(), icon: Target, color: "text-red-400" },
                  ].map(stat => (
                    <div key={stat.label} className="p-4 bg-white/5 border border-white/10 rounded-xl">
                      <div className="flex items-center gap-2 mb-2">
                        <stat.icon className={cn("w-4 h-4", stat.color)} />
                        <span className="text-xs text-zinc-500 font-semibold">{stat.label}</span>
                      </div>
                      <div className="text-xl font-black text-white">{stat.value}</div>
                    </div>
                  ))}
                </div>

                {/* Top Competitors */}
                <div className="p-5 bg-white/5 border border-white/10 rounded-2xl">
                  <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                    <Star className="w-4 h-4 text-amber-400" />
                    Top Competitors
                  </h4>
                  <div className="space-y-2">
                    {gapResults.competitors.slice(0, 5).map((c, i) => (
                      <div key={i} className="flex items-start gap-3 p-3 bg-black/20 rounded-xl">
                        <span className="flex-shrink-0 w-7 h-7 bg-gradient-to-br from-amber-500 to-orange-600 text-white rounded-lg flex items-center justify-center text-xs font-black">
                          #{c.position}
                        </span>
                        <div className="flex-1 min-w-0">
                          <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-blue-400 hover:underline line-clamp-1">{c.title}</a>
                          <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{c.snippet}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Content Gaps — Selectable */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-5 bg-white/5 border border-white/10 rounded-2xl">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-bold text-white flex items-center gap-2">
                        <Target className="w-4 h-4 text-red-400" />
                        Content Gaps <span className="text-zinc-500 font-normal">({gapSelectedGaps.size}/{gapResults.contentGaps.length} selected)</span>
                      </h4>
                      <div className="flex gap-1">
                        <button onClick={() => setGapSelectedGaps(new Set(gapResults.contentGaps))} className="text-[10px] text-primary hover:underline">All</button>
                        <span className="text-zinc-600 text-[10px]">|</span>
                        <button onClick={() => setGapSelectedGaps(new Set())} className="text-[10px] text-zinc-400 hover:underline">None</button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto custom-scrollbar">
                      {gapResults.contentGaps.slice(0, 30).map((gap, i) => {
                        const selected = gapSelectedGaps.has(gap);
                        return (
                          <button
                            key={i}
                            onClick={() => {
                              setGapSelectedGaps(prev => {
                                const n = new Set(prev);
                                n.has(gap) ? n.delete(gap) : n.add(gap);
                                return n;
                              });
                            }}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-xs font-medium transition-all border",
                              selected
                                ? "bg-red-500/20 border-red-500/40 text-red-300"
                                : "bg-white/5 border-white/10 text-zinc-500 hover:text-zinc-300"
                            )}
                          >
                            {selected && <span className="mr-1">✓</span>}{gap}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="p-5 bg-white/5 border border-white/10 rounded-2xl">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-bold text-white flex items-center gap-2">
                        <Globe className="w-4 h-4 text-emerald-400" />
                        Semantic Entities <span className="text-zinc-500 font-normal">({gapSelectedEntities.size}/{gapResults.semanticEntities.length} selected)</span>
                      </h4>
                      <div className="flex gap-1">
                        <button onClick={() => setGapSelectedEntities(new Set(gapResults.semanticEntities))} className="text-[10px] text-primary hover:underline">All</button>
                        <span className="text-zinc-600 text-[10px]">|</span>
                        <button onClick={() => setGapSelectedEntities(new Set())} className="text-[10px] text-zinc-400 hover:underline">None</button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto custom-scrollbar">
                      {gapResults.semanticEntities.slice(0, 30).map((entity, i) => {
                        const selected = gapSelectedEntities.has(entity);
                        return (
                          <button
                            key={i}
                            onClick={() => {
                              setGapSelectedEntities(prev => {
                                const n = new Set(prev);
                                n.has(entity) ? n.delete(entity) : n.add(entity);
                                return n;
                              });
                            }}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-xs font-medium transition-all border",
                              selected
                                ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                                : "bg-white/5 border-white/10 text-zinc-500 hover:text-zinc-300"
                            )}
                          >
                            {selected && <span className="mr-1">✓</span>}{entity}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Common Headings */}
                {gapResults.commonHeadings.length > 0 && (
                  <div className="p-5 bg-white/5 border border-white/10 rounded-2xl">
                    <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                      <ListChecks className="w-4 h-4 text-blue-400" />
                      Common Competitor Headings
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {gapResults.commonHeadings.slice(0, 16).map((h, i) => (
                        <div key={i} className="flex items-center gap-2 px-3 py-2 bg-black/20 rounded-lg text-xs text-zinc-300">
                          <span className="text-blue-400 font-bold">H2</span>
                          {h}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Generation Summary */}
                <div className="p-4 bg-gradient-to-r from-amber-500/10 to-orange-500/5 border border-amber-500/20 rounded-xl">
                  <div className="text-sm text-zinc-300 space-y-1">
                    <p className="font-bold text-amber-300">📊 Gap-Optimized Article will include:</p>
                    <ul className="text-xs text-zinc-400 grid grid-cols-2 gap-1">
                      <li>• {gapSelectedGaps.size} content gaps injected</li>
                      <li>• {gapSelectedEntities.size} semantic entities</li>
                      <li>• {gapResults.commonHeadings.length} competitor headings analyzed</li>
                      <li>• Target: {gapResults.recommendedWordCount.toLocaleString()}+ words</li>
                      <li>• 3-pass self-critique for 92+ quality</li>
                      <li>• WP images + YouTube + references</li>
                    </ul>
                  </div>
                </div>

                {/* Action Button */}
                <button
                  onClick={handleCreateFromGapAnalysis}
                  className="w-full px-6 py-5 bg-gradient-to-r from-amber-500 to-orange-600 text-white font-bold text-lg rounded-2xl hover:brightness-110 transition-all shadow-lg shadow-amber-500/20 hover:-translate-y-1 flex items-center justify-center gap-3 active:scale-[0.98]"
                >
                  <Wand2 className="w-6 h-6" />
                  Create Gap-Optimized Article ({gapSelectedGaps.size} gaps + {gapSelectedEntities.size} entities)
                </button>
              </div>
            )}

            {/* Priority URL Queue */}
            <div className="border-t border-white/10 pt-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/20 rounded-lg">
                  <Target className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h4 className="font-bold text-white">Priority URL Queue</h4>
                  <p className="text-xs text-zinc-500">URLs that God Mode will process first.</p>
                </div>
                <span className="ml-auto px-3 py-1 bg-white/5 rounded-full text-xs font-medium text-zinc-400 border border-white/5">{priorityUrls.length} Total</span>
              </div>

              <div className="flex gap-3">
                <select
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value as any)}
                  className="px-4 py-3 bg-black/20 text-white border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
                <input
                  type="url"
                  value={newPriorityUrl}
                  onChange={(e) => setNewPriorityUrl(e.target.value)}
                  placeholder="Enter URL to prioritize"
                  className="flex-1 px-5 py-3 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  onClick={handleAddPriorityUrl}
                  disabled={!newPriorityUrl.trim()}
                  className="px-5 py-3 bg-primary text-white rounded-xl hover:bg-primary/90 disabled:opacity-50 transition-all active:scale-95 shadow-lg shadow-primary/20"
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>

              {priorityUrls.length > 0 && (
                <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                  {priorityUrls.map(url => (
                    <div key={url.id} className="flex items-center gap-3 px-4 py-3 bg-white/5 border border-white/5 rounded-xl text-sm group hover:bg-white/10 transition-colors">
                      <span className={cn(
                        "px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wider",
                        url.priority === 'critical' && "bg-red-500/20 text-red-400 border border-red-500/20",
                        url.priority === 'high' && "bg-orange-500/20 text-orange-400 border border-orange-500/20",
                        url.priority === 'medium' && "bg-yellow-500/20 text-yellow-400 border border-yellow-500/20",
                        url.priority === 'low' && "bg-emerald-500/20 text-emerald-400 border border-emerald-500/20"
                      )}>
                        {url.priority}
                      </span>
                      <span className="flex-1 truncate text-zinc-300 font-mono text-xs">{url.url}</span>
                      <button
                        onClick={() => removePriorityUrl(url.id)}
                        className="text-zinc-500 hover:text-red-400 transition-colors p-2 hover:bg-red-500/10 rounded-lg opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Exclusion Controls */}
            <div className="border-t border-white/10 pt-6">
              <h4 className="font-bold text-white mb-4 flex items-center gap-2">
                <XCircle className="w-5 h-5 text-red-400" />
                Exclusion Controls
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-3">Exclude URLs (one per line)</label>
                  <textarea
                    value={excludedUrls.join('\n')}
                    onChange={(e) => setExcludedUrls(e.target.value.split('\n').filter(u => u.trim()))}
                    rows={4}
                    className="w-full px-4 py-3 bg-black/20 border border-white/10 rounded-xl text-sm text-zinc-300 placeholder:text-zinc-600 resize-none focus:outline-none focus:ring-2 focus:ring-red-500/50"
                    placeholder="/privacy-policy&#10;/terms-of-service"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-3">Exclude Categories (one per line)</label>
                  <textarea
                    value={excludedCategories.join('\n')}
                    onChange={(e) => setExcludedCategories(e.target.value.split('\n').filter(c => c.trim()))}
                    rows={4}
                    className="w-full px-4 py-3 bg-black/20 border border-white/10 rounded-xl text-sm text-zinc-300 placeholder:text-zinc-600 resize-none focus:outline-none focus:ring-2 focus:ring-red-500/50"
                    placeholder="uncategorized&#10;archive"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* QUICK REFRESH                                                   */}
        {/* ════════════════════════════════════════════════════════════════ */}
        {activeTab === "refresh" && (
          <div className="space-y-6">
            <SectionHeader
              icon={RefreshCw}
              title="Quick Refresh & Content Update"
              subtitle="Rewrite existing content with fresh SERP data, gap analysis, images, YouTube, and references — all with full pipeline."
              gradient="bg-gradient-to-br from-cyan-500/60 to-blue-600/40"
            />

            {/* Mode Toggle */}
            <div className="flex gap-2 p-1 bg-white/5 rounded-xl border border-white/10 w-fit">
              <button
                onClick={() => setRefreshMode("single")}
                className={cn(
                  "px-5 py-2.5 rounded-lg text-sm font-semibold transition-all",
                  refreshMode === "single" ? "bg-primary text-white shadow-lg" : "text-zinc-400 hover:text-white"
                )}
              >
                Single URL
              </button>
              <button
                onClick={() => setRefreshMode("bulk")}
                className={cn(
                  "px-5 py-2.5 rounded-lg text-sm font-semibold transition-all",
                  refreshMode === "bulk" ? "bg-primary text-white shadow-lg" : "text-zinc-400 hover:text-white"
                )}
              >
                Bulk URLs
              </button>
            </div>

            {/* Pipeline Config for Refresh */}
            <div className="p-4 bg-white/5 border border-white/10 rounded-xl space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold text-zinc-400 uppercase tracking-wider">
                <Cpu className="w-3.5 h-3.5" />
                Refresh Pipeline
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'SERP Re-Analysis', state: refreshEnableSerpAnalysis, setter: setRefreshEnableSerpAnalysis },
                  { label: 'Self-Critique ×3', state: refreshEnableSelfCritique, setter: setRefreshEnableSelfCritique },
                  { label: 'WP Media Images', state: refreshEnableWpImages, setter: setRefreshEnableWpImages },
                  { label: 'YouTube Embed', state: refreshEnableYouTube, setter: setRefreshEnableYouTube },
                ].map(f => (
                  <label key={f.label} className="flex items-center gap-2 cursor-pointer group">
                    <div className={cn("w-7 h-4 rounded-full transition-colors relative",
                      f.state ? "bg-primary" : "bg-zinc-700"
                    )}>
                      <div className={cn("absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform",
                        f.state ? "translate-x-3.5" : "translate-x-0.5"
                      )} />
                    </div>
                    <input type="checkbox" checked={f.state} onChange={() => f.setter(!f.state)} className="sr-only" />
                    <span className="text-xs text-zinc-400 group-hover:text-white transition-colors">{f.label}</span>
                  </label>
                ))}
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-2">Target Word Count</label>
                <select
                  value={refreshWordCount}
                  onChange={(e) => setRefreshWordCount(Number(e.target.value))}
                  className="w-full px-4 py-2.5 bg-black/20 text-white border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/50 text-sm"
                >
                  <option value={2000}>2,000 words</option>
                  <option value={3000}>3,000 words</option>
                  <option value={3500}>3,500 words</option>
                  <option value={4500}>4,500 words</option>
                </select>
              </div>
            </div>

            {refreshMode === "single" ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-white mb-2">Post URL to Refresh</label>
                  <div className="relative group">
                    <input
                      type="url"
                      value={singleUrl}
                      onChange={(e) => setSingleUrl(e.target.value)}
                      placeholder="https://your-site.com/post-to-refresh"
                      className="w-full px-5 py-4 bg-black/20 backdrop-blur-sm border border-white/10 rounded-2xl text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-all shadow-inner group-hover:bg-black/30"
                    />
                    <Link className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within:text-cyan-400 transition-colors" />
                  </div>
                </div>

                {/* Refresh info */}
                <div className="p-4 bg-cyan-500/5 border border-cyan-500/20 rounded-xl">
                  <div className="flex items-start gap-3">
                    <ShieldCheck className="w-5 h-5 text-cyan-400 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-zinc-300 space-y-1">
                      <p className="font-semibold text-cyan-300">What happens during a refresh:</p>
                      <ul className="text-xs text-zinc-400 space-y-1 list-none">
                        <li>• Fetches existing content from WordPress via REST API</li>
                        <li>• Runs live SERP gap analysis for the target keyword</li>
                        <li>• Generates improved content with gap coverage + missing entities</li>
                        <li>• Injects 2 relevant images from your WP media library</li>
                        <li>• Embeds 1 verified relevant YouTube video</li>
                        <li>• Adds clickable verified references</li>
                        <li>• Self-critique ensures 92+ quality score before finalization</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <button
                  onClick={handleRefreshSingle}
                  disabled={!singleUrl.trim()}
                  className="w-full px-6 py-5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white font-bold text-lg rounded-2xl hover:brightness-110 disabled:opacity-50 disabled:grayscale transition-all duration-300 shadow-lg shadow-cyan-600/20 hover:-translate-y-1 flex items-center justify-center gap-3 active:scale-[0.98]"
                >
                  <RefreshCw className="w-6 h-6" />
                  Refresh & Optimize
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-white mb-2">
                    URLs to Refresh <span className="text-zinc-500 font-normal">(one per line)</span>
                  </label>
                  <textarea
                    value={refreshUrls}
                    onChange={(e) => setRefreshUrls(e.target.value)}
                    placeholder={"https://your-site.com/post-1\nhttps://your-site.com/post-2\nhttps://your-site.com/post-3"}
                    rows={8}
                    className="w-full px-5 py-4 bg-black/20 backdrop-blur-sm border border-white/10 rounded-2xl text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-all shadow-inner resize-none font-mono text-sm"
                  />
                </div>
                <button
                  onClick={handleBulkRefresh}
                  disabled={!refreshUrls.trim()}
                  className="w-full px-6 py-5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white font-bold text-lg rounded-2xl hover:brightness-110 disabled:opacity-50 disabled:grayscale transition-all duration-300 shadow-lg shadow-cyan-600/20 hover:-translate-y-1 flex items-center justify-center gap-3 active:scale-[0.98]"
                >
                  <RefreshCw className="w-6 h-6" />
                  Refresh {refreshUrls.split('\n').filter(u => u.trim()).length} URLs
                </button>
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* CONTENT HUB                                                     */}
        {/* ════════════════════════════════════════════════════════════════ */}
        {activeTab === "hub" && (
          <div className="space-y-4">
            <SectionHeader
              icon={FolderOpen}
              title="Content Hub & Rewrite Assistant"
              subtitle="Crawl your sitemap, select posts, and generate strategic rewrites with full pipeline."
              gradient="bg-gradient-to-br from-purple-500/60 to-pink-600/40"
            />
            <div>
              <label className="block text-sm font-medium text-white mb-3">Sitemap URL</label>
              <input
                type="url"
                value={sitemapUrl}
                onChange={(e) => setSitemapUrl(e.target.value)}
                placeholder="https://your-site.com/sitemap.xml"
                className="w-full px-5 py-4 bg-black/20 backdrop-blur-sm border border-white/10 rounded-2xl text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all shadow-inner"
              />
            </div>
            <button
              onClick={isCrawling ? cancelCrawl : handleCrawlSitemap}
              disabled={!isCrawling && !sitemapUrl.trim()}
              className="w-full px-6 py-4 bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold text-lg rounded-2xl hover:brightness-110 disabled:opacity-50 disabled:grayscale transition-all shadow-lg shadow-purple-600/20 hover:-translate-y-1 flex items-center justify-center gap-3 active:scale-[0.98]"
            >
              {isCrawling ? (
                <><Loader2 className="w-6 h-6 animate-spin" /> Crawling… ({crawlFoundCount.toLocaleString()} URLs) • Click to stop</>
              ) : (
                <><Search className="w-6 h-6" /> Crawl Sitemap</>
              )}
            </button>

            {isCrawling && crawlStatus && <div className="text-xs text-muted-foreground">{crawlStatus}</div>}

            {(crawledUrls.length > 0 || crawlFoundCount > 0) && (() => {
              const q = hubSearch.trim().toLowerCase();
              const filtered = q ? crawledUrls.filter(u => u.toLowerCase().includes(q)) : crawledUrls.slice();
              const sorted = (() => {
                const arr = filtered.slice();
                if (hubSort === 'a-z') arr.sort((a, b) => a.localeCompare(b));
                else if (hubSort === 'z-a') arr.sort((a, b) => b.localeCompare(a));
                else if (hubSort === 'shortest') arr.sort((a, b) => a.length - b.length);
                else if (hubSort === 'longest') arr.sort((a, b) => b.length - a.length);
                return arr;
              })();
              const visible = sorted.slice(0, hubVisibleCount);
              const remaining = sorted.length - visible.length;
              const filteredSet = new Set(filtered);
              const selectedInFiltered = filtered.filter(u => selectedUrls.has(u)).length;

              return (
                <div className="mt-4 p-5 bg-gradient-to-br from-purple-950/30 via-zinc-900/50 to-pink-950/20 border border-purple-500/20 rounded-2xl shadow-xl">
                  {/* Stats Header */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    <div className="px-4 py-3 bg-black/30 rounded-xl border border-white/5">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Total Found</div>
                      <div className="text-2xl font-bold text-white tabular-nums">{crawledUrls.length.toLocaleString()}</div>
                    </div>
                    <div className="px-4 py-3 bg-black/30 rounded-xl border border-white/5">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Filtered</div>
                      <div className="text-2xl font-bold text-purple-300 tabular-nums">{filtered.length.toLocaleString()}</div>
                    </div>
                    <div className="px-4 py-3 bg-black/30 rounded-xl border border-white/5">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Selected</div>
                      <div className="text-2xl font-bold text-primary tabular-nums">{selectedUrls.size.toLocaleString()}</div>
                    </div>
                    <div className="px-4 py-3 bg-black/30 rounded-xl border border-white/5">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Showing</div>
                      <div className="text-2xl font-bold text-pink-300 tabular-nums">{visible.length.toLocaleString()}</div>
                    </div>
                  </div>

                  {crawlStatus && !isCrawling && <p className="text-xs text-muted-foreground mb-3">{crawlStatus}</p>}

                  {/* Toolbar */}
                  <div className="flex flex-col md:flex-row gap-2 mb-3">
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                      <input
                        type="text"
                        value={hubSearch}
                        onChange={(e) => { setHubSearch(e.target.value); setHubVisibleCount(hubPageSize); }}
                        placeholder="Search 1,313+ URLs by keyword, slug, path…"
                        className="w-full pl-10 pr-3 py-2.5 bg-black/30 border border-white/10 rounded-xl text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                      />
                    </div>
                    <select
                      value={hubSort}
                      onChange={(e) => setHubSort(e.target.value as typeof hubSort)}
                      className="px-3 py-2.5 bg-black/30 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    >
                      <option value="default">Sort: Default</option>
                      <option value="a-z">A → Z</option>
                      <option value="z-a">Z → A</option>
                      <option value="shortest">Shortest URL</option>
                      <option value="longest">Longest URL</option>
                    </select>
                    <select
                      value={hubPageSize}
                      onChange={(e) => { const n = Number(e.target.value); setHubPageSize(n); setHubVisibleCount(n); }}
                      className="px-3 py-2.5 bg-black/30 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    >
                      <option value={50}>50 / page</option>
                      <option value={100}>100 / page</option>
                      <option value={250}>250 / page</option>
                      <option value={500}>500 / page</option>
                      <option value={9999}>Show all</option>
                    </select>
                  </div>

                  {/* Selection actions */}
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <button onClick={() => setSelectedUrls(new Set([...selectedUrls, ...filtered]))} className="px-3 py-1.5 text-xs font-semibold bg-primary/20 text-primary rounded-lg hover:bg-primary/30">
                      Select All Filtered ({filtered.length.toLocaleString()})
                    </button>
                    <button onClick={() => setSelectedUrls(new Set(crawledUrls))} className="px-3 py-1.5 text-xs font-semibold bg-purple-500/20 text-purple-300 rounded-lg hover:bg-purple-500/30">
                      Select All ({crawledUrls.length.toLocaleString()})
                    </button>
                    <button onClick={() => {
                      const next = new Set(selectedUrls);
                      filtered.forEach(u => next.delete(u));
                      setSelectedUrls(next);
                    }} className="px-3 py-1.5 text-xs font-semibold bg-amber-500/20 text-amber-300 rounded-lg hover:bg-amber-500/30">
                      Deselect Filtered ({selectedInFiltered})
                    </button>
                    <button onClick={() => setSelectedUrls(new Set())} className="px-3 py-1.5 text-xs font-semibold bg-zinc-700/40 text-zinc-300 rounded-lg hover:bg-zinc-700/60">
                      Clear All
                    </button>
                    <button onClick={() => {
                      const next = new Set<string>();
                      filtered.forEach(u => { if (!selectedUrls.has(u)) next.add(u); });
                      // keep selections outside filter
                      selectedUrls.forEach(u => { if (!filteredSet.has(u)) next.add(u); });
                      setSelectedUrls(next);
                    }} className="px-3 py-1.5 text-xs font-semibold bg-fuchsia-500/20 text-fuchsia-300 rounded-lg hover:bg-fuchsia-500/30">
                      Invert Filtered
                    </button>
                  </div>

                  {selectedUrls.size > 0 && (
                    <button
                      onClick={handleAddSelectedToRewrite}
                      className="mb-3 w-full px-4 py-3 bg-gradient-to-r from-primary to-emerald-600 text-white rounded-xl text-sm font-bold hover:brightness-110 transition-all shadow-lg shadow-primary/20 flex items-center justify-center gap-2"
                    >
                      <ArrowRight className="w-4 h-4" />
                      Rewrite {selectedUrls.size.toLocaleString()} Selected Posts
                    </button>
                  )}

                  {/* URL List — large window, virtualized-ish via pagination */}
                  <div className="max-h-[600px] overflow-y-auto space-y-1 pr-2 custom-scrollbar bg-black/20 rounded-xl p-2 border border-white/5">
                    {visible.length === 0 && (
                      <div className="text-center py-12 text-zinc-500 text-sm">
                        No URLs match "{hubSearch}". Try a different search.
                      </div>
                    )}
                    {visible.map((url, idx) => {
                      const checked = selectedUrls.has(url);
                      let path = url;
                      try { path = new URL(url).pathname; } catch {}
                      const slug = path.replace(/\/+$/, '').split('/').pop() || path;
                      return (
                        <label key={url} className={cn(
                          "flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs cursor-pointer transition-all border",
                          checked
                            ? "bg-primary/10 text-primary border-primary/30 shadow-sm"
                            : "text-zinc-300 hover:bg-white/5 border-transparent hover:border-white/10"
                        )}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleUrlSelection(url)}
                            className="accent-primary w-4 h-4 flex-shrink-0"
                          />
                          <span className="text-[10px] font-mono text-zinc-500 w-10 flex-shrink-0 tabular-nums">#{(idx + 1).toLocaleString()}</span>
                          <div className="flex-1 min-w-0">
                            <div className="truncate font-medium text-sm">{slug}</div>
                            <div className="truncate font-mono text-[10px] text-zinc-500">{url}</div>
                          </div>
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="flex-shrink-0 px-2 py-1 text-[10px] bg-white/5 hover:bg-white/10 rounded text-zinc-400 hover:text-white"
                          >Open ↗</a>
                        </label>
                      );
                    })}
                  </div>

                  {/* Load more */}
                  {remaining > 0 && (
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <p className="text-xs text-zinc-500">
                        Showing {visible.length.toLocaleString()} of {sorted.length.toLocaleString()} • {remaining.toLocaleString()} more available
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setHubVisibleCount(c => c + hubPageSize)}
                          className="px-4 py-2 text-xs font-semibold bg-purple-500/20 text-purple-200 rounded-lg hover:bg-purple-500/30"
                        >
                          Load {Math.min(hubPageSize, remaining).toLocaleString()} More
                        </button>
                        <button
                          onClick={() => setHubVisibleCount(sorted.length)}
                          className="px-4 py-2 text-xs font-semibold bg-pink-500/20 text-pink-200 rounded-lg hover:bg-pink-500/30"
                        >
                          Show All ({sorted.length.toLocaleString()})
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

function StrategyStat({ label, value, tone }: { label: string; value: number; tone: "neutral" | "primary" | "warn" | "muted" }) {
  const toneClass = {
    neutral: "from-white/5 ring-white/10 text-zinc-200",
    primary: "from-primary/15 ring-primary/30 text-primary",
    warn: "from-amber-400/15 ring-amber-400/30 text-amber-300",
    muted: "from-white/5 ring-white/10 text-zinc-500",
  }[tone];
  return (
    <div className={cn(
      "rounded-xl md:rounded-2xl px-3 py-2 md:px-3.5 md:py-2.5 ring-1 bg-gradient-to-br to-transparent flex flex-col items-start min-w-[64px]",
      toneClass
    )}>
      <span className="text-[9px] md:text-[10px] uppercase tracking-[0.18em] font-bold opacity-80">{label}</span>
      <span className="text-base md:text-lg font-black tabular-nums leading-tight mt-0.5">
        {value.toLocaleString()}
      </span>
    </div>
  );
}
