// src/components/ContentViewerPanel.tsx
// SOTA CONTENT VIEWER PANEL - Enterprise-Grade Content Display v3.0
// Improvements: Structured NeuronWriter tab, enhanced internal links, beautiful design

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Copy, Check, Download, ExternalLink, Sparkles,
  FileText, Code, Search, BarChart3, Link2, Shield,
  ChevronLeft, ChevronRight, Maximize2, Minimize2,
  BookOpen, Clock, Target, Zap, Award, Eye, EyeOff,
  TrendingUp, CheckCircle, AlertTriangle, Brain, Globe,
  Hash, List, Type, ArrowRight, Upload, Loader2,
  Edit3, Save, RotateCcw, Bold, Italic, Heading1, Heading2, Heading3,
  ListOrdered, Quote, Table, Image as ImageIcon, Undo, Redo,
  ChevronDown, ChevronUp, Filter, Tag, Layers, Layout
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ContentItem, GeneratedContentStore } from '@/lib/store';
import type { GeneratedContent } from '@/lib/sota';

type FactCheckV2 = NonNullable<GeneratedContentStore[string]['factCheckV2']>;
type FactCheckClaim = FactCheckV2['claims'][number];
import type { NeuronWriterAnalysis, NeuronWriterTermData, NeuronWriterHeadingData } from '@/lib/sota/NeuronWriterService';
import { scoreContentAgainstNeuron } from '@/lib/sota/NeuronWriterService';
import { useWordPressPublish } from '@/hooks/useWordPressPublish';
import { getPathnameFromUrl, getWordPressPostSlugFromUrl, toSafeWpSlug } from '@/lib/wordpress/slug';
import { toast } from 'sonner';

// ═══════════════════════════════════════════════════════════════════
// SANITIZE & FORMAT HELPERS
// ═══════════════════════════════════════════════════════════════════

