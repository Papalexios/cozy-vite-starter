// src/lib/sota/geo/embeddings.ts
// Phase 7 — thin client for the /api/embed Cloudflare Function.
// Server-side LOVABLE_API_KEY stays in Cloudflare env; clients call this proxy.

export const EMBED_DIMS = 1536;

export interface EmbedResponse {
  object: 'list';
  data: Array<{ object: 'embedding'; index: number; embedding: number[] }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

const EMBED_URL = '/api/embed';

export async function embedTexts(
  input: string | string[],
  opts?: { model?: string; dimensions?: number; signal?: AbortSignal }
): Promise<number[][]> {
  const arr = Array.isArray(input) ? input : [input];
  const cleaned = arr
    .map((s) => (s || '').toString().trim())
    .filter((s) => s.length > 0)
    .map((s) => s.slice(0, 30_000)); // 32KB cap per item

  if (cleaned.length === 0) return [];

  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: cleaned,
      model: opts?.model,
      dimensions: opts?.dimensions ?? EMBED_DIMS,
    }),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Embed proxy ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as EmbedResponse;
  return (json.data || [])
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export async function embedOne(text: string, opts?: { model?: string; dimensions?: number }): Promise<number[] | null> {
  const v = await embedTexts(text, opts).catch(() => []);
  return v[0] ?? null;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
