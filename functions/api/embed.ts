/// <reference types="@cloudflare/workers-types" />
// Phase 7 — Cloudflare Pages Function: proxy to Lovable AI Gateway embeddings.
// Keeps LOVABLE_API_KEY server-side.

import { getCorsHeadersForCF } from "../../src/lib/shared/corsHeaders";

interface Env {
  LOVABLE_API_KEY?: string;
  CORS_ALLOWED_ORIGINS?: string;
}

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/embeddings";
const DEFAULT_MODEL = "google/gemini-embedding-001";
const DEFAULT_DIMS = 1536;

function jerr(msg: string, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify({ success: false, error: msg }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const cors = getCorsHeadersForCF(request.headers.get("origin"), env.CORS_ALLOWED_ORIGINS);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jerr("POST only", 405, cors);
  if (!env.LOVABLE_API_KEY) return jerr("LOVABLE_API_KEY is not configured on this deployment", 500, cors);

  let body: { input?: string | string[]; model?: string; dimensions?: number };
  try {
    body = await request.json();
  } catch {
    return jerr("Invalid JSON body", 400, cors);
  }

  const input = body.input;
  if (!input || (Array.isArray(input) && input.length === 0)) {
    return jerr("Missing input (string or string[])", 400, cors);
  }
  if (Array.isArray(input) && input.length > 256) {
    return jerr("Max 256 inputs per request", 400, cors);
  }

  try {
    const upstream = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: body.model || DEFAULT_MODEL,
        input,
        dimensions: body.dimensions || DEFAULT_DIMS,
      }),
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      const status = upstream.status === 429 || upstream.status === 402 ? upstream.status : 502;
      return jerr(`Embedding gateway ${upstream.status}: ${raw.slice(0, 300)}`, status, cors);
    }

    return new Response(raw, {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jerr(`Embedding proxy failure: ${msg}`, 500, cors);
  }
};