function sanitizeHtml(html: string): string {
  let sanitized = html;
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  sanitized = sanitized.replace(/<iframe\b[^>]*>/gi, (match) => {
    if (/src\s*=\s*["'][^"']*(?:youtube\.com\/embed|youtube-nocookie\.com\/embed|player\.vimeo\.com)/i.test(match)) {
      return match;
    }
    return '';
  });
  sanitized = sanitized.replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '');
  sanitized = sanitized.replace(/<embed\b[^>]*>/gi, '');
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  sanitized = sanitized.replace(/href\s*=\s*["']?\s*javascript\s*:/gi, 'href="');
  sanitized = sanitized.replace(/src\s*=\s*["']?\s*javascript\s*:/gi, 'src="');
  return sanitized;
}

function formatHtml(html: string): string {
  return html
    .replace(/></g, '>\n<')
    .replace(/(<\/(?:div|p|h[1-6]|ul|ol|li|table|tr|thead|tbody|blockquote|figure|section|article)>)/gi, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface EditorAutoSavePayload {
  content: string;
  sourceHash: string;
  savedAt: number;
}

function getContentHash(input: string): string {
  const str = input || '';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return `${str.length}:${hash >>> 0}`;
}

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

interface ContentViewerPanelProps {
  item: ContentItem | null;
  generatedContent?: GeneratedContent | null;
  neuronData?: NeuronWriterAnalysis | null;
  factCheckV2?: FactCheckV2 | null;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onSaveContent?: (itemId: string, newContent: string) => void;
}

type ViewTab = 'preview' | 'editor' | 'html' | 'seo' | 'links' | 'schema' | 'neuron';

// ─── Fact-check inline highlighter ──────────────────────────────────
function annotateClaimsInHtml(html: string, claims: FactCheckClaim[]): string {
  if (!html || !claims?.length) return html;
  let out = html;
  // Process longer claims first so shorter substrings don't pre-empt them.
  const sorted = [...claims].sort((a, b) => b.claim.text.length - a.claim.text.length);
  for (const c of sorted) {
    if (c.status === 'skipped') continue;
    const raw = (c.claim.text || '').trim();
    if (raw.length < 20) continue;
    if (/[<>]/.test(raw)) continue;
    // Use the first ~140 chars as the search needle; collapse whitespace.
    const needle = raw.slice(0, 140).replace(/\s+/g, ' ');
    const escaped = needle
      .replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    let re: RegExp;
    try { re = new RegExp(`(${escaped})`, 'i'); } catch { continue; }
    if (!re.test(out)) continue;
    const evidenceCount = c.evidence?.length || 0;
    const tipParts = [c.status.toUpperCase()];
    if (c.reason) tipParts.push(c.reason);
    if (evidenceCount) tipParts.push(`${evidenceCount} source${evidenceCount > 1 ? 's' : ''}`);
    const title = tipParts.join(' — ').replace(/"/g, '&quot;');
    out = out.replace(
      re,
      `<mark class="fc-claim fc-${c.status}" data-claim-id="${c.claim.id}" data-status="${c.status}" title="${title}">$1</mark>`,
    );
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════

export function ContentViewerPanel({
  item,
  generatedContent,
  neuronData,
  factCheckV2,
  onClose,
  onPrevious,
  onNext,
  hasPrevious,
  hasNext,
  onSaveContent
}: ContentViewerPanelProps) {
  const [activeTab, setActiveTab] = useState<ViewTab>('preview');
  const [copied, setCopied] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(true);
  const [showRawHtml, setShowRawHtml] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishStatus, setPublishStatus] = useState<'draft' | 'publish'>('draft');
  const [showFactCheck, setShowFactCheck] = useState(true);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { publish, isPublishing, publishResult, clearResult, isConfigured } = useWordPressPublish();

  // ─── Editor State (MUST be declared before any usage or early return) ────
  const [editedContent, setEditedContent] = useState<string>('');
  const [isEditorDirty, setIsEditorDirty] = useState(false);
  const [editorHistory, setEditorHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const content = item?.content || generatedContent?.content || '';
  const hasContent = content.length > 0;
  const wordCount = item?.wordCount || generatedContent?.metrics?.wordCount || content.split(/\s+/).filter(Boolean).length;

  const sourcePathname = useMemo(() => getPathnameFromUrl(item.url), [item.url]);
  const sourceSlug = useMemo(() => getWordPressPostSlugFromUrl(item.url), [item.url]);

  const effectivePublishSlug = useMemo(() => {
    if (sourceSlug) return sourceSlug;
    if (generatedContent?.slug) return toSafeWpSlug(generatedContent.slug);
    const title = item.title.replace(/^\s*rewrite\s*:\s*/i, '').trim();
    return toSafeWpSlug(title);
  }, [generatedContent?.slug, item.title, sourceSlug]);

  const headings = useMemo(() => {
    const h2Matches = content.match(/<h2[^>]*>(.*?)<\/h2>/gi) || [];
    const h3Matches = content.match(/<h3[^>]*>(.*?)<\/h3>/gi) || [];
    return {
      h2: h2Matches.map(h => h.replace(/<[^>]*>/g, '')),
      h3: h3Matches.map(h => h.replace(/<[^>]*>/g, ''))
    };
  }, [content]);

  const contentLinks = useMemo(() => {
    const linkMatches = content.match(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi) || [];
    return linkMatches.map(link => {
      const hrefMatch = link.match(/href="([^"]*)"/);
      const textMatch = link.match(/>(.*?)<\/a>/);
      return {
        url: hrefMatch?.[1] || '',
        text: textMatch?.[1]?.replace(/<[^>]*>/g, '') || ''
      };
    });
  }, [content]);

  // ─── Effective display content (edited or original) ────────────────
  const displayContent = isEditorDirty ? editedContent : content;

  // Fact-check overlay: counts + annotated HTML for the preview pane.
  const factCheckCounts = useMemo(() => {
    if (!factCheckV2) return null;
    const s = factCheckV2.summary;
    return { ...s, hasFlags: s.flagged > 0 };
  }, [factCheckV2]);

  const annotatedPreview = useMemo(() => {
    const sanitized = sanitizeHtml(displayContent);
    if (!showFactCheck || !factCheckV2?.claims?.length) return sanitized;
    return annotateClaimsInHtml(sanitized, factCheckV2.claims);
  }, [displayContent, showFactCheck, factCheckV2]);

  // Derive effective NeuronWriter data — fallback to generatedContent.neuronWriterAnalysis if prop is null
  const effectiveNeuronData = useMemo(() => {
    if (neuronData) return neuronData;
    if (generatedContent?.neuronWriterAnalysis) return generatedContent.neuronWriterAnalysis;
    return null;
  }, [neuronData, generatedContent]);

  // NeuronWriter live scoring
  // ✅ FIX: Map scoreContentAgainstNeuron output to the shape the UI expects.
  // The scorer returns { missingBasicTerms, missingEntities, matchedTerms, totalTerms }
  // but NeuronWriterTab expects { missing, underused, optimal }.
  const neuronLiveScore = useMemo(() => {
    if (!effectiveNeuronData) return null;

    // Build combined term list from all possible field names
    const allTerms = [
      ...(effectiveNeuronData.basicKeywords || effectiveNeuronData.terms || []),
      ...(effectiveNeuronData.extendedKeywords || effectiveNeuronData.termsExtended || []),
    ];

    // If no terms at all, still show the panel with score=0 rather than infinite spinner
    const rawScore = scoreContentAgainstNeuron(displayContent || content, allTerms);
    // FIX: `!raw` was true for score=0, hiding the panel forever. Use explicit numeric check.
    const score = typeof rawScore === 'number' ? rawScore : 0;

    const contentLower = (displayContent || content).replace(/<[^>]*>/g, ' ').toLowerCase();

    const missing: string[] = [];
    const underused: string[] = [];
    const optimal: string[] = [];

    for (const t of allTerms) {
      const termStr = t.term || (t as any).name || '';
      const term = termStr.toLowerCase().trim();
      if (!term) continue;
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'gi');
      const count = (contentLower.match(regex) || []).length;
      const recommended = t.recommended || t.frequency || 1;

      if (count === 0) missing.push(t.term || '');
      else if (count < recommended) underused.push(t.term || '');
      else optimal.push(t.term || '');
    }

    // Add entity coverage to missing list
    for (const e of (effectiveNeuronData.entities || [])) {
      const entity = (e.entity || '').toLowerCase().trim();
      if (entity && !contentLower.includes(entity)) {
        missing.push(e.entity);
      }
    }

    return { score, missing, underused, optimal };
  }, [displayContent, content, effectiveNeuronData]);


  const handleCopy = async () => {
    await navigator.clipboard.writeText(editedContent || content);

    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([editedContent || content], { type: 'text/html' });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.title.toLowerCase().replace(/\s+/g, '-')}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ─── Editor State (hooks declared above, near line 100) ────────────

  useEffect(() => {
    if (!item?.id) return;
    const autoSaveKey = `sota-editor-autosave-${item.id}`;
    const autoSavedRaw = localStorage.getItem(autoSaveKey);
    const sourceHash = getContentHash(content);

    let restoredDraft: string | null = null;

    if (autoSavedRaw) {
      try {
        const parsed = JSON.parse(autoSavedRaw) as Partial<EditorAutoSavePayload>;
        if (
          typeof parsed?.content === 'string' &&
          parsed.sourceHash === sourceHash &&
          parsed.content !== content
        ) {
          restoredDraft = parsed.content;
        }
      } catch {
        // Legacy format (raw string). Avoid restoring stale drafts across regenerations.
        if (autoSavedRaw === content) {
          restoredDraft = autoSavedRaw;
        } else {
          localStorage.removeItem(autoSaveKey);
        }
      }
    }

    const initialContent = restoredDraft ?? content;
    setEditedContent(initialContent);
    setEditorHistory([initialContent]);
    setHistoryIndex(0);
    setIsEditorDirty(initialContent !== content);

    if (restoredDraft) {
      toast.info('Restored unsaved changes from auto-save');
    }
  }, [content, item?.id]);

  useEffect(() => {
    if (!item?.id || !isEditorDirty) return;
    const key = `sota-editor-autosave-${item.id}`;
    const timeout = setTimeout(() => {
      const payload: EditorAutoSavePayload = {
        content: editedContent,
        sourceHash: getContentHash(content),
        savedAt: Date.now(),
      };
      localStorage.setItem(key, JSON.stringify(payload));
    }, 1500);
    return () => clearTimeout(timeout);
  }, [content, editedContent, isEditorDirty, item?.id]);

  const handleEditorChange = useCallback((newContent: string) => {
    setEditedContent(newContent);
    setIsEditorDirty(newContent !== content);
    setEditorHistory(prev => {
      const newHistory = [...prev.slice(0, historyIndex + 1), newContent].slice(-50);
      setHistoryIndex(newHistory.length - 1);
      return newHistory;
    });
  }, [content, historyIndex]);

  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setEditedContent(editorHistory[newIndex]);
      setIsEditorDirty(editorHistory[newIndex] !== content);
    }
  }, [historyIndex, editorHistory, content]);

  const handleRedo = useCallback(() => {
    if (historyIndex < editorHistory.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setEditedContent(editorHistory[newIndex]);
      setIsEditorDirty(editorHistory[newIndex] !== content);
    }
  }, [historyIndex, editorHistory, content]);

  const handleResetEditor = useCallback(() => {
    setEditedContent(content);
    setIsEditorDirty(false);
    setEditorHistory([content]);
    setHistoryIndex(0);
    if (item?.id) localStorage.removeItem(`sota-editor-autosave-${item.id}`);
    toast.info('Editor reset to original content');
  }, [content, item?.id]);

  const handleSaveContent = useCallback(() => {
    if (!item || !onSaveContent || !isEditorDirty) return;
    onSaveContent(item.id, editedContent);
    setIsEditorDirty(false);
    if (item.id) localStorage.removeItem(`sota-editor-autosave-${item.id}`);
    toast.success('Content saved successfully!');
  }, [item, onSaveContent, isEditorDirty, editedContent]);

  const insertHtmlTag = useCallback((tag: string, attributes: string = '') => {
    const textarea = textareaRef.current;
    const start = textarea ? textarea.selectionStart : editedContent.length;
    const end = textarea ? textarea.selectionEnd : editedContent.length;
    const selectedText = start !== end ? editedContent.substring(start, end) : 'Your text here';

    let insertion = '';
    if (['h2', 'h3', 'p', 'strong', 'em', 'blockquote'].includes(tag)) {
      insertion = `<${tag}${attributes}>${selectedText}</${tag}>`;
    } else if (tag === 'ul' || tag === 'ol') {
      insertion = `<${tag}>\n  <li>${selectedText}</li>\n</${tag}>`;
    } else if (tag === 'table') {
      insertion = `<table style="width: 100%; border-collapse: collapse;">\n  <thead>\n    <tr>\n      <th style="padding: 12px; border: 1px solid #374151; background: #1f2937;">Header 1</th>\n      <th style="padding: 12px; border: 1px solid #374151; background: #1f2937;">Header 2</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td style="padding: 12px; border: 1px solid #374151;">Data 1</td>\n      <td style="padding: 12px; border: 1px solid #374151;">Data 2</td>\n    </tr>\n  </tbody>\n</table>`;
    } else if (tag === 'img') {
      insertion = `<img src="https://placehold.co/800x400" alt="${selectedText}" style="max-width: 100%; border-radius: 12px;" />`;
    }

    const newContent = editedContent.substring(0, start) + insertion + editedContent.substring(end);
    handleEditorChange(newContent);

    requestAnimationFrame(() => {
      if (textarea) {
        const newPos = start + insertion.length;
        textarea.selectionStart = newPos;
        textarea.selectionEnd = newPos;
        textarea.focus();
      }
    });
  }, [editedContent, handleEditorChange]);

  // ─── Publish Handler ───────────────────────────────────────────────

  const handlePublishToWordPress = async () => {
    if (!item) return;

    // Use canonical content by default; use draft only when it diverges.
    const canonicalContent = generatedContent?.content || content;
    const publishContent = (isEditorDirty || editedContent !== canonicalContent)
      ? editedContent
      : canonicalContent;

    if (!publishContent) return;

    const cleanTitle = item.title.replace(/^\s*rewrite\s*:\s*/i, '').trim();
    const effectiveSeoTitle = generatedContent?.seoTitle || cleanTitle;
    const wpTitle = generatedContent?.seoTitle || generatedContent?.title || cleanTitle;

    const result = await publish(wpTitle, publishContent, {
      status: publishStatus,
      slug: effectivePublishSlug,
      metaDescription: generatedContent?.metaDescription,
      excerpt: generatedContent?.metaDescription,
      seoTitle: effectiveSeoTitle,
      sourceUrl: item.url,
    });

    if (result.success) {
      toast.success(`Published to WordPress as ${publishStatus}!`, {
        description: result.postUrl ? `Post ID: ${result.postId}` : undefined,
        action: result.postUrl ? {
          label: 'View Post',
          onClick: () => window.open(result.postUrl, '_blank'),
        } : undefined,
      });
      setShowPublishModal(false);
      if (item.id) localStorage.removeItem(`sota-editor-autosave-${item.id}`);
    } else {
      toast.error('Failed to publish', { description: result.error });
    }
  };

  // ─── Tab Configuration ─────────────────────────────────────────────

  const neuronTermCount = effectiveNeuronData
    ? (effectiveNeuronData.basicKeywords?.length || effectiveNeuronData.terms?.length || 0) +
    (effectiveNeuronData.extendedKeywords?.length || effectiveNeuronData.termsExtended?.length || 0) +
    (effectiveNeuronData.entities?.length || 0)
    : 0;

  const tabs: { id: ViewTab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'preview', label: 'Preview', icon: <Eye className="w-4 h-4" /> },
    { id: 'editor', label: 'Editor', icon: <Edit3 className="w-4 h-4" />, badge: isEditorDirty ? 1 : undefined },
    { id: 'html', label: 'HTML', icon: <Code className="w-4 h-4" /> },
    { id: 'seo', label: 'SEO Analysis', icon: <Search className="w-4 h-4" /> },
    { id: 'links', label: 'Internal Links', icon: <Link2 className="w-4 h-4" />, badge: generatedContent?.internalLinks?.length || contentLinks.length },
    { id: 'schema', label: 'Schema', icon: <Shield className="w-4 h-4" /> },
    { id: 'neuron', label: 'NeuronWriter', icon: <Brain className="w-4 h-4" />, badge: neuronTermCount || undefined },
  ];

  // ─── Early return AFTER all hooks ─────────────────────────────────
  if (!item) return null;

  return createPortal(
    <div className={cn(
      "fixed bg-black/90 backdrop-blur-xl z-[60] flex flex-col transition-all duration-300",
      isFullscreen ? "inset-0" : "inset-4 rounded-3xl border border-white/10 shadow-2xl"
    )}>
      {/* ═══════════════ HEADER ═══════════════ */}
      <div className="flex items-center justify-between p-5 border-b border-white/10 bg-white/5 backdrop-blur-md z-10">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <button onClick={onPrevious} disabled={!hasPrevious} className="p-2.5 rounded-xl bg-black/20 text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all border border-white/5">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button onClick={onNext} disabled={!hasNext} className="p-2.5 rounded-xl bg-black/20 text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all border border-white/5">
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <span className={cn(
                "px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider border shadow-sm",
                item.type === 'pillar' && "bg-purple-500/10 text-purple-400 border-purple-500/20",
                item.type === 'cluster' && "bg-blue-500/10 text-blue-400 border-blue-500/20",
                item.type === 'single' && "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
                item.type === 'refresh' && "bg-amber-500/10 text-amber-400 border-amber-500/20"
              )}>{item.type}</span>
              <h2 className="text-xl font-bold text-white truncate max-w-[600px]">{item.title}</h2>
            </div>
            <div className="flex items-center gap-6 text-xs text-zinc-400 mt-2 font-medium">
              <span className="flex items-center gap-1.5"><div className="p-1 bg-white/5 rounded"><FileText className="w-3 h-3" /></div>{wordCount.toLocaleString()} words</span>
              <span className="flex items-center gap-1.5"><div className="p-1 bg-white/5 rounded"><Clock className="w-3 h-3" /></div>~{Math.ceil(wordCount / 200)} min read</span>
              <span className="flex items-center gap-1.5"><div className="p-1 bg-white/5 rounded"><Target className="w-3 h-3" /></div>{item.primaryKeyword}</span>
              {generatedContent && (
                <span className="flex items-center gap-1.5 px-2 py-0.5 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
                  <Award className="w-3 h-3 text-emerald-400" />
                  <span className="text-emerald-400 font-bold">{generatedContent.qualityScore.overall}% Quality</span>
                </span>
              )}
              {neuronLiveScore && (
                <span className="flex items-center gap-1.5 px-2 py-0.5 bg-purple-500/10 rounded-lg border border-purple-500/20">
                  <Brain className="w-3 h-3 text-purple-400" />
                  <span className={cn("font-bold", neuronLiveScore.score >= 90 ? "text-emerald-400" : neuronLiveScore.score >= 70 ? "text-yellow-400" : "text-red-400")}>
                    {neuronLiveScore.score}% NW
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-black/20 p-1 rounded-xl border border-white/5">
            <button onClick={handleCopy} disabled={!hasContent} className="flex items-center gap-2 px-4 py-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-all disabled:opacity-30">
              {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              <span className="hidden xl:inline text-sm font-medium">{copied ? 'Copied!' : 'Copy'}</span>
            </button>
            <div className="w-px bg-white/5 my-2" />
            <button onClick={handleDownload} disabled={!hasContent} className="flex items-center gap-2 px-4 py-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-all disabled:opacity-30">
              <Download className="w-4 h-4" /><span className="hidden xl:inline text-sm font-medium">Download</span>
            </button>
          </div>

          <button onClick={() => setShowPublishModal(true)} disabled={!hasContent} className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-primary to-emerald-500 text-white shadow-lg shadow-primary/20 rounded-xl text-sm font-bold hover:brightness-110 transition-all disabled:opacity-30 transform hover:-translate-y-0.5">
            <Upload className="w-4 h-4" />Publish to WP
          </button>

          <div className="flex bg-black/20 p-1 rounded-xl border border-white/5 ml-2">
            <button onClick={() => setIsFullscreen(!isFullscreen)} className="p-2.5 text-zinc-400 hover:text-white rounded-lg hover:bg-white/10 transition-all">
              {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
            <div className="w-px bg-white/5 my-2" />
            <button onClick={onClose} className="p-2.5 text-zinc-400 hover:text-red-400 rounded-lg hover:bg-red-500/10 transition-all">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* ═══════════════ TABS ═══════════════ */}
      <div className="flex border-b border-white/10 bg-black/20 overflow-x-auto">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={cn(
            "flex items-center gap-2.5 px-6 py-4 text-sm font-bold transition-all relative whitespace-nowrap group",
            activeTab === tab.id ? "text-primary" : "text-zinc-500 hover:text-zinc-300"
          )}>
            <div className={cn(
              "p-1 rounded-md transition-colors",
              activeTab === tab.id ? "bg-primary/20 text-primary" : "bg-transparent group-hover:bg-white/5"
            )}>
              {tab.icon}
            </div>
            {tab.label}
            {tab.badge !== undefined && tab.badge > 0 && (
              <span className={cn(
                "ml-1 px-1.5 py-0.5 text-[10px] rounded-full font-bold",
                activeTab === tab.id ? "bg-primary text-white" : "bg-zinc-800 text-zinc-400"
              )}>{tab.badge}</span>
            )}
            {activeTab === tab.id && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-primary/0 via-primary to-primary/0" />
            )}
          </button>
        ))}
      </div>

      {/* ═══════════════ CONTENT AREA ═══════════════ */}
      <div className="flex-1 overflow-auto bg-black/10 custom-scrollbar">
        {!hasContent ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center mb-6 border border-white/10 shadow-2xl relative">
              <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl -z-10" />
              <FileText className="w-10 h-10 text-zinc-500" />
            </div>
            <h3 className="text-2xl font-bold text-white mb-2">Content Not Yet Generated</h3>
            <p className="text-zinc-400 max-w-md mb-8">Select this item and click "Generate Selected" to initiate our SOTA content engine.</p>
            <div className="flex items-center gap-3 px-5 py-2.5 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-yellow-400 text-sm font-medium">
              <Clock className="w-4 h-4" />Status: <span className="uppercase tracking-wider font-bold">{item.status}</span>
            </div>
          </div>
        ) : (
          <>
            {/* ────── PREVIEW TAB ────── */}
            {activeTab === 'preview' && (
              <div className="p-8">
                <div className="flex flex-col items-center gap-3 mb-8">
                  <div className="inline-flex items-center gap-3 px-4 py-2 bg-white/5 rounded-full border border-white/5 backdrop-blur-sm">
                    <Globe className="w-4 h-4 text-zinc-400" />
                    <span className="text-sm font-medium text-zinc-300">WordPress Preview Mode</span>
                    {isEditorDirty && (
                      <span className="flex items-center gap-1.5 px-2 py-0.5 bg-yellow-500/10 text-yellow-400 text-[10px] font-bold uppercase tracking-wider rounded-lg border border-yellow-500/20 ml-2">
                        <Edit3 className="w-3 h-3" /> Modified
                      </span>
                    )}
                    {factCheckCounts && (
                      <button
                        type="button"
                        onClick={() => setShowFactCheck(v => !v)}
                        title={showFactCheck ? 'Hide fact-check highlights' : 'Show fact-check highlights'}
                        className={cn(
                          "flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-lg border transition-colors ml-2",
                          showFactCheck
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20"
                            : "bg-white/5 text-zinc-400 border-white/10 hover:bg-white/10"
                        )}
                      >
                        <Shield className="w-3 h-3" />
                        Fact-check {showFactCheck ? 'On' : 'Off'}
                        {factCheckCounts.hasFlags && (
                          <span className="px-1.5 py-px rounded-full bg-red-500/20 text-red-300 ml-1">{factCheckCounts.flagged} flagged</span>
                        )}
                      </button>
                    )}
                  </div>
                  {factCheckCounts && showFactCheck && (
                    <div className="inline-flex items-center gap-3 px-3 py-1.5 rounded-full bg-black/20 border border-white/5 text-[11px] text-zinc-400">
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/60 border-b-2 border-emerald-500" /> Verified ({factCheckCounts.verified})</span>
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-red-500/60 border-b-2 border-red-500" /> Unverified ({factCheckCounts.unverified + factCheckCounts.insufficient})</span>
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-amber-500/60 border-b-2 border-amber-500" /> Stale ({factCheckCounts.stale})</span>
                      <span className="text-zinc-500">Hover a highlight for sources</span>
                    </div>
                  )}
                </div>


                <div className="bg-white rounded-2xl shadow-2xl overflow-hidden max-w-5xl mx-auto ring-8 ring-black/20">
                  <div className="bg-gray-100 px-4 py-3 text-sm text-gray-500 border-b flex items-center gap-4">
                    <div className="flex gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-red-400 border border-red-500/20" />
                      <div className="w-3 h-3 rounded-full bg-amber-400 border border-amber-500/20" />
                      <div className="w-3 h-3 rounded-full bg-green-400 border border-green-500/20" />
                    </div>
                    <div className="flex-1 bg-white border border-gray-200 rounded-md px-3 py-1 text-center font-mono text-xs text-gray-400 shadow-sm">
                      {item.url || `yoursite.com/${effectivePublishSlug}`}
                    </div>
                    <div className="w-12" />
                  </div>
                  <style dangerouslySetInnerHTML={{
                    __html: `
                    /* ═══ BASE CONTAINER ═══ */
                    .wp-preview-content {
                      max-width: 960px;
                      margin: 0 auto;
                      scroll-behavior: smooth;
                    }

                    /* ═══ TYPOGRAPHY — HEADINGS ═══ */
                    .wp-preview-content h1 {
                      font-size: clamp(28px, 4vw, 36px);
                      font-weight: 900;
                      color: #0f172a;
                      margin: 40px 0 20px;
                      line-height: 1.2;
                      letter-spacing: -0.03em;
                    }
                    .wp-preview-content h2 {
                      font-size: clamp(24px, 3.5vw, 32px);
                      font-weight: 900;
                      color: #0f172a;
                      margin: 56px 0 24px;
                      padding-bottom: 16px;
                      border-bottom: 3px solid;
                      border-image: linear-gradient(135deg, #10b981, #059669, #047857) 1;
                      letter-spacing: -0.03em;
                      line-height: 1.2;
                    }
                    .wp-preview-content h3 {
                      font-size: clamp(20px, 2.5vw, 24px);
                      font-weight: 800;
                      color: #1e293b;
                      margin: 44px 0 18px;
                      padding-left: 20px;
                      border-left: 4px solid #10b981;
                      letter-spacing: -0.02em;
                      line-height: 1.3;
                    }
                    .wp-preview-content h4 {
                      font-size: clamp(17px, 2vw, 20px);
                      font-weight: 700;
                      color: #334155;
                      margin: 36px 0 14px;
                      line-height: 1.35;
                    }

                    /* ═══ TYPOGRAPHY — BODY ═══ */
                    .wp-preview-content p {
                      margin: 0 0 22px;
                      color: #334155;
                      line-height: 1.85;
                      font-size: clamp(16px, 1.8vw, 18px);
                      letter-spacing: 0.01em;
                    }
                    .wp-preview-content strong, .wp-preview-content b {
                      color: #0f172a;
                      font-weight: 700;
                    }
                    .wp-preview-content em, .wp-preview-content i {
                      color: #475569;
                      font-style: italic;
                    }

                    /* ═══ LINKS ═══ */
                    .wp-preview-content a {
                      color: #059669;
                      text-decoration: underline;
                      text-decoration-color: rgba(5, 150, 105, 0.3);
                      text-underline-offset: 3px;
                      font-weight: 600;
                      transition: all 0.2s ease;
                    }
                    .wp-preview-content a:hover {
                      color: #047857;
                      text-decoration-color: #059669;
                      background: rgba(16, 185, 129, 0.06);
                      border-radius: 2px;
                      padding: 0 2px;
                      margin: 0 -2px;
                    }

                    /* ═══ LISTS ═══ */
                    .wp-preview-content ul {
                      margin: 16px 0 28px;
                      padding-left: 0;
                      color: #374151;
                      list-style: none;
                    }
                    .wp-preview-content ol {
                      margin: 16px 0 28px;
                      padding-left: 0;
                      color: #374151;
                      list-style: none;
                      counter-reset: custom-counter;
                    }
                    .wp-preview-content ul > li {
                      position: relative;
                      margin-bottom: 12px;
                      line-height: 1.85;
                      font-size: clamp(15px, 1.6vw, 17px);
                      padding-left: 28px;
                    }
                    .wp-preview-content ul > li::before {
                      content: '';
                      position: absolute;
                      left: 6px;
                      top: 10px;
                      width: 8px;
                      height: 8px;
                      background: linear-gradient(135deg, #10b981, #059669);
                      border-radius: 50%;
                    }
                    .wp-preview-content ol > li {
                      position: relative;
                      margin-bottom: 12px;
                      line-height: 1.85;
                      font-size: clamp(15px, 1.6vw, 17px);
                      padding-left: 36px;
                      counter-increment: custom-counter;
                    }
                    .wp-preview-content ol > li::before {
                      content: counter(custom-counter);
                      position: absolute;
                      left: 0;
                      top: 2px;
                      width: 24px;
                      height: 24px;
                      background: linear-gradient(135deg, #10b981, #059669);
                      color: white;
                      border-radius: 50%;
                      display: flex;
                      align-items: center;
                      justify-content: center;
                      font-weight: 800;
                      font-size: 12px;
                    }
                    /* Nested lists */
                    .wp-preview-content ul ul, .wp-preview-content ol ol,
                    .wp-preview-content ul ol, .wp-preview-content ol ul {
                      margin: 8px 0 12px;
                      padding-left: 16px;
                    }

                    /* ═══ BLOCKQUOTE ═══ */
                    .wp-preview-content blockquote {
                      border-left: 5px solid #8b5cf6;
                      margin: 32px 0;
                      padding: 24px 28px;
                      background: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%);
                      border-radius: 0 16px 16px 0;
                      font-style: italic;
                      color: #4c1d95;
                      line-height: 1.85;
                      font-size: clamp(15px, 1.6vw, 17px);
                      box-shadow: 0 4px 16px rgba(139, 92, 246, 0.08);
                    }
                    .wp-preview-content blockquote p {
                      color: inherit;
                      margin-bottom: 8px;
                    }
                    .wp-preview-content blockquote p:last-child {
                      margin-bottom: 0;
                    }

                    /* ═══ IMAGES & FIGURES ═══ */
                    .wp-preview-content img {
                      max-width: 100%;
                      width: 100%;
                      height: auto;
                      border-radius: 16px;
                      margin: 28px 0;
                      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
                    }
                    .wp-preview-content figure {
                      margin: 32px 0;
                      width: 100%;
                    }
                    .wp-preview-content figcaption {
                      text-align: center;
                      color: #6b7280;
                      font-size: 14px;
                      margin-top: 8px;
                      font-style: italic;
                    }

                    /* ═══ TABLES ═══ */
                    .wp-preview-content table {
                      width: 100%;
                      border-collapse: collapse;
                      margin: 32px 0;
                      font-size: clamp(13px, 1.4vw, 15px);
                      border-radius: 16px;
                      overflow: hidden;
                      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04);
                    }
                    .wp-preview-content th {
                      background: linear-gradient(135deg, #0f172a, #1e293b);
                      color: #f8fafc;
                      padding: 16px 20px;
                      text-align: left;
                      font-weight: 700;
                      letter-spacing: 0.02em;
                      white-space: nowrap;
                    }
                    .wp-preview-content td {
                      padding: 14px 20px;
                      border-top: 1px solid #e2e8f0;
                      color: #374151;
                      line-height: 1.6;
                    }
                    .wp-preview-content tr:nth-child(even) {
                      background: #f8fafc;
                    }
                    .wp-preview-content tr:hover td {
                      background: #f1f5f9;
                      transition: background 0.15s ease;
                    }

                    /* ═══ CODE ═══ */
                    .wp-preview-content code {
                      background: #f1f5f9;
                      color: #be123c;
                      padding: 2px 8px;
                      border-radius: 6px;
                      font-size: 0.88em;
                      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
                      border: 1px solid #e2e8f0;
                    }
                    .wp-preview-content pre {
                      background: #0f172a;
                      color: #e2e8f0;
                      padding: 24px;
                      border-radius: 16px;
                      margin: 32px 0;
                      overflow-x: auto;
                      font-size: 14px;
                      line-height: 1.7;
                      border: 1px solid #1e293b;
                      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
                    }
                    .wp-preview-content pre code {
                      background: transparent;
                      color: inherit;
                      padding: 0;
                      border: none;
                      border-radius: 0;
                      font-size: inherit;
                    }

                    /* ═══ HORIZONTAL RULE ═══ */
                    .wp-preview-content hr {
                      border: none;
                      height: 3px;
                      background: linear-gradient(90deg, transparent, #e2e8f0 20%, #cbd5e1 50%, #e2e8f0 80%, transparent);
                      margin: 48px 0;
                      border-radius: 2px;
                    }

                    /* ═══ STYLED CALLOUT BOXES — unified width ═══ */
                    .wp-preview-content div[style] {
                      max-width: 100%;
                      box-sizing: border-box;
                      overflow-wrap: break-word;
                      word-wrap: break-word;
                    }

                    /* ═══ IFRAME / VIDEO EMBEDS ═══ */
                    .wp-preview-content iframe {
                      max-width: 100%;
                      border-radius: 12px;
                    }

                    /* ═══ SELECTION ═══ */
                    .wp-preview-content ::selection {
                      background: rgba(16, 185, 129, 0.2);
                      color: #0f172a;
                    }

                    /* First paragraph special treatment — slightly larger lead paragraph */
                    .wp-preview-content > p:first-child {
                      font-size: clamp(17px, 2vw, 19px);
                      color: #1e293b;
                      line-height: 1.9;
                    }

                    /* ═══ FACT-CHECK INLINE HIGHLIGHTS ═══ */
                    .wp-preview-content mark.fc-claim {
                      background: transparent;
                      padding: 1px 2px;
                      border-radius: 3px;
                      cursor: help;
                      transition: background 0.15s ease;
                    }
                    .wp-preview-content mark.fc-verified {
                      background: rgba(16, 185, 129, 0.14);
                      box-shadow: inset 0 -2px 0 0 #10b981;
                    }
                    .wp-preview-content mark.fc-verified:hover { background: rgba(16, 185, 129, 0.24); }
                    .wp-preview-content mark.fc-unverified,
                    .wp-preview-content mark.fc-insufficient {
                      background: rgba(239, 68, 68, 0.14);
                      box-shadow: inset 0 -2px 0 0 #ef4444;
                    }
                    .wp-preview-content mark.fc-unverified:hover,
                    .wp-preview-content mark.fc-insufficient:hover { background: rgba(239, 68, 68, 0.24); }
                    .wp-preview-content mark.fc-stale {
                      background: rgba(245, 158, 11, 0.14);
                      box-shadow: inset 0 -2px 0 0 #f59e0b;
                    }
                    .wp-preview-content mark.fc-stale:hover { background: rgba(245, 158, 11, 0.24); }
                  `}} />
                  <article
                    className="wp-preview-content"
                    style={{ padding: '48px 56px', fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', color: '#1a1a1a', lineHeight: 1.8, fontSize: '17px', backgroundColor: '#ffffff' }}
                    dangerouslySetInnerHTML={{ __html: annotatedPreview }}
                  />

                </div>
              </div>
            )}

            {/* ────── EDITOR TAB ────── */}
            {activeTab === 'editor' && (
              <div className="p-6 h-full flex flex-col max-w-7xl mx-auto">
                <div className="glass-card border border-white/10 rounded-2xl p-4 mb-4 flex flex-col shadow-lg">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2.5">
                      <div className="p-2 bg-primary/20 rounded-lg">
                        <Edit3 className="w-5 h-5 text-primary" />
                      </div>
                      Content Editor
                      {isEditorDirty && (
                        <span className="flex items-center gap-1 px-2.5 py-1 bg-yellow-500/10 text-yellow-400 text-[10px] font-bold uppercase tracking-wider rounded-lg border border-yellow-500/20 shadow-[0_0_10px_rgba(234,179,8,0.2)] animate-pulse-subtle">
                          <Edit3 className="w-3 h-3" /> Unsaved Changes
                        </span>
                      )}
                    </h3>
                    <div className="flex items-center gap-2">
                      <div className="flex bg-black/20 p-1 rounded-xl border border-white/5">
                        <button onClick={handleUndo} disabled={historyIndex <= 0} className="p-2 text-zinc-400 hover:text-white rounded-lg hover:bg-white/10 transition-all disabled:opacity-30 tooltip" title="Undo"><Undo className="w-4 h-4" /></button>
                        <div className="w-px bg-white/5 my-1" />
                        <button onClick={handleRedo} disabled={historyIndex >= editorHistory.length - 1} className="p-2 text-zinc-400 hover:text-white rounded-lg hover:bg-white/10 transition-all disabled:opacity-30 tooltip" title="Redo"><Redo className="w-4 h-4" /></button>
                      </div>

                      <div className="flex bg-black/20 p-1 rounded-xl border border-white/5 ml-2">
                        <button onClick={handleResetEditor} disabled={!isEditorDirty} className="flex items-center gap-2 px-3 py-1.5 text-zinc-400 hover:text-red-400 rounded-lg text-sm font-medium hover:bg-red-500/10 transition-all disabled:opacity-30"><RotateCcw className="w-4 h-4" />Reset</button>
                        <div className="w-px bg-white/5 my-1" />
                        <button onClick={() => { navigator.clipboard.writeText(editedContent); toast.success('Copied!'); }} className="flex items-center gap-2 px-3 py-1.5 text-zinc-400 hover:text-white rounded-lg text-sm font-medium hover:bg-white/10 transition-all"><Copy className="w-4 h-4" />Copy</button>
                      </div>

                      {onSaveContent && (
                        <button onClick={handleSaveContent} disabled={!isEditorDirty} className="ml-2 flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white hover:bg-emerald-500 rounded-xl text-sm font-bold transition-all disabled:opacity-30 shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/30 transform hover:-translate-y-0.5"><Save className="w-4 h-4" />Save Changes</button>
                      )}
                    </div>
                  </div>

                  {/* Toolbar */}
                  <div className="flex items-center gap-2 flex-wrap bg-black/20 p-2 rounded-xl border border-white/5">
                    <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1 border border-white/5">
                      <button onClick={() => insertHtmlTag('h2')} className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-all tooltip" title="H2"><Heading2 className="w-4 h-4" /></button>
                      <button onClick={() => insertHtmlTag('h3')} className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-all tooltip" title="H3"><Heading3 className="w-4 h-4" /></button>
                    </div>

                    <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1 border border-white/5">
                      <button onClick={() => insertHtmlTag('strong')} className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-all tooltip" title="Bold"><Bold className="w-4 h-4" /></button>
                      <button onClick={() => insertHtmlTag('em')} className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-all tooltip" title="Italic"><Italic className="w-4 h-4" /></button>
                    </div>

                    <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1 border border-white/5">
                      <button onClick={() => insertHtmlTag('ul')} className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-all tooltip" title="Bullet List"><List className="w-4 h-4" /></button>
                      <button onClick={() => insertHtmlTag('ol')} className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-all tooltip" title="Numbered List"><ListOrdered className="w-4 h-4" /></button>
                    </div>

                    <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1 border border-white/5">
                      <button onClick={() => insertHtmlTag('blockquote')} className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-all tooltip" title="Quote"><Quote className="w-4 h-4" /></button>
                      <button onClick={() => insertHtmlTag('table')} className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-all tooltip" title="Table"><Table className="w-4 h-4" /></button>
                      <button onClick={() => insertHtmlTag('img')} className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-all tooltip" title="Image"><ImageIcon className="w-4 h-4" /></button>
                    </div>

                    <div className="ml-auto text-xs font-mono text-zinc-500 bg-black/20 px-3 py-1.5 rounded-lg border border-white/5">
                      {editedContent.split(/\s+/).filter(Boolean).length.toLocaleString()} words
                    </div>
                  </div>
                </div>

                <div className="flex-1 grid grid-cols-2 gap-6 min-h-0">
                  {/* Source Editor */}
                  <div className="flex flex-col glass-card border border-white/10 rounded-2xl overflow-hidden shadow-lg group focus-within:ring-2 ring-primary/50 transition-all">
                    <div className="bg-white/5 px-4 py-3 border-b border-white/10 flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">HTML Source</span>
                    </div>
                    <textarea
                      ref={textareaRef}
                      value={editedContent}
                      onChange={(e) => handleEditorChange(e.target.value)}
                      className="flex-1 p-6 bg-black/20 text-blue-200 font-mono text-sm resize-none focus:outline-none placeholder:text-zinc-700 leading-relaxed custom-scrollbar selection:bg-primary/30"
                      placeholder="Paste or type your HTML content here..."
                      spellCheck={false}
                    />
                  </div>

                  {/* Live Preview */}
                  <div className="flex flex-col bg-white rounded-2xl overflow-hidden shadow-lg border border-white/10">
                    <div className="bg-gray-100 px-4 py-3 border-b border-gray-200 flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-xs font-bold uppercase tracking-wider text-gray-500">Live Preview</span>
                    </div>
                    <div className="flex-1 overflow-auto p-8 bg-white custom-scrollbar">
                      <article className="prose prose-sm max-w-none prose-headings:font-bold prose-headings:text-slate-900 prose-p:text-slate-600 prose-p:leading-relaxed prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline prose-img:rounded-xl prose-pre:bg-slate-900 prose-pre:text-slate-50"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(editedContent) }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ────── HTML TAB ────── */}
            {activeTab === 'html' && (
              <div className="p-8 max-w-7xl mx-auto">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-bold text-white flex items-center gap-3">
                    <div className="p-2 bg-blue-500/20 rounded-xl">
                      <Code className="w-5 h-5 text-blue-400" />
                    </div>
                    HTML Source
                  </h3>
                  <div className="flex items-center gap-3">
                    <div className="flex bg-black/20 p-1 rounded-xl border border-white/5">
                      <button onClick={() => setShowRawHtml(!showRawHtml)} className="flex items-center gap-2.5 px-4 py-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-all">
                        {showRawHtml ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        <span className="font-medium text-sm">{showRawHtml ? 'Formatted' : 'Raw'}</span>
                      </button>
                      <div className="w-px bg-white/5 my-2" />
                      <button onClick={handleCopy} className="flex items-center gap-2.5 px-4 py-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-all text-sm font-medium">
                        {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                        {copied ? 'Copied!' : 'Copy All'}
                      </button>
                    </div>
                  </div>
                </div>
                <div className="glass-card border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
                  <div className="bg-white/5 px-6 py-3 border-b border-white/10 flex items-center gap-3">
                    <div className="flex gap-2">
                      <div className="w-3 h-3 rounded-full bg-red-500/50 border border-red-500/10" />
                      <div className="w-3 h-3 rounded-full bg-amber-500/50 border border-amber-500/10" />
                      <div className="w-3 h-3 rounded-full bg-green-500/50 border border-green-500/10" />
                    </div>
                    <span className="ml-2 text-xs text-zinc-500 font-mono bg-black/20 px-3 py-1 rounded-full border border-white/5">content.html</span>
                  </div>
                  <pre className="p-6 overflow-auto text-sm text-blue-200/90 font-mono max-h-[65vh] leading-relaxed whitespace-pre-wrap custom-scrollbar bg-black/20 shadow-inner">
                    {showRawHtml ? content : formatHtml(content)}
                  </pre>
                </div>
              </div>
            )}

            {/* ────── SEO ANALYSIS TAB ────── */}
            {activeTab === 'seo' && (
              <div className="p-8 space-y-8 max-w-7xl mx-auto">
                {generatedContent && (
                  <div className="glass-card border border-white/10 rounded-3xl p-8 relative overflow-hidden group hover:border-white/20 transition-all shadow-xl">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl -z-10 -translate-y-1/2 translate-x-1/3" />
                    <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-3">
                      <div className="p-2 bg-primary/20 rounded-xl">
                        <BarChart3 className="w-5 h-5 text-primary" />
                      </div>
                      Quality Score Breakdown
                    </h3>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                      <QualityMetric label="Overall Score" value={generatedContent.qualityScore.overall} large />
                      <QualityMetric label="Readability" value={generatedContent.qualityScore.readability} />
                      <QualityMetric label="SEO Optimization" value={generatedContent.qualityScore.seo} />
                      <QualityMetric label="E-E-A-T" value={generatedContent.qualityScore.eeat} />
                      <QualityMetric label="Uniqueness" value={generatedContent.qualityScore.uniqueness} />
                      <QualityMetric label="Fact Accuracy" value={generatedContent.qualityScore.factAccuracy} />
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  <div className="glass-card border border-white/10 rounded-3xl p-8 relative overflow-hidden shadow-xl">
                    <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-3">
                      <div className="p-2 bg-purple-500/20 rounded-xl">
                        <Target className="w-5 h-5 text-purple-400" />
                      </div>
                      Keyword Strategy
                    </h3>
                    <div className="space-y-6">
                      <div className="p-5 bg-white/5 rounded-2xl border border-white/5">
                        <span className="text-zinc-500 text-xs uppercase tracking-wider font-bold block mb-3">Primary Keyword</span>
                        <span className="inline-block px-4 py-2 bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-xl text-base font-bold shadow-[0_0_15px_rgba(168,85,247,0.15)]">
                          {item.primaryKeyword}
                        </span>
                      </div>
                      {generatedContent?.secondaryKeywords && generatedContent.secondaryKeywords.length > 0 && (
                        <div>
                          <span className="text-zinc-500 text-xs uppercase tracking-wider font-bold block mb-3 ml-1">Secondary Keywords</span>
                          <div className="flex flex-wrap gap-2.5">
                            {generatedContent.secondaryKeywords.map((kw: string, i: number) => (
                              <span key={i} className="px-3 py-1.5 bg-white/5 text-zinc-300 rounded-lg text-sm border border-white/5 hover:bg-white/10 hover:border-white/10 transition-all font-medium">
                                {kw}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="glass-card border border-white/10 rounded-3xl p-8 relative overflow-hidden shadow-xl">
                    <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-3">
                      <div className="p-2 bg-blue-500/20 rounded-xl">
                        <Hash className="w-5 h-5 text-blue-400" />
                      </div>
                      Content Structure
                    </h3>
                    <div className="grid grid-cols-2 gap-5 text-sm mb-6">
                      <div className="space-y-4">
                        <div className="flex justify-between items-center p-3 bg-white/5 rounded-xl border border-white/5">
                          <span className="text-zinc-400">H2 Headings</span>
                          <span className="text-white font-bold text-lg">{headings.h2.length}</span>
                        </div>
                        <div className="flex justify-between items-center p-3 bg-white/5 rounded-xl border border-white/5">
                          <span className="text-zinc-400">H3 Headings</span>
                          <span className="text-white font-bold text-lg">{headings.h3.length}</span>
                        </div>
                        <div className="flex justify-between items-center p-3 bg-white/5 rounded-xl border border-white/5">
                          <span className="text-zinc-400">Word Count</span>
                          <span className="text-white font-bold text-lg">{wordCount.toLocaleString()}</span>
                        </div>
                      </div>
                      <div className="space-y-4">
                        <div className="flex justify-between items-center p-3 bg-white/5 rounded-xl border border-white/5">
                          <span className="text-zinc-400">Internal Links</span>
                          <span className="text-white font-bold text-lg">{contentLinks.length}</span>
                        </div>
                        <div className="p-3 bg-white/5 rounded-xl border border-white/5">
                          <span className="text-zinc-400 block mb-1 text-xs uppercase tracking-wider">URL Slug</span>
                          <span className="text-blue-400 font-mono text-sm break-all">/{effectivePublishSlug}</span>
                        </div>
                      </div>
                    </div>
                    {headings.h2.length > 0 && (
                      <div className="mt-6 pt-6 border-t border-white/10">
                        <h4 className="text-sm font-bold text-zinc-300 mb-4 uppercase tracking-wider">Heading Outline</h4>
                        <div className="space-y-2 max-h-[200px] overflow-y-auto custom-scrollbar pr-2">
                          {headings.h2.map((h, i) => (
                            <div key={`h2-${i}`} className="text-sm text-zinc-400 flex items-start gap-3 p-2 hover:bg-white/5 rounded-lg transition-colors">
                              <span className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 text-[10px] font-bold rounded flex-shrink-0 mt-0.5 border border-blue-500/20">H2</span>
                              <span>{h}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ────── INTERNAL LINKS TAB ────── */}
            {activeTab === 'links' && (
              <div className="p-8 max-w-7xl mx-auto space-y-8">
                <div className="glass-card border border-white/10 rounded-3xl p-8 relative overflow-hidden shadow-2xl">
                  <div className="absolute top-0 right-0 w-96 h-96 bg-primary/10 rounded-full blur-3xl -z-10 -translate-y-1/2 translate-x-1/3" />
                  <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-3">
                    <div className="p-2 bg-primary/20 rounded-xl">
                      <Link2 className="w-5 h-5 text-primary" />
                    </div>
                    Internal Links ({generatedContent?.internalLinks?.length || contentLinks.length})
                  </h3>

                  {(generatedContent?.internalLinks && generatedContent.internalLinks.length > 0) ? (
                    <div className="grid gap-4">
                      {generatedContent.internalLinks.map((link: any, i: number) => (
                        <div key={i} className="group relative flex items-start gap-5 p-5 bg-white/5 border border-white/5 rounded-2xl hover:bg-white/10 hover:border-white/10 transition-all hover:shadow-lg hover:-translate-y-0.5">
                          <div className="flex-shrink-0 w-12 h-12 bg-black/20 rounded-xl flex items-center justify-center text-primary font-bold text-lg border border-white/5 shadow-inner">
                            {i + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-3 mb-1.5">
                              <p className="text-lg font-bold text-white group-hover:text-primary transition-colors">{link.anchor}</p>
                              {link.position && (
                                <span className={cn(
                                  "px-2.5 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border shadow-sm",
                                  link.position === 'early' && "bg-blue-500/10 text-blue-400 border-blue-500/20",
                                  link.position === 'middle' && "bg-purple-500/10 text-purple-400 border-purple-500/20",
                                  link.position === 'late' && "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                )}>{link.position}</span>
                              )}
                            </div>
                            <p className="text-sm text-zinc-400 truncate font-mono bg-black/20 px-2 py-0.5 rounded-lg inline-block max-w-full mb-2">{link.targetUrl}</p>

                            {link.context && (
                              <div className="flex items-start gap-2 text-xs text-zinc-500 italic bg-white/5 p-2 rounded-lg border border-white/5">
                                <Quote className="w-3 h-3 flex-shrink-0 mt-0.5 opacity-50" />
                                {link.context}
                              </div>
                            )}

                            {link.relevanceScore !== undefined && (
                              <div className="flex items-center gap-3 mt-3">
                                <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Relevance</span>
                                <div className="h-2 flex-1 max-w-[200px] bg-black/40 rounded-full overflow-hidden border border-white/5">
                                  <div className={cn("h-full rounded-full transition-all shadow-[0_0_10px_rgba(0,0,0,0.5)]", link.relevanceScore >= 70 ? "bg-emerald-500" : link.relevanceScore >= 40 ? "bg-yellow-500" : "bg-red-500")} style={{ width: `${link.relevanceScore}%` }} />
                                </div>
                                <span className={cn("text-xs font-bold", link.relevanceScore >= 70 ? "text-emerald-400" : link.relevanceScore >= 40 ? "text-yellow-400" : "text-red-400")}>{link.relevanceScore}%</span>
                              </div>
                            )}
                          </div>
                          <a href={link.targetUrl} target="_blank" rel="noopener noreferrer" className="p-3 bg-black/20 text-zinc-400 hover:text-white hover:bg-primary/20 transition-all rounded-xl border border-white/5 group-hover:border-primary/20">
                            <ExternalLink className="w-5 h-5" />
                          </a>
                        </div>
                      ))}
                    </div>
                  ) : contentLinks.length > 0 ? (
                    <div className="space-y-3">
                      {contentLinks.map((link, i) => (
                        <div key={i} className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-xl hover:bg-white/10 transition-colors group">
                          <span className="text-white font-bold group-hover:text-primary transition-colors">{link.text}</span>
                          <span className="text-zinc-500 truncate max-w-[400px] ml-4 font-mono text-xs bg-black/20 px-3 py-1 rounded-lg">{link.url}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                        <Link2 className="w-8 h-8 text-zinc-600" />
                      </div>
                      <p className="text-zinc-500 text-lg">No internal links found in this content.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ────── SCHEMA TAB ────── */}
            {activeTab === 'schema' && (
              <div className="p-8 max-w-7xl mx-auto space-y-6">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xl font-bold text-white flex items-center gap-3">
                    <div className="p-2 bg-blue-500/20 rounded-xl">
                      <Shield className="w-5 h-5 text-blue-400" />
                    </div>
                    Schema.org Structured Data
                  </h3>
                  <button onClick={() => { navigator.clipboard.writeText(JSON.stringify(generatedContent?.schema || {}, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                    className="flex items-center gap-2.5 px-4 py-2 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-xl text-sm font-bold hover:bg-blue-500/20 transition-all shadow-lg shadow-blue-500/5">
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}Copy JSON-LD
                  </button>
                </div>
                {generatedContent?.schema ? (
                  <div className="glass-card border border-white/10 rounded-3xl overflow-hidden shadow-2xl relative group">
                    <div className="absolute top-0 right-0 p-4 opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="px-2 py-1 bg-white/10 text-white text-[10px] font-bold rounded uppercase tracking-wider backdrop-blur-md">JSON-LD</span>
                    </div>
                    <pre className="p-6 overflow-auto text-sm text-blue-300 font-mono whitespace-pre-wrap max-h-[65vh] custom-scrollbar bg-black/20 shadow-inner leading-relaxed">
                      {JSON.stringify(generatedContent.schema, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <div className="glass-card border border-white/10 rounded-3xl p-16 flex flex-col items-center justify-center text-center">
                    <div className="w-20 h-20 rounded-2xl bg-white/5 flex items-center justify-center mb-6">
                      <Shield className="w-10 h-10 text-zinc-600" />
                    </div>
                    <p className="text-zinc-500 text-lg">No schema data available for this content.</p>
                  </div>
                )}
              </div>
            )}

            {/* ────── NEURONWRITER TAB (COMPLETELY REDESIGNED) ────── */}
            {activeTab === 'neuron' && (
              <NeuronWriterTab
                neuronData={effectiveNeuronData}
                content={displayContent}
                neuronLiveScore={neuronLiveScore}
              />
            )}
          </>
        )}
      </div>

      {/* ═══════════════ PUBLISH MODAL ═══════════════ */}
      {showPublishModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xl z-[60] flex items-center justify-center p-4 animate-in fade-in duration-300" onClick={() => setShowPublishModal(false)}>
          <div className="glass-card border border-white/10 rounded-3xl w-full max-w-lg p-8 space-y-6 shadow-2xl relative overflow-hidden ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl -z-10 -translate-y-1/2 translate-x-1/2" />

            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <h3 className="text-xl font-bold text-white flex items-center gap-3">
                <div className="p-2.5 bg-primary/20 rounded-xl border border-primary/20 shadow-inner">
                  <Upload className="w-5 h-5 text-primary" />
                </div>
                Publish to WordPress
              </h3>
              <button onClick={() => setShowPublishModal(false)} className="p-2 text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg transition-all"><X className="w-5 h-5" /></button>
            </div>

            {!isConfigured && (
              <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-yellow-400 text-sm flex items-start gap-3 shadow-sm">
                <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" />
                <span className="font-medium">WordPress is not configured. Go to Setup tab to add your credentials.</span>
              </div>
            )}

            {isEditorDirty && (
              <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl text-blue-400 text-sm flex items-start gap-3 shadow-sm">
                <Edit3 className="w-5 h-5 mt-0.5 flex-shrink-0" />
                <span className="font-medium">You have unsaved editor changes. The <strong>edited version</strong> will be published.</span>
              </div>
            )}

            <div className="space-y-5">
              <div className="space-y-2">
                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider ml-1">Post Status</label>
                <div className="flex bg-black/20 p-1.5 rounded-xl border border-white/10">
                  <button onClick={() => setPublishStatus('draft')} className={cn("flex-1 py-2.5 rounded-lg text-sm font-bold transition-all", publishStatus === 'draft' ? "bg-white/10 text-white shadow-sm border border-white/5" : "text-zinc-500 hover:text-zinc-300")}>Draft</button>
                  <button onClick={() => setPublishStatus('publish')} className={cn("flex-1 py-2.5 rounded-lg text-sm font-bold transition-all", publishStatus === 'publish' ? "bg-green-600 text-white shadow-lg shadow-green-600/20" : "text-zinc-500 hover:text-zinc-300")}>Publish Live</button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider ml-1">URL Slug</label>
                <div className="px-4 py-3 bg-black/20 border border-white/10 rounded-xl font-mono text-sm text-primary flex items-center gap-2">
                  <span className="text-zinc-600">/</span>{effectivePublishSlug}
                </div>
              </div>

              {generatedContent?.seoTitle && (
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider ml-1">SEO Title</label>
                  <div className="px-4 py-3 bg-black/20 border border-white/10 rounded-xl text-sm text-zinc-300">
                    {generatedContent.seoTitle}
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-white/10">
              <button onClick={() => setShowPublishModal(false)} className="px-5 py-2.5 bg-white/5 text-zinc-300 rounded-xl text-sm font-bold hover:bg-white/10 transition-all border border-white/5">Cancel</button>
              <button onClick={handlePublishToWordPress} disabled={isPublishing || !isConfigured} className="px-6 py-2.5 bg-gradient-to-r from-primary to-emerald-600 text-white font-bold rounded-xl text-sm hover:shadow-lg hover:shadow-primary/25 transition-all disabled:opacity-50 disabled:shadow-none flex items-center gap-2 transform active:scale-95">
                {isPublishing ? <><Loader2 className="w-4 h-4 animate-spin" />Publishing...</> : <><Upload className="w-4 h-4" />Publish {publishStatus === 'publish' ? 'Now' : 'as Draft'}</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    , document.body);
}

// ═══════════════════════════════════════════════════════════════════
// NEURONWRITER TAB - COMPLETE REDESIGN WITH SEPARATE SECTIONS
// ═══════════════════════════════════════════════════════════════════

interface NeuronWriterTabProps {
  neuronData: NeuronWriterAnalysis | null | undefined;
  content: string;
  neuronLiveScore: { score: number; missing: string[]; underused: string[]; optimal: string[] } | null;
}

function NeuronWriterTab({ neuronData, content, neuronLiveScore }: NeuronWriterTabProps) {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    basic: true,
    extended: true,
    entities: true,
    h1: false,
    h2: true,
    h3: false,
    gaps: true,
  });

  const [termFilter, setTermFilter] = useState<'all' | 'missing' | 'underused' | 'optimal'>('all');

  const toggleSection = (key: string) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const hasStructuredData = neuronData && (
    (Array.isArray(neuronData.basicKeywords) && neuronData.basicKeywords.length > 0) ||
    (Array.isArray(neuronData.extendedKeywords) && neuronData.extendedKeywords.length > 0) ||
    (Array.isArray(neuronData.entities) && neuronData.entities.length > 0) ||
    (Array.isArray(neuronData.terms) && neuronData.terms.length > 0) ||
    (Array.isArray(neuronData.termsExtended) && neuronData.termsExtended.length > 0)
  );

  const legacyTerms: any[] = !hasStructuredData && (neuronData as any)?.terms
    ? (neuronData as any).terms
    : [];

  const contentLower = content.replace(/<[^>]*>/g, ' ').toLowerCase();

  function countTermInContent(term: string): number {
    const termLower = term.toLowerCase();
    const regex = new RegExp(termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = contentLower.match(regex);
    return matches ? matches.length : 0;
  }

  if (!neuronData) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-2xl bg-purple-500/10 flex items-center justify-center mb-4">
            <Brain className="w-8 h-8 text-purple-400" />
          </div>
          <h3 className="text-xl font-bold text-foreground mb-2">NeuronWriter Not Connected</h3>
          <p className="text-muted-foreground max-w-md">Enable NeuronWriter integration in the Setup tab to see keyword analysis, heading suggestions, entities, and content optimization scores.</p>
        </div>
      </div>
    );
  }

  // ✅ FIX: Show "No Data" ONLY when status is explicitly 'failed' OR
  // when there is genuinely no data in ANY form (structured + legacy).
  // Previously, status 'done'/'analysed'/'completed' was triggering the error because
  // the condition checked `nwStatus !== 'ready'` which excluded all valid done states.
  const nwStatus = (neuronData as any)?.status;
  const nwFailReason = (neuronData as any)?._failReason;
  const VALID_READY_STATUSES = new Set(['done', 'ready', 'completed', 'finished', 'analysed', 'analyzed', 'processing', 'queued', 'pending']);
  const isDefinitelyFailed = nwStatus === 'failed';
  const hasAbsolutelyNoData = !hasStructuredData && !legacyTerms.length;
  // Only show the error if explicitly failed, or if no data AND the status is not a known valid state
  if (isDefinitelyFailed || (hasAbsolutelyNoData && !VALID_READY_STATUSES.has((nwStatus || '').toLowerCase()))) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <div className="glass-card border border-yellow-500/20 rounded-3xl p-8 relative overflow-hidden shadow-xl">
          <div className="absolute top-0 right-0 w-64 h-64 bg-yellow-500/5 rounded-full blur-3xl -z-10 -translate-y-1/2 translate-x-1/3" />
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="w-16 h-16 rounded-2xl bg-yellow-500/10 flex items-center justify-center mb-4 border border-yellow-500/20">
              <AlertTriangle className="w-8 h-8 text-yellow-400" />
            </div>
            <h3 className="text-xl font-bold text-white mb-3">NeuronWriter: No Data Available</h3>
            <p className="text-zinc-400 max-w-lg mb-4">
              NeuronWriter is configured but returned no keyword/term data for this content.
              The query may be still processing on NeuronWriter's servers, or there was an issue fetching the data.
            </p>
            {nwFailReason && (
              <div className="px-4 py-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-yellow-400 text-sm font-medium max-w-lg mb-4">
                {nwFailReason}
              </div>
            )}
            {neuronData.keyword && (
              <div className="text-sm text-zinc-500">
                Keyword: <span className="text-purple-400 font-bold">"{neuronData.keyword}"</span>
              </div>
            )}
            {nwStatus && (
              <div className="mt-2 text-xs text-zinc-600">
                Query status: <span className="font-mono text-zinc-400">{nwStatus}</span>
              </div>
            )}
            <div className="mt-6 text-xs text-zinc-600 max-w-md">
              <strong className="text-zinc-400">To fix:</strong> Regenerate the content. The app will auto-create or re-use the NeuronWriter query.
              If issues persist, check{' '}
              <a href="https://app.neuronwriter.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                app.neuronwriter.com
              </a>{' '}to ensure the query is processing correctly.
            </div>
          </div>
        </div>
      </div>
    );
  }


  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">

      {/* ── Score Overview Card ── */}
      <div className="glass-card border border-white/10 rounded-3xl p-8 relative overflow-hidden shadow-2xl group hover:border-white/20 transition-all">
        <div className="absolute top-0 right-0 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl -z-10 -translate-y-1/2 translate-x-1/3" />
        <div className="flex items-center justify-between mb-8">
          <h3 className="text-xl font-bold text-white flex items-center gap-3">
            <div className="p-2 bg-purple-500/20 rounded-xl border border-purple-500/20 shadow-inner">
              <Brain className="w-5 h-5 text-purple-400" />
            </div>
            NeuronWriter Score
          </h3>
          {neuronData.keyword && (
            <div className="flex flex-col items-end">
              <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-500 mb-1">Target Keyword</span>
              <span className="px-4 py-1.5 bg-purple-500/10 text-purple-300 border border-purple-500/20 rounded-xl text-sm font-bold shadow-sm">
                &quot;{neuronData.keyword}&quot;
              </span>
            </div>
          )}
        </div>

        {neuronLiveScore ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            <div className="col-span-1 lg:col-span-1 flex justify-center py-2">
              <div className="relative w-32 h-32 mx-auto filter drop-shadow-[0_0_15px_rgba(168,85,247,0.2)]">
                <svg className="w-32 h-32 transform -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" stroke="currentColor" className="text-white/5" strokeWidth="6" fill="none" />
                  <circle cx="50" cy="50" r="42" stroke="currentColor"
                    className={cn("transition-all duration-1000 ease-out", neuronLiveScore.score >= 90 ? "text-emerald-500" : neuronLiveScore.score >= 70 ? "text-amber-500" : "text-red-500")}
                    strokeWidth="6" fill="none" strokeDasharray={`${neuronLiveScore.score * 2.64} 264`} strokeLinecap="round"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className={cn("text-3xl font-bold", neuronLiveScore.score >= 90 ? "text-emerald-400" : neuronLiveScore.score >= 70 ? "text-amber-400" : "text-red-400")}>
                    {neuronLiveScore.score}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-500 mt-1">Score</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col justify-center p-4 bg-white/5 rounded-2xl border border-white/5 hover:bg-white/10 transition-colors">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Optimal Terms</span>
              </div>
              <span className="text-3xl font-bold text-emerald-400">{neuronLiveScore.optimal.length}</span>
              <div className="h-1 w-full bg-black/20 rounded-full mt-3 overflow-hidden">
                <div className="h-full bg-emerald-500/50 rounded-full" style={{ width: `${(neuronLiveScore.optimal.length / (neuronLiveScore.optimal.length + neuronLiveScore.underused.length + neuronLiveScore.missing.length)) * 100}%` }} />
              </div>
            </div>

            <div className="flex flex-col justify-center p-4 bg-white/5 rounded-2xl border border-white/5 hover:bg-white/10 transition-colors">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]" />
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Underused</span>
              </div>
              <span className="text-3xl font-bold text-amber-400">{neuronLiveScore.underused.length}</span>
              <div className="h-1 w-full bg-black/20 rounded-full mt-3 overflow-hidden">
                <div className="h-full bg-amber-500/50 rounded-full" style={{ width: `${(neuronLiveScore.underused.length / (neuronLiveScore.optimal.length + neuronLiveScore.underused.length + neuronLiveScore.missing.length)) * 100}%` }} />
              </div>
            </div>

            <div className="flex flex-col justify-center p-4 bg-white/5 rounded-2xl border border-white/5 hover:bg-white/10 transition-colors">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Missing</span>
              </div>
              <span className="text-3xl font-bold text-red-400">{neuronLiveScore.missing.length}</span>
              <div className="h-1 w-full bg-black/20 rounded-full mt-3 overflow-hidden">
                <div className="h-full bg-red-500/50 rounded-full" style={{ width: `${(neuronLiveScore.missing.length / (neuronLiveScore.optimal.length + neuronLiveScore.underused.length + neuronLiveScore.missing.length)) * 100}%` }} />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center text-zinc-500">
            <Loader2 className="w-8 h-8 animate-spin mb-3 opacity-50" />
            <p className="text-sm">Calculating live score...</p>
          </div>
        )}

        {hasStructuredData && (
          <div className="mt-8 pt-6 border-t border-white/10 grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            <div className="bg-black/20 rounded-xl p-4 border border-white/5">
              <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-500 block mb-1">Target Words</span>
              <p className="text-white font-bold text-xl">{neuronData.recommended_length?.toLocaleString() || '-'}</p>
            </div>
            <div className="bg-black/20 rounded-xl p-4 border border-white/5">
              <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-500 block mb-1">Target Score</span>
              <p className="text-white font-bold text-xl">{neuronData.content_score || '-'}</p>
            </div>
            <div className="bg-black/20 rounded-xl p-4 border border-white/5">
              <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-500 block mb-1">Total Entities</span>
              <p className="text-white font-bold text-xl">{neuronData.entities?.length || 0}</p>
            </div>
            <div className="bg-black/20 rounded-xl p-4 border border-white/5">
              <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-500 block mb-1">Total Terms</span>
              <p className="text-white font-bold text-xl">{((neuronData.terms?.length || 0) + (neuronData.termsExtended?.length || 0))}</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Filter Bar ── */}
      <div className="glass-card border border-white/10 rounded-2xl p-2 flex items-center gap-2 flex-wrap shadow-lg">
        <div className="mr-3 px-3 py-1 flex items-center gap-2 border-r border-white/10">
          <Filter className="w-4 h-4 text-zinc-400" />
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">Filter</span>
        </div>
        {(['all', 'missing', 'underused', 'optimal'] as const).map(f => (
          <button
            key={f}
            onClick={() => setTermFilter(f)}
            className={cn(
              "px-4 py-2 rounded-xl text-xs font-bold transition-all capitalize border",
              termFilter === f
                ? f === 'missing' ? "bg-red-500/20 text-red-300 border-red-500/30 shadow-[0_0_10px_rgba(239,68,68,0.2)]"
                  : f === 'underused' ? "bg-amber-500/20 text-amber-300 border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.2)]"
                    : f === 'optimal' ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.2)]"
                      : "bg-primary/20 text-primary-300 border-primary/30 shadow-[0_0_10px_rgba(59,130,246,0.2)]"
                : "bg-transparent text-zinc-400 border-transparent hover:bg-white/5 hover:text-zinc-200"
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {/* ── Structured Sections (new NeuronWriterService data) ── */}
      {hasStructuredData ? (
        <div className="space-y-6">
          {/* Basic Keywords (prefer basicKeywords, fallback to terms) */}
          {((neuronData.basicKeywords && neuronData.basicKeywords.length > 0) || (neuronData.terms && neuronData.terms.length > 0)) && (
            <NeuronSection title="Basic Keywords" subtitle="High priority — MUST use all" icon={<Target className="w-5 h-5 text-red-400" />} accentColor="red" isExpanded={expandedSections.basic} onToggle={() => toggleSection('basic')} count={(neuronData.basicKeywords?.length || neuronData.terms?.length || 0)}>
              <TermGrid terms={neuronData.basicKeywords || neuronData.terms || []} content={contentLower} filter={termFilter} />
            </NeuronSection>
          )}

          {/* Extended Keywords (prefer extendedKeywords, fallback to termsExtended) */}
          {((neuronData.extendedKeywords && neuronData.extendedKeywords.length > 0) || (neuronData.termsExtended && neuronData.termsExtended.length > 0)) && (
            <NeuronSection title="Extended Keywords" subtitle="Medium priority — use most" icon={<Layers className="w-5 h-5 text-blue-400" />} accentColor="blue" isExpanded={expandedSections.extended} onToggle={() => toggleSection('extended')} count={(neuronData.extendedKeywords?.length || neuronData.termsExtended?.length || 0)}>
              <TermGrid terms={neuronData.extendedKeywords || neuronData.termsExtended || []} content={contentLower} filter={termFilter} />
            </NeuronSection>
          )}

          {/* Entities */}
          {neuronData.entities && neuronData.entities.length > 0 && (
            <NeuronSection title="Entities" subtitle="Semantic relevance — include naturally" icon={<Tag className="w-5 h-5 text-purple-400" />} accentColor="purple" isExpanded={expandedSections.entities} onToggle={() => toggleSection('entities')} count={neuronData.entities.length}>
              <TermGrid terms={neuronData.entities || []} content={contentLower} filter={termFilter} />
            </NeuronSection>
          )}

          {/* H1 Suggestions */}
          {neuronData.h1Suggestions && neuronData.h1Suggestions.length > 0 && (
            <NeuronSection title="H1 Title Suggestions" subtitle="Recommended H1 titles from top competitors" icon={<Type className="w-5 h-5 text-amber-400" />} accentColor="amber" isExpanded={expandedSections.h1} onToggle={() => toggleSection('h1')} count={neuronData.h1Suggestions.length}>
              <HeadingList headings={neuronData.h1Suggestions.map(h => ({ text: h.text, level: h.level || 'h1', relevanceScore: h.relevanceScore }))} />
            </NeuronSection>
          )}

          {/* H2 Suggestions (prefer h2Suggestions, fallback to headingsH2) */}
          {((neuronData.h2Suggestions && neuronData.h2Suggestions.length > 0) || (neuronData.headingsH2 && neuronData.headingsH2.length > 0)) && (
            <NeuronSection title="H2 Heading Suggestions" subtitle="Use or adapt these headings in your content" icon={<Hash className="w-5 h-5 text-emerald-400" />} accentColor="emerald" isExpanded={expandedSections.h2} onToggle={() => toggleSection('h2')} count={(neuronData.h2Suggestions?.length || neuronData.headingsH2?.length || 0)}>
              <HeadingList headings={(neuronData.h2Suggestions?.map(h => ({ text: h.text, level: h.level || 'h2', relevanceScore: h.relevanceScore })) || neuronData.headingsH2?.map(h => ({ text: h.text, level: 'h2', relevanceScore: h.usage_pc ? Math.round(h.usage_pc * 100) : undefined }))) || []} />
            </NeuronSection>
          )}

          {/* H3 Suggestions (prefer h3Suggestions, fallback to headingsH3) */}
          {((neuronData.h3Suggestions && neuronData.h3Suggestions.length > 0) || (neuronData.headingsH3 && neuronData.headingsH3.length > 0)) && (
            <NeuronSection title="H3 Subheading Suggestions" subtitle="Sub-topics to cover within sections" icon={<List className="w-5 h-5 text-cyan-400" />} accentColor="cyan" isExpanded={expandedSections.h3} onToggle={() => toggleSection('h3')} count={(neuronData.h3Suggestions?.length || neuronData.headingsH3?.length || 0)}>
              <HeadingList headings={(neuronData.h3Suggestions?.map(h => ({ text: h.text, level: h.level || 'h3', relevanceScore: h.relevanceScore })) || neuronData.headingsH3?.map(h => ({ text: h.text, level: 'h3', relevanceScore: h.usage_pc ? Math.round(h.usage_pc * 100) : undefined }))) || []} />
            </NeuronSection>
          )}

          {/* Content Gaps */}
          {neuronData.recommendations?.contentGaps && neuronData.recommendations.contentGaps.length > 0 && (
            <NeuronSection title="Content Gaps" subtitle="Critical missing terms — add these to boost score" icon={<AlertTriangle className="w-5 h-5 text-red-400" />} accentColor="red" isExpanded={expandedSections.gaps} onToggle={() => toggleSection('gaps')} count={neuronData.recommendations.contentGaps.length}>
              <div className="flex flex-wrap gap-2">
                {neuronData.recommendations.contentGaps.map((term: string, i: number) => (
                  <span key={i} className="px-3 py-1.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-sm font-bold flex items-center gap-1.5 shadow-[0_0_10px_rgba(239,68,68,0.1)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                    {term}
                  </span>
                ))}
              </div>
            </NeuronSection>
          )}

          {/* Competitor Data */}
          {neuronData.competitorData && neuronData.competitorData.length > 0 && (
            <div className="glass-card border border-white/10 rounded-3xl p-8 relative overflow-hidden shadow-xl">
              <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/5 rounded-full blur-3xl -z-10 -translate-y-1/2 translate-x-1/2" />
              <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-3">
                <div className="p-2 bg-blue-500/20 rounded-xl border border-blue-500/20">
                  <TrendingUp className="w-5 h-5 text-blue-400" />
                </div>
                Competitor Analysis
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="text-left py-3 px-4 text-zinc-500 font-bold uppercase tracking-wider text-xs">#</th>
                      <th className="text-left py-3 px-4 text-zinc-500 font-bold uppercase tracking-wider text-xs">URL</th>
                      <th className="text-left py-3 px-4 text-zinc-500 font-bold uppercase tracking-wider text-xs">Title</th>
                      <th className="text-right py-3 px-4 text-zinc-500 font-bold uppercase tracking-wider text-xs">Words</th>
                      <th className="text-right py-3 px-4 text-zinc-500 font-bold uppercase tracking-wider text-xs">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {neuronData.competitorData.slice(0, 10).map((comp: any, i: number) => (
                      <tr key={i} className="hover:bg-white/5 transition-colors group">
                        <td className="py-3 px-4 text-zinc-500 font-mono text-xs">{i + 1}</td>
                        <td className="py-3 px-4">
                          <a href={comp.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-white hover:underline truncate block max-w-[200px] transition-colors">
                            {(() => { try { return new URL(comp.url).hostname; } catch { return comp.url; } })()}
                          </a>
                        </td>
                        <td className="py-3 px-4 text-zinc-300 truncate max-w-[250px] group-hover:text-white transition-colors">{comp.title}</td>
                        <td className="py-3 px-4 text-right text-zinc-400 font-mono">{(comp.wordCount || 0).toLocaleString()}</td>
                        <td className="py-3 px-4 text-right">
                          <span className={cn("font-bold px-2 py-0.5 rounded-lg border shadow-sm",
                            (comp.score || 0) >= 70 ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                              (comp.score || 0) >= 50 ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                                "bg-white/5 text-zinc-400 border-white/10"
                          )}>{comp.score || 0}%</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* ── Legacy Flat Terms View (fallback) ── */
        <div className="glass-card border border-white/10 rounded-3xl p-8 shadow-xl">
          <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-3">
            <div className="p-2 bg-purple-500/20 rounded-xl">
              <Brain className="w-5 h-5 text-purple-400" />
            </div>
            Terms Analysis
          </h3>
          {legacyTerms.length > 0 ? (
            <div className="space-y-2">
              {legacyTerms.slice(0, 50).map((term: any, i: number) => {
                const termText = term.term || term.name || term.text || (typeof term === 'string' ? term : '');
                if (!termText) return null;
                const isUsed = contentLower.includes(termText.toLowerCase());
                const count = countTermInContent(termText);
                return (
                  <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 transition-colors">
                    <div className="flex items-center gap-3">
                      <span className={cn("text-sm font-bold", isUsed ? "text-emerald-400" : "text-zinc-300")}>{termText}</span>
                      {term.weight && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-black/30 text-zinc-400 rounded border border-white/5">w:{term.weight}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {count > 0 && (
                        <span className="text-xs text-zinc-500 font-mono">{count}×</span>
                      )}
                      <span className={cn(
                        "text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border shadow-sm",
                        isUsed ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"
                      )}>
                        {isUsed ? '✓ Used' : '✗ Missing'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                <Brain className="w-8 h-8 text-zinc-600" />
              </div>
              <p className="text-zinc-500 text-lg">No NeuronWriter term data available.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// HELPER COMPONENTS (defined OUTSIDE NeuronWriterTab)
// ═══════════════════════════════════════════════════════════════════

function QualityMetric({ label, value, large }: { label: string; value: number; large?: boolean }) {
  const color = value >= 80 ? 'bg-emerald-500' : value >= 60 ? 'bg-amber-500' : 'bg-red-500';
  const textColor = value >= 80 ? 'text-emerald-400' : value >= 60 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className={cn("bg-black/20 rounded-xl border border-white/5", large ? "p-5" : "p-3")}>
      <div className="flex justify-between text-sm mb-2 items-center">
        <span className={cn("text-zinc-400 font-medium", large && "text-base")}>{label}</span>
        <span className={cn("font-bold", textColor, large ? "text-2xl" : "text-lg")}>{value}%</span>
      </div>
      <div className={cn("bg-black/40 rounded-full overflow-hidden border border-white/5", large ? "h-3" : "h-1.5")}>
        <div className={cn("h-full rounded-full transition-all shadow-[0_0_10px_rgba(0,0,0,0.3)]", color)} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

// ── Collapsible NeuronWriter Section ──

interface NeuronSectionProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  accentColor: string;
  isExpanded: boolean;
  onToggle: () => void;
  count: number;
  children: React.ReactNode;
}

function NeuronSection({ title, subtitle, icon, accentColor, isExpanded, onToggle, count, children }: NeuronSectionProps) {
  const accentColors: Record<string, string> = {
    red: "bg-red-500/20 border-red-500/20 text-red-100",
    blue: "bg-blue-500/20 border-blue-500/20 text-blue-100",
    purple: "bg-purple-500/20 border-purple-500/20 text-purple-100",
    amber: "bg-amber-500/20 border-amber-500/20 text-amber-100",
    emerald: "bg-emerald-500/20 border-emerald-500/20 text-emerald-100",
    cyan: "bg-cyan-500/20 border-cyan-500/20 text-cyan-100",
  };

  return (
    <div className="glass-card border border-white/10 rounded-2xl overflow-hidden shadow-lg transition-all hover:border-white/20 hover:shadow-xl">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-5 hover:bg-white/5 transition-colors group"
      >
        <div className="flex items-center gap-4">
          <div className={cn("p-2.5 rounded-xl border transition-all group-hover:scale-110", accentColors[accentColor] || "bg-white/10 border-white/10")}>
            {icon}
          </div>
          <div className="text-left">
            <h4 className="text-base font-bold text-white group-hover:text-primary transition-colors">{title}</h4>
            <p className="text-xs text-zinc-400 font-medium mt-0.5">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="px-2.5 py-0.5 bg-black/30 text-zinc-400 text-xs rounded-lg font-mono border border-white/5">{count}</span>
          <div className="p-1 rounded-lg bg-white/5 group-hover:bg-white/10 text-zinc-400 transition-all">
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        </div>
      </button>
      {isExpanded && (
        <div className="px-5 pb-5 border-t border-white/5 pt-5 bg-black/10">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Term Grid (for basic/extended/entity terms) ──

interface NeuronWriterTermDataForGrid {
  term?: string; // made optional to support entities
  name?: string; // for entities
  weight?: number;
  recommended?: number;
}

interface TermGridProps {
  terms: any[]; // Using any[] to bypass strict check for now, handling mapping inside
  content: string;
  filter: 'all' | 'missing' | 'underused' | 'optimal';
}

function TermGrid({ terms, content, filter }: TermGridProps) {
  if (!terms || terms.length === 0) {
    return <p className="text-zinc-500 text-sm text-center py-4 italic">No terms in this category.</p>;
  }

  const filteredTerms = terms.filter(t => {
    const termText = t.term || t.name || "";
    if (!termText) return false;

    const termLower = termText.toLowerCase();
    const regex = new RegExp(termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const count = (content.match(regex) || []).length;
    const recommended = t.recommended || 1;
    const status = count === 0 ? 'missing' : count < recommended ? 'underused' : 'optimal';
    return filter === 'all' || status === filter;
  });

  if (filteredTerms.length === 0) {
    return <p className="text-zinc-500 text-sm text-center py-4 italic">No terms match the current filter.</p>;
  }

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[1fr_60px_60px_80px_120px] gap-2 px-3 py-2 text-[10px] text-zinc-500 uppercase tracking-wider font-bold mb-1 bg-black/20 rounded-lg border border-white/5">
        <span>Term</span>
        <span className="text-center">Weight</span>
        <span className="text-center">Found</span>
        <span className="text-center">Target</span>
        <span className="text-right">Status</span>
      </div>
      <div className="space-y-1">
        {filteredTerms.map((term, i) => {
          const termText = term.term || term.name || "";
          const termLower = termText.toLowerCase();
          const regex = new RegExp(termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          const count = (content.match(regex) || []).length;
          const recommended = term.recommended || 1;
          const status = count === 0 ? 'missing' : count < recommended ? 'underused' : count <= recommended * 1.5 ? 'optimal' : 'overused';

          return (
            <div key={i} className={cn(
              "grid grid-cols-[1fr_60px_60px_80px_120px] gap-2 items-center px-4 py-2.5 rounded-xl text-sm transition-all border group hover:scale-[1.01]",
              status === 'optimal' ? "bg-emerald-500/5 hover:bg-emerald-500/10 border-emerald-500/10" :
                status === 'underused' ? "bg-amber-500/5 hover:bg-amber-500/10 border-amber-500/10" :
                  status === 'missing' ? "bg-red-500/5 hover:bg-red-500/10 border-red-500/10" :
                    "bg-blue-500/5 hover:bg-blue-500/10 border-blue-500/10"
            )}>
              <span className={cn("font-bold truncate", status === 'optimal' ? "text-emerald-400" : status === 'missing' ? "text-red-400" : status === 'underused' ? "text-amber-400" : "text-blue-400")}>
                {termText}
              </span>
              <div className="flex justify-center">
                <span className="text-xs text-zinc-500 font-mono bg-black/20 px-1.5 py-0.5 rounded">{term.weight !== undefined ? term.weight.toFixed(1) : '-'}</span>
              </div>
              <span className={cn("text-center font-bold text-xs", count > 0 ? "text-white" : "text-zinc-600")}>
                {count}
              </span>
              <span className="text-center text-zinc-500 text-xs font-mono">{recommended}×</span>
              <div className="flex items-center justify-end gap-2">
                <div className="h-1.5 w-12 bg-black/40 rounded-full overflow-hidden hidden sm:block">
                  <div className={cn("h-full rounded-full transition-all shadow-[0_0_5px_rgba(0,0,0,0.5)]",
                    status === 'optimal' ? "bg-emerald-500" :
                      status === 'underused' ? "bg-amber-500" :
                        status === 'missing' ? "bg-red-500" : "bg-blue-500"
                  )} style={{ width: `${Math.min(100, (count / Math.max(1, recommended)) * 100)}%` }} />
                </div>
                <span className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-lg font-bold uppercase tracking-wider whitespace-nowrap border shadow-sm",
                  status === 'optimal' ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                    status === 'underused' ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                      status === 'missing' ? "bg-red-500/10 text-red-400 border-red-500/20" :
                        "bg-blue-500/10 text-blue-400 border-blue-500/20"
                )}>
                  {status}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Heading Suggestion List ──

interface NeuronWriterHeadingDataForList {
  text: string;
  level?: string;
  source?: string;
  relevanceScore?: number;
}

function HeadingList({ headings }: { headings: NeuronWriterHeadingDataForList[] }) {
  if (!headings || headings.length === 0) {
    return <p className="text-zinc-500 text-sm text-center py-4 italic">No heading suggestions.</p>;
  }

  return (
    <div className="space-y-2">
      {headings.map((h, i) => (
        <div key={i} className="flex items-start gap-3 p-3 bg-white/5 border border-white/5 rounded-xl hover:bg-white/10 transition-colors group">
          <span className={cn(
            "flex-shrink-0 px-2 py-1 rounded-lg font-mono text-[10px] font-bold uppercase tracking-wider border shadow-sm",
            h.level === 'h1' ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
              h.level === 'h2' ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                "bg-cyan-500/10 text-cyan-400 border-cyan-500/20"
          )}>
            {h.level}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-zinc-300 group-hover:text-white transition-colors">{h.text}</p>
            {h.source && (
              <p className="text-[10px] text-zinc-500 mt-1 truncate flex items-center gap-1">
                <Globe className="w-3 h-3 opacity-50" />
                {h.source}
              </p>
            )}
          </div>
          {h.relevanceScore !== undefined && (
            <div className="flex items-center gap-2 flex-shrink-0">
              <div className="h-1.5 w-12 bg-black/40 rounded-full overflow-hidden border border-white/5">
                <div
                  className={cn(
                    "h-full rounded-full transition-all shadow-[0_0_5px_rgba(0,0,0,0.5)]",
                    h.relevanceScore >= 80 ? "bg-emerald-500" :
                      h.relevanceScore >= 50 ? "bg-amber-500" :
                        "bg-red-500"
                  )}
                  style={{ width: `${h.relevanceScore}%` }}
                />
              </div>
              <span className={cn(
                "text-[10px] font-bold tabular-nums",
                h.relevanceScore >= 80 ? "text-emerald-400" :
                  h.relevanceScore >= 50 ? "text-amber-400" :
                    "text-red-400"
              )}>
                {h.relevanceScore}%
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DEFAULT EXPORT
// ═══════════════════════════════════════════════════════════════════

export default ContentViewerPanel;
