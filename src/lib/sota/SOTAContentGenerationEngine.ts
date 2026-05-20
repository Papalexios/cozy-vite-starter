// src/lib/sota/SOTAContentGenerationEngine.ts
// ═══════════════════════════════════════════════════════════════════════════════
// SOTA CONTENT GENERATION ENGINE v2.4 — SOTA GOD-MODE MULTI-MODEL
// ═══════════════════════════════════════════════════════════════════════════════

import type {
  AIModel,
  APIKeys,
  GenerationParams,
  GenerationResult,
  ConsensusResult,
} from './types';
import { generationCache } from './cache';

// ─────────────────────────────────────────────────────────────────────────────
// Model configurations with dynamic model ID support
// ─────────────────────────────────────────────────────────────────────────────

interface ModelConfig {
  endpoint: string;
  modelId: string;
  weight: number;
  maxTokens: number;
}

const DEFAULT_MODEL_CONFIGS: Record<AIModel, ModelConfig> = {
  gemini: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    modelId: 'gemini-2.0-flash-exp', // SOTA: Latest Gemini 2.0 Flash
    weight: 1.0,
    maxTokens: 16384,
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    modelId: 'gpt-4o',
    weight: 1.0,
    maxTokens: 16384,
  },
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    modelId: 'claude-3-5-sonnet-20241022', // SOTA: Latest Sonnet 3.5 (New)
    weight: 1.0,
    maxTokens: 8192,
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    modelId: 'anthropic/claude-3.5-sonnet:beta',
    weight: 0.9,
    maxTokens: 16384, // Raised: free routed models need headroom for long-form
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    modelId: 'llama-3.3-70b-versatile',
    weight: 0.8,
    maxTokens: 8192,
  },
};

const OPENROUTER_LONGFORM_SAFE_MODEL = 'anthropic/claude-3.5-sonnet';
const LONGFORM_UNSAFE_OPENROUTER_PATTERNS = [
  /:free$/i,
  /deepseek\/deepseek-v4-flash/i,
  /deepseek.*flash/i,
  /openrouter\/owl-alpha/i,
  /owl-alpha/i,
  /tencent\/hy3/i,
];

function requiresLongFormArticle(params: GenerationParams): boolean {
  return !!(
    params.validation?.requireCompleteArticle ||
    params.validation?.type === 'article-html' ||
    (params.validation?.minWords ?? 0) >= 800 ||
    (params.validation?.minChars ?? 0) >= 5000
  );
}

function isUnsafeOpenRouterLongFormModel(modelId: string): boolean {
  return LONGFORM_UNSAFE_OPENROUTER_PATTERNS.some(pattern => pattern.test(modelId));
}

function parseFallbackEntry(entry: string): { provider: AIModel; modelId?: string } | null {
  const colonIdx = entry.indexOf(':');
  const provider = (colonIdx > 0 ? entry.substring(0, colonIdx) : entry) as AIModel;
  if (!DEFAULT_MODEL_CONFIGS[provider]) return null;
  return {
    provider,
    modelId: colonIdx > 0 ? entry.substring(colonIdx + 1) : undefined,
  };
}

// Free / community OpenRouter backends often cap a single response well below
// what a 3000-word article needs. When that happens the API returns
// finish_reason="length" with a partial body. Instead of failing the whole
// pipeline, we automatically continue the assistant turn and stitch.
// HARD CAP: bounded so slow OpenRouter/community models can finish real articles
// without turning one job into an endless loop.
const MAX_CONTINUATIONS = 4;

export interface ExtendedAPIKeys extends APIKeys {
  openrouterModelId?: string;
  groqModelId?: string;
  fallbackModels?: string[];
}

const MAX_RETRIES = 2; // Enterprise default: retry briefly, then fail/fallback instead of hanging.
const RETRYABLE_STATUS_CODES = [408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524];
// Per-provider timeouts. Free OpenRouter models (e.g. tencent/hy3-preview:free)
// route through slow community backends and routinely take 3-5+ minutes for a
// long-form article. Aborting at 90s wastes the user's chosen free model and
// surfaces as "Generation timed out". Give the chosen provider real time to
// finish before we ever consider falling back.
// Total per-attempt cap. Used as a safety upper bound. For OpenAI-compatible
// providers we ALSO use streaming + inactivity timeout (see STREAM_INACTIVITY_MS)
// so we never abort while the model is actively producing tokens.
// Enterprise budgets — single-attempt ceilings. Streaming watchdogs catch
// real stalls in <90s; these are absolute kill switches so a stuck route
// can never burn 25 minutes silently.
const PROVIDER_TIMEOUT_MS: Record<string, number> = {
  gemini: 180_000,
  openai: 360_000,
  anthropic: 180_000,
  openrouter: 180_000, // 3 min absolute ceiling per call
  groq: 180_000,
};
const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_INACTIVITY_MS = 90_000;
const STREAM_RESUME_ATTEMPTS = 1;
const TRUNCATED_FINISH_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS']);

