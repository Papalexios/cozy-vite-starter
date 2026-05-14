// src/lib/sota/NeuronWriterService.ts
// ═══════════════════════════════════════════════════════════════════════════════
// NEURONWRITER SERVICE v9.0 — ENTERPRISE RESILIENCE & AUTO-HEAL + FULL DATA
// 
// Key improvements in v9.0:
//   1. Auto-creates a new keyword query when not found in the project
//   2. Poll loop waits until query status is 'done' (not just any data)
//   3. Full data extraction: basic terms, extended terms, entities, H2/H3
//   4. Comprehensive prompt builder passes ALL NW data to AI
//   5. Handles multiple NeuronWriter API response shapes
// ═══════════════════════════════════════════════════════════════════════════════

export interface NeuronWriterProxyConfig {
  neuronWriterApiKey?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  customProxyUrl?: string;
  onDiagnostic?: (message: string) => void;
}

export interface NWApiResponse {
  success: boolean;
  error?: string;
  status?: number;
  data?: any;
}

export interface NeuronWriterTermData {
  term: string;
  type: 'required' | 'recommended' | 'optional' | 'basic' | 'extended';
  frequency: number;
  weight: number;
  usage_pc?: number;
  recommended?: number;
  sugg_usage?: [number, number];
}

export interface NeuronWriterHeadingData {
  text: string;
  usage_pc?: number;
  level?: 'h1' | 'h2' | 'h3';
  relevanceScore?: number;
}

export interface NeuronWriterAnalysis {
  query_id?: string;
  status?: string;
  keyword?: string;
  content_score?: number;
  recommended_length?: number;
  terms?: NeuronWriterTermData[];
  termsExtended?: NeuronWriterTermData[];
  basicKeywords?: NeuronWriterTermData[];
  extendedKeywords?: NeuronWriterTermData[];
  entities?: Array<{ entity: string; usage_pc?: number; frequency?: number }>;
  headingsH2?: NeuronWriterHeadingData[];
  headingsH3?: NeuronWriterHeadingData[];
  competitorData?: any[];
  h1Suggestions?: NeuronWriterHeadingData[];
  h2Suggestions?: NeuronWriterHeadingData[];
  h3Suggestions?: NeuronWriterHeadingData[];
  recommendations?: any;
}

export interface NeuronWriterQuery {
  id: string;
  keyword: string;
  status: string;
}

export interface NeuronWriterProject {
  id: string;
  name: string;
  queries_count?: number;
}

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const PERSISTENT_CACHE_KEY = 'sota-nw-dedup-cache-v9.0';
const PROXY_TIMEOUT_MS: Record<string, number> = {
  '/list-projects': 15_000,
  '/list-queries': 20_000,
  '/get-query': 30_000,
  '/new-query': 45_000,
};

// Module-level in-flight request coalescing — prevents duplicate /new-query and
// /list-queries calls when multiple callers (or a re-render) ask concurrently.
const INFLIGHT_REQUESTS = new Map<string, Promise<any>>();
function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = INFLIGHT_REQUESTS.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => INFLIGHT_REQUESTS.delete(key));
  INFLIGHT_REQUESTS.set(key, p);
  return p;
}

function endpointTimeout(endpoint: string): number {
  return PROXY_TIMEOUT_MS[endpoint] ?? 30_000;
}

