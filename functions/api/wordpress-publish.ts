/// <reference types="@cloudflare/workers-types" />

import { isPublicUrl } from "../../src/lib/shared/isPublicUrl";
import { getCorsHeadersForCF } from "../../src/lib/shared/corsHeaders";
import { publishToWordPress, type WordPressPublishPayload } from "../../src/lib/wordpress/publish";

interface Env {
  CORS_ALLOWED_ORIGINS?: string;
}

// ── Rate Limiter ────────────────────────────────────────────────────────────
const rateLimiter = {
  tokens: 10,
  maxTokens: 10,
  refillRate: 1,
  lastRefill: Date.now(),
  tryAcquire(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  },
};

function jsonError(msg: string, status: number, cors: Record<string, string>) {
  return new Response(
    JSON.stringify({ success: false, error: msg, status }),
    { status, headers: { ...cors, "Content-Type": "application/json" } },
  );
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const origin = request.headers.get("origin");
  const cors = getCorsHeadersForCF(origin, env.CORS_ALLOWED_ORIGINS);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST")    return jsonError("Method not allowed", 405, cors);

  if (!rateLimiter.tryAcquire()) {
    return new Response(
      JSON.stringify({ success: false, error: "Rate limit exceeded", type: "rate_limit" }),
      { status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": "10" } },
    );
  }

  try {
    const body: Record<string, unknown> = await request.json();

    const wpUrl = String(body.wordpressUrl || body.wpUrl || "").replace(/\/+$/, "");
    const username = String(body.username || body.wpUsername || "");
    const appPassword = String(body.appPassword || body.wpPassword || body.wpAppPassword || "");

    if (!wpUrl || !username || !appPassword) {
      return jsonError("Missing WordPress URL, username, or app password.", 400, cors);
    }

    const wpUrlWithProto = wpUrl.startsWith("http") ? wpUrl : `https://${wpUrl}`;
    if (!isPublicUrl(wpUrlWithProto)) {
      return jsonError("WordPress URL must be a public HTTP/HTTPS address", 400, cors);
    }

    const title   = String(body.title   || "");
    const content = String(body.content || "");
    if (!title || !content) return jsonError("Missing required fields: title, content", 400, cors);

    const payload: WordPressPublishPayload = {
      wpUrl: wpUrlWithProto,
      username,
      appPassword,
      title,
      content,
      excerpt: body.excerpt ? String(body.excerpt) : undefined,
      status: body.status as WordPressPublishPayload["status"],
      slug: body.slug ? String(body.slug) : undefined,
      categories: Array.isArray(body.categories) ? (body.categories as number[]) : undefined,
      tags:       Array.isArray(body.tags)       ? (body.tags       as number[]) : undefined,
      categoryNames: Array.isArray(body.categoryNames) ? (body.categoryNames as string[]) : undefined,
      tagNames:      Array.isArray(body.tagNames)      ? (body.tagNames      as string[]) : undefined,
      seoTitle:        body.seoTitle        ? String(body.seoTitle)        : undefined,
      metaDescription: body.metaDescription ? String(body.metaDescription) : undefined,
      sourceUrl:       body.sourceUrl       ? String(body.sourceUrl)       : undefined,
      existingPostId: body.existingPostId as number | string | undefined,
      authorId:       typeof body.authorId === "number" ? body.authorId : undefined,
      canonicalUrl:   body.canonicalUrl ? String(body.canonicalUrl) : undefined,
      schemaJson:     body.schemaJson,
      featuredImage:  body.featuredImage as WordPressPublishPayload["featuredImage"],
      scheduledDate:  body.scheduledDate ? String(body.scheduledDate) : undefined,
    };

    const result = await publishToWordPress(payload);
    const status = result.success ? 200 : (result.status ?? 500);
    return new Response(JSON.stringify(result), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = msg.includes("abort") || msg.includes("timeout");
    return jsonError(
      isTimeout ? "Connection to WordPress timed out." : msg,
      isTimeout ? 408 : 500,
      cors,
    );
  }
};