// Throughput watchdog: if a stream sustains a char-per-second rate below this
// threshold for the grace window AND we haven't already produced enough output,
// treat it as "too slow" and trigger an immediate fallback to the next model.
// This is what saves users from 8-minute "Forging Content 56%" hangs on
// stalled free OpenRouter backends.
const SLOW_THROUGHPUT_CPS = 3;
const SLOW_THROUGHPUT_GRACE_MS = 75_000;
const SLOW_THROUGHPUT_MIN_ELAPSED_MS = 30_000;

// Per-model OVERRIDES for known-slow OpenRouter / community-routed backends.
interface ModelTimingPreset { pattern: RegExp; label: string; timeoutMs: number; inactivityMs: number; }
// Per-model OVERRIDES — cap at 8 minutes max even for slow community routes.
const SLOW_MODEL_PRESETS: ModelTimingPreset[] = [
  { pattern: /tencent\/hy3/i,             label: 'Tencent Hunyuan',     timeoutMs: 180_000, inactivityMs: 45_000 },
  { pattern: /owl-alpha/i,                label: 'Owl Alpha (stealth)', timeoutMs: 180_000, inactivityMs: 45_000 },
  { pattern: /:free$/i,                   label: 'free routed',         timeoutMs: 180_000, inactivityMs: 45_000 },
  { pattern: /deepseek/i,                 label: 'DeepSeek',            timeoutMs: 180_000, inactivityMs: 45_000 },
  { pattern: /qwen/i,                     label: 'Qwen',                timeoutMs: 180_000, inactivityMs: 45_000 },
  { pattern: /llama-?(3\.1|3\.3|4)-?(70|405)b/i, label: 'Llama big',    timeoutMs: 180_000, inactivityMs: 45_000 },
];
function presetForModel(modelId: string): ModelTimingPreset | undefined {
  return SLOW_MODEL_PRESETS.find(p => p.pattern.test(modelId));
}

interface ProviderCallResult {
  content: string;
  tokens: number;
  finishReason?: string;
}

function simpleHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export class SOTAContentGenerationEngine {
  private apiKeys: ExtendedAPIKeys;
  private onProgress?: (message: string) => void;
  private modelConfigs: Record<string, ModelConfig>;
  private fallbackInFlight = new Set<string>();
  // Master abort — when triggered (e.g. user clicks STOP), every in-flight
  // fetch / SSE reader bails out immediately.
  private masterAbort: AbortController = new AbortController();

  /** Abort all in-flight provider calls. Caller can issue a fresh request after. */
  abort(reason?: string): void {
    this.log(`USER_ABORT: ${reason || 'stop requested'}`);
    try { this.masterAbort.abort(); } catch { /* noop */ }
    this.masterAbort = new AbortController();
  }

  /** Returns true when the master signal is currently aborted. */
  isAborted(): boolean {
    return this.masterAbort.signal.aborted;
  }

  private linkAbort(child: AbortController): () => void {
    if (this.masterAbort.signal.aborted) {
      try { child.abort(); } catch { /* noop */ }
    }
    const onAbort = () => { try { child.abort(); } catch { /* noop */ } };
    this.masterAbort.signal.addEventListener('abort', onAbort, { once: true });
    return () => this.masterAbort.signal.removeEventListener('abort', onAbort);
  }

  constructor(apiKeys: ExtendedAPIKeys, onProgress?: (message: string) => void) {
    this.apiKeys = apiKeys;
    this.onProgress = onProgress;
    this.modelConfigs = { ...DEFAULT_MODEL_CONFIGS };

    if (apiKeys.openrouterModelId) {
      this.modelConfigs.openrouter = { ...this.modelConfigs.openrouter, modelId: apiKeys.openrouterModelId };
    }
    if (apiKeys.groqModelId) {
      this.modelConfigs.groq = { ...this.modelConfigs.groq, modelId: apiKeys.groqModelId };
    }
  }

  private log(message: string): void {
    this.onProgress?.(message);
    console.log(`[SOTA Engine] ${message}`);
  }

  private getApiKey(model: AIModel): string | undefined {
    const keyMap: Record<string, keyof ExtendedAPIKeys> = {
      gemini: 'geminiApiKey',
      openai: 'openaiApiKey',
      anthropic: 'anthropicApiKey',
      openrouter: 'openrouterApiKey',
      groq: 'groqApiKey',
    };
    return this.apiKeys[keyMap[model]] as string | undefined;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Hard timeout for any AI provider call. Without this, a stalled stream
   * (e.g. OpenRouter routing to a slow DeepInfra/Novita backend) can hang
   * the entire pipeline indefinitely while still burning tokens on retries.
   * Default: 2 minutes per attempt, then retry/fallback.
   */
  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const unlink = this.linkAbort(controller);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err: any) {
      if (this.masterAbort.signal.aborted) {
        throw new Error('USER_ABORT: generation stopped by user');
      }
      if (err?.name === 'AbortError') {
        throw new Error(`AI request timed out after ${Math.round(timeoutMs / 1000)}s — provider stalled. Falling back...`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  private timingFor(model: AIModel, modelId?: string): { timeoutMs: number; inactivityMs: number; presetLabel?: string } {
    const baseTimeout = PROVIDER_TIMEOUT_MS[model] ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    const preset = modelId ? presetForModel(modelId) : undefined;
    return {
      timeoutMs: preset?.timeoutMs ?? baseTimeout,
      inactivityMs: preset?.inactivityMs ?? DEFAULT_STREAM_INACTIVITY_MS,
      presetLabel: preset?.label,
    };
  }
  private timeoutFor(model: AIModel): number {
    return this.timingFor(model).timeoutMs;
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message;
      // MODEL_INCOMPATIBLE = the model itself can't do the job. Retrying it
      // produces the same garbage — surface it immediately.
      if (msg.includes('MODEL_INCOMPATIBLE')) return false;
      return RETRYABLE_STATUS_CODES.some(code => msg.includes(String(code))) ||
        msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') ||
        msg.includes('ERR_HTTP2_PROTOCOL_ERROR') || msg.includes('fetch failed') ||
        msg.includes('timed out') || msg.includes('AbortError');
    }
    return false;
  }

  private retryDelayMs(error: unknown, attempt: number): number {
    const msg = error instanceof Error ? error.message.toLowerCase() : '';
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit')) {
      return Math.min(30_000 * Math.max(1, attempt), 90_000);
    }
    return Math.min(1500 * Math.pow(2, attempt), 12_000);
  }

  private automaticFallbacks(primaryModel: AIModel, primaryModelId?: string): string[] {
    const fallbacks: string[] = [];
    const add = (entry: string) => { if (!fallbacks.includes(entry)) fallbacks.push(entry); };

    if (this.apiKeys.openrouterApiKey && (primaryModel !== 'openrouter' || primaryModelId !== OPENROUTER_LONGFORM_SAFE_MODEL)) {
      add(`openrouter:${OPENROUTER_LONGFORM_SAFE_MODEL}`);
    }
    if (this.apiKeys.openaiApiKey && primaryModel !== 'openai') add('openai');
    if (this.apiKeys.anthropicApiKey && primaryModel !== 'anthropic') add('anthropic');
    if (this.apiKeys.geminiApiKey && primaryModel !== 'gemini') add('gemini');
    if (this.apiKeys.groqApiKey && primaryModel !== 'groq') add('groq');
    return fallbacks;
  }

  private countWords(text: string): number {
    return text.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
  }

  private completePartialArticle(content: string): string {
    let html = (content || '').replace(/```(?:html)?/gi, '').replace(/```/g, '').trim();
    if (!html) return html;
    html = html.replace(/<[^>]*$/g, '').trim();
    if (!/<article\b/i.test(html)) {
      html = `<article>\n${html}`;
    }
    if (!/<\/article>/i.test(html)) {
      html += `\n<section data-final-takeaway="true">\n<h2>Final Takeaway</h2>\n<p>The practical move is simple: use the framework above, compare it against your own situation, and keep the next step small enough to act on today. Recheck the details against trusted sources before publishing or making important decisions.</p>\n</section>\n</article>`;
    }
    return html;
  }

  private validateGeneration(content: string, params: GenerationParams, finishReason?: string, modelId?: string, opts: { allowTruncation?: boolean } = {}): void {
    const trimmed = (content || '').trim();
    const validation = params.validation;
    const label = `${params.model}${modelId ? `/${modelId}` : ''}`;

    // MODEL_INCOMPATIBLE: the chosen model produced a usable-looking finish but
    // returned almost nothing. Free / stealth OpenRouter models like
    // `openrouter/owl-alpha` or restricted preview models do this — they reply
    // with 10-30 tokens and finish_reason=stop. Retrying produces the same
    // garbage. Throw a NON-retryable, actionable error so the UI can surface
    // "switch model" instead of looping for 8 minutes.
    if (!trimmed) {
      const isLength = finishReason && TRUNCATED_FINISH_REASONS.has(finishReason);
      const hint = isLength
        ? `streamed only SSE keepalives and ended with finish_reason=${finishReason} and ZERO content tokens. This free/stealth OpenRouter route is currently broken, rate-limited, or refusing the prompt.`
        : `returned an empty response (finish_reason=${finishReason || 'unknown'}).`;
      throw new Error(`MODEL_INCOMPATIBLE: ${label} ${hint} Switch to a paid model (anthropic/claude-3.5-sonnet, openai/gpt-4o, or google/gemini-2.0-flash-exp) in Setup.`);
    }
    const wordCount = this.countWords(trimmed);
    if (finishReason === 'stop' && wordCount < 200) {
      throw new Error(`MODEL_INCOMPATIBLE: ${label} only produced ${wordCount} words before stopping. This model is not capable of long-form article generation. Switch to a stronger model (e.g. GPT-4o, Claude 3.5 Sonnet, or Gemini 2.0 Flash) in Setup.`);
    }
    if (!opts.allowTruncation && finishReason && TRUNCATED_FINISH_REASONS.has(finishReason)) {
      throw new Error(`${label} output was truncated by token limits (${finishReason}). Falling back...`);
    }
    if (!validation) return;

    const minChars = validation.minChars ?? 0;
    const minWords = validation.minWords ?? 0;
    if (minChars > 0 && trimmed.length < minChars) {
      throw new Error(`MODEL_INCOMPATIBLE: ${label} returned only ${trimmed.length}/${minChars} chars. This model cannot satisfy the target length — switch model in Setup.`);
    }
    if (minWords > 0 && wordCount < minWords) {
      throw new Error(`MODEL_INCOMPATIBLE: ${label} returned only ${wordCount}/${minWords} words. This model cannot produce a full-length article — switch to a stronger model in Setup.`);
    }
    if (validation.type === 'article-html' || validation.requireCompleteArticle) {
      const hasOpeningArticle = /<article\b/i.test(trimmed);
      const hasClosingArticle = /<\/article>\s*$/i.test(trimmed) || /<\/article>/i.test(trimmed);
      const hasHeadings = /<h[12]\b/i.test(trimmed);
      const hasParagraphs = (trimmed.match(/<p\b/gi) || []).length >= 4;
      if (!hasOpeningArticle || !hasClosingArticle || !hasHeadings || !hasParagraphs) {
        throw new Error(`${label} returned invalid article HTML. Falling back...`);
      }
    }
  }

  /**
   * For OpenRouter / OpenAI-compatible providers: when finish_reason='length',
   * continue the assistant turn so we get a complete article instead of a
   * truncated 4-8k token stub. This is what makes free models like
   * `tencent/hy3-preview:free` and `openrouter/owl-alpha` actually finish.
   */
  private async continueIfTruncated(
    initial: ProviderCallResult,
    params: GenerationParams,
    config: ModelConfig,
    apiKey: string,
    finalMaxTokens: number,
    timeoutMs: number,
  ): Promise<ProviderCallResult> {
    if (params.allowContinuations === false) {
      return initial;
    }
    if (params.model !== 'openrouter' && params.model !== 'groq' && params.model !== 'openai') {
      return initial;
    }
    let acc = initial;
    let rounds = 0;
    while (
      rounds < MAX_CONTINUATIONS &&
      acc.finishReason &&
      TRUNCATED_FINISH_REASONS.has(acc.finishReason) &&
      acc.content &&
      acc.content.length > 200
    ) {
      rounds++;
      this.log(`Continuation ${rounds}/${MAX_CONTINUATIONS} — model returned finish_reason=length, stitching next chunk...`);
      const messages: any[] = [];
      if (params.systemPrompt) messages.push({ role: 'system', content: params.systemPrompt });
      messages.push({ role: 'user', content: params.prompt });
      messages.push({ role: 'assistant', content: acc.content });
      messages.push({ role: 'user', content: 'Continue the article EXACTLY where you stopped. Do not repeat any previous content. Do not restart sentences. Resume mid-token if needed and continue until you reach </article>. Output raw HTML only.' });

      const next = await this.fetchWithTimeout(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: config.modelId,
          messages,
          temperature: params.temperature ?? 0.7,
          max_tokens: finalMaxTokens,
        }),
      }, timeoutMs);

      if (!next.ok) {
        this.log(`Continuation HTTP ${next.status} — stopping stitch loop.`);
        break;
      }
      const data = await next.json().catch(() => null);
      const choice = data?.choices?.[0] || {};
      const chunk = choice.message?.content || '';
      if (!chunk || chunk.trim().length < 20) {
        this.log('Continuation returned empty chunk — stopping.');
        break;
      }
      acc = {
        content: acc.content + chunk,
        tokens: (acc.tokens || 0) + (data?.usage?.total_tokens || 0),
        finishReason: choice.finish_reason,
      };
      this.log(`Continuation ${rounds}: +${chunk.length} chars (total ${acc.content.length}, finish=${acc.finishReason}).`);
      if (/<\/article>/i.test(acc.content)) {
        this.log('Continuation: detected </article> — article complete.');
        break;
      }
    }
    return acc;
  }

  async generateWithModel(params: GenerationParams): Promise<GenerationResult> {
    const { prompt, model, systemPrompt, temperature = 0.7, maxTokens } = params;
    const apiKey = this.getApiKey(model);
    if (!apiKey) throw new Error(`No API key configured for ${model}`);

    const config = (this.modelConfigs[model] || DEFAULT_MODEL_CONFIGS[model]) as ModelConfig;
    if (model === 'openrouter' && requiresLongFormArticle(params) && isUnsafeOpenRouterLongFormModel(config.modelId)) {
      this.log(`⚠️ openrouter/${config.modelId} is flagged as risky for full-length articles (free/flash route — may return partial drafts). Proceeding because the user explicitly selected it. Switch to ${OPENROUTER_LONGFORM_SAFE_MODEL} or GPT-4o if you see truncation.`);
    }
    const cacheKey = `${model}:${config.modelId}:${simpleHash(prompt)}:${simpleHash(systemPrompt || '')}`;
    const cached = generationCache.get<GenerationResult>(cacheKey);
    if (cached) {
      try {
        this.validateGeneration(cached.content, params, cached.finishReason, cached.modelId || config.modelId);
        generationCache.recordHit();
        return { ...cached, cached: true };
      } catch {
        generationCache.recordMiss();
      }
    } else {
      generationCache.recordMiss();
    }

    const finalMaxTokens = maxTokens || config.maxTokens;
    const maxRetries = Math.max(0, Math.min(MAX_RETRIES, params.maxRetries ?? MAX_RETRIES));
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      try {
        let providerResult: ProviderCallResult = { content: '', tokens: 0 };

        const timing = this.timingFor(model, config.modelId);
        const providerTimeout = Math.max(10_000, Math.min(timing.timeoutMs, params.timeoutMs ?? timing.timeoutMs));
        if (timing.presetLabel) {
          this.log(`Detected slow model preset: ${timing.presetLabel} → timeout ${Math.round(providerTimeout / 1000)}s, inactivity ${Math.round(timing.inactivityMs / 1000)}s`);
        }
        if (model === 'gemini') {
          providerResult = await this.callGemini(apiKey, prompt, systemPrompt, temperature, finalMaxTokens, providerTimeout);
        } else if (model === 'openai') {
          providerResult = await this.callOpenAI(apiKey, prompt, systemPrompt, temperature, finalMaxTokens, providerTimeout);
        } else if (model === 'anthropic') {
          providerResult = await this.callAnthropic(apiKey, prompt, systemPrompt, temperature, finalMaxTokens, providerTimeout);
        } else if (model === 'openrouter' || model === 'groq') {
          providerResult = await this.streamOpenAICompatibleWithResume(
            config.endpoint, apiKey, config.modelId, params,
            finalMaxTokens, providerTimeout, timing.inactivityMs,
          );
        }

        // If the provider truncated, transparently continue the turn before validating.
        providerResult = await this.continueIfTruncated(providerResult, params, config, apiKey, finalMaxTokens, providerTimeout);

        this.validateGeneration(providerResult.content, params, providerResult.finishReason, config.modelId);

        const result: GenerationResult = {
          content: providerResult.content,
          model,
          modelId: config.modelId,
          tokensUsed: providerResult.tokens,
          duration: Date.now() - startTime,
          cached: false,
          finishReason: providerResult.finishReason
        };
        generationCache.set(cacheKey, result);
        return result;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('USER_ABORT') || this.masterAbort.signal.aborted) throw error;
        // Slow-throughput abort → skip retrying the same slow model, jump to fallbacks.
        if (msg.includes('SLOW_MODEL')) break;
        if (attempt < maxRetries && this.isRetryableError(error)) {
          const backoffMs = this.retryDelayMs(error, attempt + 1);
          this.log(`Retrying ${model} (attempt ${attempt + 2}/${maxRetries + 1}) after ${Math.round(backoffMs / 1000)}s...`);
          await this.sleep(backoffMs);
          continue;
        }
        break;
      }
    }

    // Long-form enterprise articles must complete. First use explicit fallbacks,
    // then escalate to any configured SOTA-capable provider instead of leaving
    // the UI stuck with "not generated" after a weak/free route stalls.
    const configuredFallbacks = Array.from(new Set((this.apiKeys.fallbackModels || []) as string[]));
    const fallbackModels = Array.from(new Set([
      ...configuredFallbacks,
      ...(requiresLongFormArticle(params) ? this.automaticFallbacks(model, config.modelId) : []),
    ]));
    if (fallbackModels.length > 0) {
      for (const fallbackEntry of fallbackModels) {
        const parsed = parseFallbackEntry(fallbackEntry);
        if (!parsed) continue;
        const { provider: fallbackProvider, modelId: fallbackModelId } = parsed;

        const activeModelId = (this.modelConfigs[model] || DEFAULT_MODEL_CONFIGS[model])?.modelId;
        if (fallbackProvider === model && (!fallbackModelId || fallbackModelId === activeModelId)) continue;
        const fallbackKey = `${fallbackProvider}:${fallbackModelId || (this.modelConfigs[fallbackProvider] || DEFAULT_MODEL_CONFIGS[fallbackProvider])?.modelId || 'default'}`;
        if (this.fallbackInFlight.has(fallbackKey)) continue;

        const fallbackApiKey = this.getApiKey(fallbackProvider);
        if (!fallbackApiKey) continue;

        this.log(`Engaging fallback: ${fallbackProvider} ${fallbackModelId || ''}`);
        const previousConfig = this.modelConfigs[fallbackProvider];
        try {
          this.fallbackInFlight.add(fallbackKey);
          if (fallbackModelId) {
            this.modelConfigs[fallbackProvider] = {
              ...(this.modelConfigs[fallbackProvider] || DEFAULT_MODEL_CONFIGS[fallbackProvider]),
              modelId: fallbackModelId,
            };
          }
          return await this.generateWithModel({ ...params, model: fallbackProvider });
        } catch (fallbackError) {
          lastError = fallbackError;
          continue;
        } finally {
          if (fallbackModelId && previousConfig) this.modelConfigs[fallbackProvider] = previousConfig;
          this.fallbackInFlight.delete(fallbackKey);
        }
      }
    }

    throw lastError;
  }

  private async callGemini(apiKey: string, prompt: string, systemPrompt?: string, temperature: number = 0.7, maxTokens: number = 8192, timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS): Promise<ProviderCallResult> {
    const url = `${this.modelConfigs.gemini.endpoint}/${this.modelConfigs.gemini.modelId}:generateContent?key=${apiKey}`;
    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    const requestBody: any = {
      contents,
      generationConfig: { temperature, maxOutputTokens: maxTokens }
    };
    if (systemPrompt) requestBody.system_instruction = { parts: [{ text: systemPrompt }] };

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }, timeoutMs);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Gemini API error ${response.status}: ${JSON.stringify(errorData)}`);
    }
    const data = await response.json();
    const candidate = data.candidates?.[0] || {};
    return {
      content: candidate.content?.parts?.map((p: any) => p.text || '').join('') || '',
      tokens: data.usageMetadata?.totalTokenCount || 0,
      finishReason: candidate.finishReason,
    };
  }

  private async callOpenAI(apiKey: string, prompt: string, systemPrompt?: string, temperature: number = 0.7, maxTokens: number = 4096, timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS): Promise<ProviderCallResult> {
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const response = await this.fetchWithTimeout(this.modelConfigs.openai.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: this.modelConfigs.openai.modelId,
        messages,
        temperature,
        max_tokens: maxTokens
      })
    }, timeoutMs);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`);
    }
    const data = await response.json();
    const choice = data.choices?.[0] || {};
    return {
      content: choice.message?.content || '',
      tokens: data.usage?.total_tokens || 0,
      finishReason: choice.finish_reason,
    };
  }

  private async callAnthropic(apiKey: string, prompt: string, systemPrompt?: string, temperature: number = 0.7, maxTokens: number = 4096, timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS): Promise<ProviderCallResult> {
    const response = await this.fetchWithTimeout(this.modelConfigs.anthropic.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: this.modelConfigs.anthropic.modelId,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        temperature
      })
    }, timeoutMs);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Anthropic API error ${response.status}: ${JSON.stringify(errorData)}`);
    }
    const data = await response.json();
    return {
      content: data.content?.[0]?.text || '',
      tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      finishReason: data.stop_reason,
    };
  }

  /**
   * Stream a single OpenAI-compatible request. Returns whatever was received
   * before the stream ended OR before inactivity-abort fired. The caller
   * (`streamOpenAICompatibleWithResume`) decides whether to retry/continue.
   *
   * `priorContent`, when set, is injected as a prior assistant turn so the
   * model resumes EXACTLY where the previous (aborted) stream left off
   * instead of restarting from scratch.
   */
  private async streamOpenAICompatibleOnce(
    endpoint: string, apiKey: string, modelId: string,
    prompt: string, systemPrompt: string | undefined,
    temperature: number, maxTokens: number,
    timeoutMs: number, inactivityMs: number,
    priorContent?: string,
  ): Promise<{ result: ProviderCallResult; aborted: boolean; reason?: 'inactivity' | 'overall' | 'slow' | 'user' }> {
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    if (priorContent) {
      messages.push({ role: 'assistant', content: priorContent });
      messages.push({ role: 'user', content: 'Continue EXACTLY where you stopped. Do not repeat any prior text. Do not restart sentences. Resume mid-token if needed and continue until you reach </article>. Output raw HTML only.' });
    }

    const controller = new AbortController();
    let abortReason: 'inactivity' | 'overall' | 'slow' | 'user' | 'user' | undefined;
    const overall = setTimeout(() => { abortReason = 'overall'; controller.abort(); }, timeoutMs);
    let inactivity: ReturnType<typeof setTimeout> | null = null;
    const resetInactivity = () => {
      if (inactivity) clearTimeout(inactivity);
      inactivity = setTimeout(() => { abortReason = 'inactivity'; controller.abort(); }, inactivityMs);
    };
    resetInactivity();
    // Link master abort: user-stop cancels the SSE immediately.
    const unlink = this.linkAbort(controller);
    const masterListener = () => { abortReason = 'user'; };
    this.masterAbort.signal.addEventListener('abort', masterListener, { once: true });

    let response: Response;
    try {
      this.log(`SSE: connecting to ${modelId}…`);
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream',
          'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://contentoptimizer.app',
          'X-Title': 'WP Content Optimizer',
        },
        body: JSON.stringify({ model: modelId, messages, temperature, max_tokens: maxTokens, stream: true }),
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(overall);
      if (inactivity) clearTimeout(inactivity);
      unlink(); this.masterAbort.signal.removeEventListener("abort", masterListener);
      if (err?.name === 'AbortError') {
        return { result: { content: '', tokens: 0 }, aborted: true, reason: abortReason };
      }
      throw err;
    }

    if (!response.ok) {
      clearTimeout(overall);
      if (inactivity) clearTimeout(inactivity);
      unlink(); this.masterAbort.signal.removeEventListener("abort", masterListener);
      const errorText = await response.text().catch(() => '');
      throw new Error(`${modelId} API error ${response.status}: ${errorText.slice(0, 500)}`);
    }
    if (!response.body) {
      clearTimeout(overall);
      if (inactivity) clearTimeout(inactivity);
      unlink(); this.masterAbort.signal.removeEventListener("abort", masterListener);
      throw new Error(`${modelId} returned no response body.`);
    }

    this.log(`SSE: streaming ${modelId}…`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let tokens = 0;
    let finishReason: string | undefined;
    let lastLogChars = 0;
    let sawAnyToken = false;
    let lastKeepaliveLog = 0;

    // FIRST-TOKEN watchdog: free OpenRouter backends (tencent/hy3, owl-alpha, etc.)
    // routinely send SSE keepalive COMMENTS (": OPENROUTER PROCESSING") every few
    // seconds while producing ZERO content tokens, then end the stream with
    // finish_reason=length and an empty body. The previous code reset the
    // inactivity timer on every chunk (including comments), so the watchdog
    // never fired. We now only reset on real content deltas, AND enforce an
    // explicit first-token timeout so dead routes fail fast.
    const FIRST_TOKEN_TIMEOUT_MS = Math.min(inactivityMs, 90_000);
    const firstTokenTimer = setTimeout(() => {
      if (!sawAnyToken) {
        abortReason = 'inactivity';
        this.log(`SSE: no content tokens after ${Math.round(FIRST_TOKEN_TIMEOUT_MS / 1000)}s (only keepalives) — aborting ${modelId}.`);
        controller.abort();
      }
    }, FIRST_TOKEN_TIMEOUT_MS);

    const streamStart = Date.now();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line) continue;
          if (line.startsWith(':')) {
            // SSE comment / keepalive. Do NOT reset inactivity. Log occasionally.
            const now = Date.now();
            if (now - lastKeepaliveLog > 15_000) {
              lastKeepaliveLog = now;
              const waited = Math.round((now - streamStart) / 1000);
              this.log(`SSE: keepalive from ${modelId} (no content yet, ${waited}s elapsed)…`);
            }
            continue;
          }
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { finishReason = finishReason || 'stop'; continue; }
          try {
            const obj = JSON.parse(payload);
            const choice = obj?.choices?.[0];
            const delta = choice?.delta?.content ?? choice?.message?.content;
            if (typeof delta === 'string' && delta.length) {
              sawAnyToken = true;
              resetInactivity();
              content += delta;
              if (content.length - lastLogChars > 800) {
                lastLogChars = content.length;
                const totalChars = (priorContent?.length ?? 0) + content.length;
                const elapsedMs = Date.now() - streamStart;
                const cps = elapsedMs > 0 ? content.length / (elapsedMs / 1000) : 0;
                this.log(`SSE: streaming ${modelId} — ${totalChars.toLocaleString()} chars @ ${cps.toFixed(1)} cps`);
                // Throughput watchdog — fallback if model is too slow.
                if (
                  elapsedMs > SLOW_THROUGHPUT_MIN_ELAPSED_MS &&
                  elapsedMs > SLOW_THROUGHPUT_GRACE_MS &&
                  cps < SLOW_THROUGHPUT_CPS &&
                  totalChars < 4000
                ) {
                  this.log(`SSE: throughput too low (${cps.toFixed(1)} cps < ${SLOW_THROUGHPUT_CPS}) after ${Math.round(elapsedMs / 1000)}s — aborting for fallback.`);
                  abortReason = 'slow';
                  controller.abort();
                }
              }
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (obj?.usage?.total_tokens) tokens = obj.usage.total_tokens;
          } catch {
            buffer = line + '\n' + buffer;
            break;
          }
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        clearTimeout(overall); if (inactivity) clearTimeout(inactivity); clearTimeout(firstTokenTimer); unlink(); this.masterAbort.signal.removeEventListener("abort", masterListener);
        return { result: { content, tokens, finishReason }, aborted: true, reason: abortReason };
      }
      clearTimeout(overall); if (inactivity) clearTimeout(inactivity); clearTimeout(firstTokenTimer); unlink(); this.masterAbort.signal.removeEventListener("abort", masterListener);
      throw err;
    }
    clearTimeout(overall); if (inactivity) clearTimeout(inactivity); clearTimeout(firstTokenTimer); unlink(); this.masterAbort.signal.removeEventListener("abort", masterListener);
    return { result: { content, tokens, finishReason }, aborted: false };
  }

  /**
   * Streaming wrapper that AUTOMATICALLY RESUMES on inactivity-abort,
   * preserving partial output. Each resume opens a fresh connection and
   * supplies the previous content so the model continues where it stopped.
   */
  private async streamOpenAICompatibleWithResume(
    endpoint: string, apiKey: string, modelId: string,
    params: GenerationParams, maxTokens: number,
    timeoutMs: number, inactivityMs: number,
  ): Promise<ProviderCallResult> {
    let acc: ProviderCallResult = { content: '', tokens: 0 };
    let resumes = 0;
    const maxResumes = params.allowResume === false
      ? 0
      : Math.max(0, Math.min(STREAM_RESUME_ATTEMPTS, params.maxStreamResumes ?? STREAM_RESUME_ATTEMPTS));

    while (true) {
      const { result, aborted, reason } = await this.streamOpenAICompatibleOnce(
        endpoint, apiKey, modelId,
        params.prompt, params.systemPrompt,
        params.temperature ?? 0.7, maxTokens,
        timeoutMs, inactivityMs,
        acc.content || undefined,
      );

      // Merge whatever we received this round
      acc = {
        content: acc.content + (result.content || ''),
        tokens: (acc.tokens || 0) + (result.tokens || 0),
        finishReason: result.finishReason,
      };

      if (!aborted) {
        return acc;
      }

      // User pressed STOP — bubble out, do not auto-resume.
      if (reason === 'user' || this.masterAbort.signal.aborted) {
        this.log(`SSE: user aborted on ${modelId}.`);
        throw new Error('USER_ABORT: generation stopped by user');
      }

      // Slow throughput → bail out fast so the outer retry/fallback loop
      // can switch to a faster model. Keep partial content for telemetry.
      if (reason === 'slow') {
        this.log(`SSE: slow-throughput abort on ${modelId} — surfacing for fallback (have ${acc.content.length} chars).`);
        const err: any = new Error(`SLOW_MODEL: ${modelId} throughput below ${SLOW_THROUGHPUT_CPS} cps — falling back to a faster model.`);
        err.partialContent = acc.content;
        throw err;
      }

      // Aborted — decide whether to resume.
      const haveProgress = (result.content?.length ?? 0) > 200 || acc.content.length > 800;
      if (resumes >= maxResumes) {
        if (haveProgress) {
          this.log(`SSE: max resumes (${maxResumes}) reached — keeping ${acc.content.length} chars as truncated.`);
          acc.finishReason = acc.finishReason || 'length';
          return acc;
        }
        throw new Error(`${modelId} stalled (no tokens for ${Math.round(inactivityMs / 1000)}s, ${resumes} resume attempts). Switch to a faster model in Setup.`);
      }
      if (reason === 'overall' && !haveProgress) {
        throw new Error(`${modelId} stalled (overall timeout ${Math.round(timeoutMs / 1000)}s with no output). Switch to a faster model.`);
      }

      resumes++;
      this.log(`SSE: ${reason === 'inactivity' ? 'inactivity' : 'overall'} abort — auto-resuming (${resumes}/${maxResumes}) with ${acc.content.length} chars preserved…`);
      await this.sleep(1500);
    }
  }


  getAvailableModels(): AIModel[] {
    const models: AIModel[] = ['gemini', 'openai', 'anthropic', 'openrouter', 'groq'];
    return models.filter(model => this.getApiKey(model));
  }
}

export function createSOTAEngine(apiKeys: APIKeys, onProgress?: (message: string) => void) {
  return new SOTAContentGenerationEngine(apiKeys, onProgress);
}