function normalizeWhitespace(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeLanguage(value?: string): string {
  const clean = normalizeWhitespace(value).toLowerCase();
  const map: Record<string, string> = { en: 'English', english: 'English', us: 'English', uk: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese' };
  return map[clean] || normalizeWhitespace(value) || 'English';
}

function normalizeEngine(value?: string): string {
  const clean = normalizeWhitespace(value).toLowerCase();
  const map: Record<string, string> = { us: 'google.com', usa: 'google.com', en: 'google.com', uk: 'google.co.uk', gb: 'google.co.uk', de: 'google.de', es: 'google.es', fr: 'google.fr', it: 'google.it', nl: 'google.nl', pl: 'google.pl', pt: 'google.pt' };
  return map[clean] || normalizeWhitespace(value) || 'google.com';
}

// ─── Levenshtein similarity ───────────────────────────────────────────────────

function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : Math.min(prev[j - 1], prev[j], curr[j - 1]) + 1;
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - levenshteinDistance(a, b) / maxLen;
}

// ─── Persistent deduplication cache ──────────────────────────────────────────

const SESSION_DEDUP_MAP = new Map<string, NeuronWriterQuery>();

function getPersistentCache(): Record<string, { query: NeuronWriterQuery; timestamp: number }> {
  try {
    const raw = localStorage.getItem(PERSISTENT_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveToPersistentCache(keyword: string, query: NeuronWriterQuery) {
  try {
    const cache = getPersistentCache();
    cache[keyword.toLowerCase().trim()] = { query, timestamp: Date.now() };
    localStorage.setItem(PERSISTENT_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn('[NW Cache] Storage failed:', e);
  }
}

function findInPersistentCache(keyword: string): NeuronWriterQuery | undefined {
  const cache = getPersistentCache();
  const entry = cache[keyword.toLowerCase().trim()];
  if (!entry) return undefined;
  // 7-day TTL
  if (Date.now() - entry.timestamp > 7 * 24 * 60 * 60 * 1000) return undefined;
  return entry.query;
}

// ─── Main Service ─────────────────────────────────────────────────────────────

export class NeuronWriterService {
  private config: NeuronWriterProxyConfig;

  constructor(configOrApiKey: NeuronWriterProxyConfig | string) {
    if (typeof configOrApiKey === 'string') {
      let supabaseUrl = typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_SUPABASE_URL ?? '') : '';
      let supabaseAnonKey = typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '') : '';

      if (typeof localStorage !== 'undefined') {
        try {
          const stored = localStorage.getItem('wp-optimizer-storage');
          if (stored) {
            const parsed = JSON.parse(stored);
            const stateConfig = parsed?.state?.config;
            if (stateConfig?.supabaseUrl) supabaseUrl = stateConfig.supabaseUrl;
            if (stateConfig?.supabaseAnonKey) supabaseAnonKey = stateConfig.supabaseAnonKey;
          }
        } catch (e) { }
      }

      this.config = {
        neuronWriterApiKey: configOrApiKey,
        supabaseUrl,
        supabaseAnonKey,
      };
    } else {
      this.config = configOrApiKey;
    }
  }

  private diag(msg: string) {
    console.log(`[NeuronWriter] ${msg}`);
    this.config.onDiagnostic?.(msg);
  }

  private async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Resolve proxy candidates. Keep the app proxy first, then use Supabase only as
   * a fallback when the user has configured it. NeuronWriter keys are sent in the
   * JSON body, not custom browser headers, to avoid brittle CORS preflight failures.
   */
  private resolveProxyUrls(): string[] {
    const urls: string[] = [];
    if (this.config.customProxyUrl) urls.push(this.config.customProxyUrl);
    // Cloudflare Pages Function (production)
    urls.push('/api/neuronwriter');
    // Supabase Edge Function fallback — used when the SPA is hosted on an
    // environment without Cloudflare Pages Functions (e.g. lovable.app preview).
    if (this.config.supabaseUrl && /^https:\/\/[^/]+\.supabase\.co\/?$/i.test(this.config.supabaseUrl.trim())) {
      const base = this.config.supabaseUrl.trim().replace(/\/$/, '');
      urls.push(`${base}/functions/v1/neuronwriter-proxy`);
    }
    return Array.from(new Set(urls));
  }

  private async callProxy(endpoint: string, payload: any = {}): Promise<NWApiResponse> {
    let lastError = '';
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const candidateUrls = this.resolveProxyUrls();
    // Track which proxy URLs are dead (returned HTML / 404 / network error)
    const deadUrls: Set<string> = (this.constructor as any)._deadProxyUrls ||= new Set<string>();

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Pick first non-dead proxy URL, else fall back to the first candidate.
      const url = candidateUrls.find(u => !deadUrls.has(u)) || candidateUrls[0];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), endpointTimeout(cleanEndpoint));
      try {
        this.diag(`callProxy → ${url} | endpoint: ${cleanEndpoint} (attempt ${attempt + 1}/${MAX_RETRIES})`);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        const isSupabaseProxy = !!(
          this.config.supabaseUrl &&
          this.config.supabaseAnonKey &&
          url.startsWith(this.config.supabaseUrl.trim().replace(/\/$/, ''))
        );

        if (isSupabaseProxy) {
          headers['Authorization'] = `Bearer ${this.config.supabaseAnonKey}`;
          headers['apikey'] = this.config.supabaseAnonKey;
        }

        const requestBody: any = {
          endpoint: cleanEndpoint,
          method: 'POST',
          apiKey: this.config.neuronWriterApiKey || '',
          body: payload.body || {},
        };

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
          mode: 'cors',
          credentials: 'omit',
        });

        const rawText = await response.text();
        const looksLikeHtml = /^\s*<(!doctype|html)/i.test(rawText);

        if (looksLikeHtml || response.status === 404) {
          // The proxy endpoint isn't actually mounted (e.g. SPA fallback served index.html).
          deadUrls.add(url);
          throw new Error(
            `Proxy endpoint unavailable at ${url} (server returned ${looksLikeHtml ? 'HTML' : 'HTTP ' + response.status}).` +
            (candidateUrls.some(u => !deadUrls.has(u))
              ? ' Trying fallback proxy…'
              : ' No working proxy available — deploy the Cloudflare Pages function or the Supabase neuronwriter-proxy edge function.')
          );
        }

        let result: any;
        try {
          result = JSON.parse(rawText);
        } catch {
          throw new Error(`Proxy returned non-JSON response: ${rawText.slice(0, 200)}`);
        }

        if (!response.ok) {
          throw new Error(result?.error || result?.message || `HTTP ${response.status}: ${rawText.slice(0, 300)}`);
        }

        if (result.success === false && result.error) {
          throw new Error(result.error);
        }

        const data = result.data !== undefined ? result.data : result;
        return { success: true, data };
      } catch (err: any) {
        const aborted = err?.name === 'AbortError';
        lastError = aborted
          ? `NeuronWriter proxy timed out after ${Math.round(endpointTimeout(cleanEndpoint) / 1000)}s for ${cleanEndpoint}`
          : (err?.message || String(err));
        this.diag(`callProxy attempt ${attempt + 1} failed: ${lastError}`);
        if (/Failed to fetch|NetworkError|Load failed|CORS|endpoint unavailable|server returned HTML|No working proxy/i.test(lastError)) {
          deadUrls.add(url);
        }
        if (attempt < MAX_RETRIES - 1) await this.sleep(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    return { success: false, error: lastError };
  }

  private normalize(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
  }

  // ─── List Projects ──────────────────────────────────────────────────────────

  async listProjects(): Promise<{ success: boolean; projects?: NeuronWriterProject[]; error?: string }> {
    this.diag('Fetching projects list...');
    const res = await this.callProxy('/list-projects', { body: {} });
    if (!res.success) return res;
    const rawProjects = res.data?.projects || res.data?.data || (Array.isArray(res.data) ? res.data : []);
    const projects = Array.isArray(rawProjects)
      ? rawProjects
        .map((project: any) => ({
          id: normalizeWhitespace(project.id || project.project || project.project_id),
          name: normalizeWhitespace(project.name || project.domain || project.url || project.project),
          queries_count: project.queries_count ?? project.queriesCount,
        }))
        .filter((project: NeuronWriterProject) => project.id && project.name)
      : [];
    return { success: true, projects };
  }

  // ─── Find existing query by keyword (fuzzy match) ───────────────────────────

  async findQueryByKeyword(projectId: string, keyword: string): Promise<{ success: boolean; query?: NeuronWriterQuery; error?: string }> {
    return coalesce(`find:${projectId}:${this.normalize(keyword)}`, () => this._findQueryByKeyword(projectId, keyword));
  }

  private async _findQueryByKeyword(projectId: string, keyword: string): Promise<{ success: boolean; query?: NeuronWriterQuery; error?: string }> {
    const norm = this.normalize(keyword);
    const sessionHit = SESSION_DEDUP_MAP.get(norm);
    if (sessionHit) {
      this.diag(`Cache hit (session) for "${keyword}"`);
      return { success: true, query: sessionHit };
    }

    const persistentHit = findInPersistentCache(norm);
    if (persistentHit) {
      this.diag(`Cache hit (persistent) for "${keyword}"`);
      return { success: true, query: persistentHit };
    }

    this.diag(`Searching project ${projectId} for "${keyword}"...`);
    const res = await this.callProxy('/list-queries', { body: { project: projectId } });
    if (!res.success) return res;

    // NeuronWriter API returns: array of query objects OR { queries: [...] }
    const list: any[] = Array.isArray(res.data) ? res.data : (res.data?.queries || res.data?.data || []);
    this.diag(`Found ${list.length} existing queries in project.`);

    for (const q of list) {
      const qKeyword = q.keyword || q.query_keyword || q.name || '';
      const qNorm = this.normalize(qKeyword);
      if (levenshteinSimilarity(qNorm, norm) > 0.88) {
        // q.query or q.id is the query identifier for /get-query calls
        const queryId = q.query || q.id || q.query_id;
        const mapped: NeuronWriterQuery = {
          id: queryId,
          keyword: qKeyword,
          status: q.status || 'ready',
        };
        SESSION_DEDUP_MAP.set(norm, mapped);
        saveToPersistentCache(norm, mapped);
        this.diag(`Matched existing query "${qKeyword}" (ID: ${queryId})`);
        return { success: true, query: mapped };
      }
    }

    this.diag(`No existing query found for "${keyword}".`);
    return { success: true, query: undefined };
  }

  // ─── Create a new query in the project ─────────────────────────────────────

  async createQuery(projectId: string, keyword: string): Promise<{ success: boolean; query?: NeuronWriterQuery; error?: string }> {
    this.diag(`Creating new NeuronWriter query for "${keyword}" in project ${projectId}...`);

    const res = await this.callProxy('/new-query', {
      body: {
        project: projectId,
        keyword: keyword,
          language: normalizeLanguage((this.config as any).targetLanguage),
          engine: normalizeEngine((this.config as any).targetCountry),
        competitors_mode: 'top-intent',
      }
    });

    if (!res.success) {
      this.diag(`Failed to create query: ${res.error}`);
      return { success: false, error: res.error };
    }

    const data = res.data?.data || res.data;
    // The API returns the new query id as data.query or data.id
    const queryId = data?.query || data?.id || data?.query_id;
    const status = data?.status || 'processing';

    if (!queryId) {
      this.diag(`Query created but no ID returned. Response: ${JSON.stringify(data).slice(0, 200)}`);
      return { success: false, error: 'Query created but no ID in response' };
    }

    const newQuery: NeuronWriterQuery = {
      id: queryId,
      keyword,
      status,
    };

    // Cache it immediately so we don't recreate on retry
    const norm = this.normalize(keyword);
    SESSION_DEDUP_MAP.set(norm, newQuery);
    saveToPersistentCache(norm, newQuery);

    this.diag(`New query created: ID=${queryId}, status=${status}`);
    return { success: true, query: newQuery };
  }

  // ─── Get query analysis (full data extraction) ──────────────────────────────

  async getQueryAnalysis(queryId: string): Promise<{ success: boolean; analysis?: NeuronWriterAnalysis; error?: string }> {
    this.diag(`Fetching analysis for query ${queryId}...`);
    const res = await this.callProxy('/get-query', { body: { query: queryId } });
    if (!res.success) return res;

    // The server proxy wraps data. Unwrap carefully.
    const raw = res.data?.data || res.data;

    if (!raw) {
      return { success: true, analysis: undefined };
    }

    this.diag(`Raw analysis keys: ${Object.keys(raw).join(', ')}`);

    const terms = raw.terms || {};
    const termsTxt = raw.terms_txt || {};

    const analysis: NeuronWriterAnalysis = {
      query_id: queryId,
      status: raw.status || 'processing',
      keyword: raw.keyword || raw.query_keyword,
      content_score: raw.content_score || raw.score || 0,
      recommended_length: raw.recommended_length || raw.recommendedLength || raw.avg_word_count || raw.metrics?.word_count?.target || raw.metrics?.word_count?.median || 2500,

      // Basic terms — NW API uses 'terms' or 'terms_basic'
      terms: this.parseTerms(raw.terms_basic || raw.content_basic || terms.content_basic || terms.content || termsTxt.content_basic || [], 'basic'),

      // Extended terms — NW API uses 'terms_extended' or 'extended_terms'
      termsExtended: this.parseTerms(raw.terms_extended || raw.extended_terms || raw.termsExtended || terms.content_extended || termsTxt.content_extended || [], 'extended'),

      // Named entities
      entities: this.parseEntities(raw.entities || raw.named_entities || raw.namedEntities || terms.entities || termsTxt.entities || []),

      // H2 headings from competitor analysis
      headingsH2: this.parseHeadings(raw.headings_h2 || raw.h2_suggestions || raw.h2s || terms.h2 || terms.content_h2 || raw.headings?.filter((h: any) => (h.level || h.type) === 'h2') || [], 'h2'),

      // H3 headings from competitor analysis
      headingsH3: this.parseHeadings(raw.headings_h3 || raw.h3_suggestions || raw.h3s || terms.h3 || terms.content_h3 || raw.headings?.filter((h: any) => (h.level || h.type) === 'h3') || [], 'h3'),

      competitorData: raw.competitors || raw.competitor_data || [],
    };

    // Populate new-style aliases for backward compat with UI components
    analysis.basicKeywords = analysis.terms;
    analysis.extendedKeywords = analysis.termsExtended;
    analysis.h2Suggestions = analysis.headingsH2;
    analysis.h3Suggestions = analysis.headingsH3;

    this.diag(
      `Analysis parsed: ${analysis.terms?.length || 0} basic terms, ` +
      `${analysis.termsExtended?.length || 0} extended terms, ` +
      `${analysis.entities?.length || 0} entities, ` +
      `${analysis.headingsH2?.length || 0} H2s, ` +
      `${analysis.headingsH3?.length || 0} H3s. ` +
      `Status: ${analysis.status}`
    );

    return { success: true, analysis };
  }

  // ─── Prompt builder — comprehensive SEO context ─────────────────────────────

  /**
   * Builds a full prompt section for the AI with ALL NeuronWriter data:
   * basic keywords, extended keywords, named entities, and competitor headings.
   * Instructs the AI to achieve >90 NeuronWriter score.
   */
  buildFullPromptSection(analysis: NeuronWriterAnalysis): string {
    const lines: string[] = [];

    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('🔴 NEURONWRITER SEO DATA — NON-NEGOTIABLE COMPLIANCE');
    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push(`Target Keyword: "${analysis.keyword || 'N/A'}"`);
    lines.push(`Recommended Word Count: ${analysis.recommended_length || 2500}+ words`);
    lines.push(`Target Content Score: ≥90/100`);
    lines.push('');

    // Basic (required) terms — with EXACT frequency targets
    const basicTerms = analysis.terms || analysis.basicKeywords || [];
    if (basicTerms.length > 0) {
      lines.push('🔴 BASIC KEYWORDS — MANDATORY (you MUST use ALL of these):');
      lines.push('These are the PRIMARY ranking terms. Missing even one drops your score significantly.');
      lines.push('');
      const basicList = basicTerms.slice(0, 60).map(t => {
        const freq = t.recommended || t.frequency || 1;
        const min = Math.max(1, freq);
        return `  ✦ "${t.term}" — use EXACTLY ${min}x (${t.weight > 1 ? 'HIGH weight' : 'standard'})`;
      });
      lines.push(basicList.join('\n'));
      lines.push('');
    }

    // Extended terms
    const extTerms = analysis.termsExtended || analysis.extendedKeywords || [];
    if (extTerms.length > 0) {
      lines.push('🟡 EXTENDED KEYWORDS — HIGH PRIORITY (use 85%+ of these):');
      lines.push('These semantic variations boost topical authority. Weave them naturally throughout.');
      lines.push('');
      const extList = extTerms.slice(0, 60).map(t => {
        const freq = t.recommended || t.frequency || 1;
        return `  ◆ "${t.term}" — use ${freq}x`;
      });
      lines.push(extList.join('\n'));
      lines.push('');
    }

    // Named entities
    const entities = analysis.entities || [];
    if (entities.length > 0) {
      lines.push('🟢 NAMED ENTITIES — REQUIRED (reference each one in context):');
      lines.push('Include these real-world names/things to demonstrate topical expertise.');
      lines.push('');
      const entityList = entities.slice(0, 30).map(e =>
        `  ● ${e.entity}${e.frequency ? ` (mention ${e.frequency}x)` : ''}`
      );
      lines.push(entityList.join('\n'));
      lines.push('');
    }

    // Competitor H2 headings
    const h2s = analysis.headingsH2 || analysis.h2Suggestions || [];
    if (h2s.length > 0) {
      lines.push('📋 COMPETITOR H2 HEADINGS — your H2s must cover these SAME topics:');
      lines.push('(Adapt and improve them, don\'t copy verbatim)');
      const h2List = h2s.slice(0, 15).map(h => `  → ${h.text}`);
      lines.push(h2List.join('\n'));
      lines.push('');
    }

    // Competitor H3 headings
    const h3s = analysis.headingsH3 || analysis.h3Suggestions || [];
    if (h3s.length > 0) {
      lines.push('📋 COMPETITOR H3 HEADINGS — use as sub-section inspiration:');
      const h3List = h3s.slice(0, 15).map(h => `  → ${h.text}`);
      lines.push(h3List.join('\n'));
      lines.push('');
    }

    // Summary stats
    const totalBasic = basicTerms.length;
    const totalExt = extTerms.length;
    const totalEntities = entities.length;
    lines.push('─── SCORING SUMMARY ───');
    lines.push(`Total basic keywords: ${totalBasic} (must use 100%)`);
    lines.push(`Total extended keywords: ${totalExt} (must use 85%+)`);
    lines.push(`Total entities: ${totalEntities} (must reference all)`);
    lines.push(`Total H2 topics to cover: ${h2s.length}`);
    lines.push('');
    lines.push('INTEGRATION RULES:');
    lines.push('1. Work every term into a real sentence — never keyword-stuff.');
    lines.push('2. Spread terms across ALL sections — not clustered in one area.');
    lines.push('3. Use exact phrasing where possible (not just partial matches).');
    lines.push('4. Higher-weight terms should appear in headings AND body text.');
    lines.push('5. Entities should appear in expert citations or factual statements.');
    lines.push('═══════════════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  /**
   * Legacy format (kept for backward compatibility).
   * Prefer buildFullPromptSection() for full NW data coverage.
   */
  formatTermsForPrompt(terms: NeuronWriterTermData[], analysis: NeuronWriterAnalysis): string {
    return this.buildFullPromptSection(analysis);
  }

  // ─── Private parsers ────────────────────────────────────────────────────────

  private parseTerms(raw: any, defaultType: 'basic' | 'extended' = 'basic'): NeuronWriterTermData[] {
    const rows = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(/\r?\n|,/).map(term => ({ term: term.trim() })).filter(t => t.term)
        : [];
    return rows
      .filter(t => t && (t.term || t.text || t.keyword || t.name || t.t))
      .map(t => ({
        term: normalizeWhitespace(t.term || t.text || t.keyword || t.name || t.t || ''),
        type: (t.type as any) || defaultType,
        frequency: t.count || t.frequency || t.occurrences || 0,
        weight: t.weight || t.importance || 1,
        usage_pc: t.usage_pc || t.usagePc || 0,
        recommended: t.recommended || t.sugg_usage?.[1] || t.max || t.freq_max || Math.max(1, Math.round((t.weight || 1) * 2)),
        sugg_usage: t.sugg_usage,
      }))
      .filter(t => t.term.length > 0);
  }

  private parseEntities(raw: any): Array<{ entity: string; usage_pc?: number; frequency?: number }> {
    const rows = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(/\r?\n|,/).map(entity => ({ entity: entity.trim() })).filter(e => e.entity)
        : [];
    return rows
      .filter(e => e && (e.entity || e.text || e.name || e.value || e.t))
      .map(e => ({
        entity: normalizeWhitespace(e.entity || e.text || e.name || e.value || e.t || ''),
        usage_pc: e.usage_pc || e.usagePc || 0,
        frequency: e.frequency || e.count || e.occurrences || 0,
      }))
      .filter(e => e.entity.length > 0);
  }

  private parseHeadings(raw: any, defaultLevel: 'h2' | 'h3' = 'h2'): NeuronWriterHeadingData[] {
    const rows = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(/\r?\n/).map(text => ({ text: text.trim() })).filter(h => h.text)
        : [];
    return rows
      .filter(h => h && (h.text || h.heading || h.title || h.value || h.t))
      .map(h => ({
        text: normalizeWhitespace(h.text || h.heading || h.title || h.value || h.t || ''),
        usage_pc: h.usage_pc || h.usagePc || 0,
        level: (h.level || h.type || defaultLevel) as 'h1' | 'h2' | 'h3',
        relevanceScore: h.relevance || h.relevanceScore || h.score || 0,
      }))
      .filter(h => h.text.length > 0);
  }
}

export function createNeuronWriterService(apiKeyOrConfig: string | NeuronWriterProxyConfig) {
  return new NeuronWriterService(apiKeyOrConfig);
}

/**
 * Score content against NeuronWriter terms.
 * Returns percentage 0-100 of terms found in content.
 */
export function scoreContentAgainstNeuron(html: string, terms: NeuronWriterTermData[]): number {
  if (!html || !terms?.length) return 0;
  const text = html.replace(/<[^>]*>/g, ' ').toLowerCase();
  let found = 0;
  terms.forEach(t => {
    if (t.term && text.includes(t.term.toLowerCase())) found++;
  });
  return Math.round((found / terms.length) * 100);
}