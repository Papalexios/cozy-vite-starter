// Supabase Edge Function — WordPress Publish (Phase 5)
// Mirrors src/lib/wordpress/publish.ts (cannot import from /src in Deno).
// Always returns 200 with { success, error? } so the client can read the body.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

interface FeaturedImageInput {
  url: string;
  alt?: string;
  caption?: string;
  title?: string;
  filename?: string;
}

interface PublishRequest {
  wpUrl: string;
  username: string;
  appPassword: string;
  title: string;
  content: string;
  excerpt?: string;
  status?: "draft" | "publish" | "pending" | "private" | "future";
  categories?: number[];
  tags?: number[];
  categoryNames?: string[];
  tagNames?: string[];
  slug?: string;
  metaDescription?: string;
  seoTitle?: string;
  sourceUrl?: string;
  existingPostId?: number | string;
  authorId?: number;
  canonicalUrl?: string;
  schemaJson?: unknown;
  featuredImage?: FeaturedImageInput;
  scheduledDate?: string;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildSchemaBlock(schemaJson: unknown): string {
  if (!schemaJson) return "";
  const json = typeof schemaJson === "string" ? schemaJson : JSON.stringify(schemaJson, null, 2);
  return `<!-- wp:html -->\n<script type="application/ld+json">\n${json}\n</script>\n<!-- /wp:html -->\n`;
}

function buildSeoMeta(metaDescription: string, seoTitle: string, fallbackTitle: string, canonicalUrl?: string) {
  const desc = metaDescription || "";
  const title = seoTitle || fallbackTitle;
  const meta: Record<string, string> = {
    _yoast_wpseo_metadesc: desc,
    _yoast_wpseo_title: title,
    rank_math_description: desc,
    rank_math_title: title,
    _aioseo_description: desc,
    _aioseo_title: title,
  };
  if (canonicalUrl) {
    meta._yoast_wpseo_canonical = canonicalUrl;
    meta.rank_math_canonical_url = canonicalUrl;
    meta._aioseo_canonical_url = canonicalUrl;
  }
  return meta;
}

function wpFetchFactory(timeoutMs = 60_000) {
  return async (url: string, options: RequestInit = {}) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  };
}

async function resolveTerms(
  apiBase: string,
  authHeaders: Record<string, string>,
  taxonomy: "categories" | "tags",
  names: string[],
  wpFetch: ReturnType<typeof wpFetchFactory>,
): Promise<number[]> {
  const out: number[] = [];
  for (const raw of names) {
    const name = (raw || "").trim();
    if (!name) continue;
    const searchUrl = `${apiBase}/${taxonomy}?search=${encodeURIComponent(name)}&per_page=20`;
    try {
      const res = await wpFetch(searchUrl, { headers: authHeaders });
      if (res.ok) {
        const arr = await res.json() as Array<{ id: number; name: string }>;
        const match = arr.find(t => t.name?.toLowerCase() === name.toLowerCase());
        if (match) { out.push(match.id); continue; }
      }
      const createRes = await wpFetch(`${apiBase}/${taxonomy}`, {
        method: "POST", headers: authHeaders, body: JSON.stringify({ name }),
      });
      if (createRes.ok) {
        const created = await createRes.json() as { id: number };
        if (created?.id) out.push(created.id);
      } else if (createRes.status === 400) {
        const retry = await wpFetch(searchUrl, { headers: authHeaders });
        if (retry.ok) {
          const arr = await retry.json() as Array<{ id: number; name: string }>;
          const match = arr.find(t => t.name?.toLowerCase() === name.toLowerCase());
          if (match) out.push(match.id);
        }
      }
    } catch { /* skip */ }
  }
  return out;
}

async function uploadFeaturedImage(
  apiBase: string,
  authHeader: string,
  img: FeaturedImageInput,
  wpFetch: ReturnType<typeof wpFetchFactory>,
): Promise<number | null> {
  if (!img?.url) return null;
  try {
    const imgRes = await wpFetch(img.url, { method: "GET" });
    if (!imgRes.ok) return null;
    const buf = await imgRes.arrayBuffer();
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";

    let filename = img.filename || "featured-image.jpg";
    try {
      if (!img.filename) {
        const u = new URL(img.url);
        const last = u.pathname.split("/").filter(Boolean).pop() || "featured-image.jpg";
        filename = last.includes(".") ? last : `${last}.jpg`;
      }
    } catch { /* */ }
    filename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

    const mediaRes = await wpFetch(`${apiBase}/media`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        Accept: "application/json",
      },
      body: buf,
    });
    if (!mediaRes.ok) return null;
    const media = await mediaRes.json() as { id: number };
    if (!media?.id) return null;

    if (img.alt || img.title || img.caption) {
      const patch: Record<string, unknown> = {};
      if (img.alt) patch.alt_text = img.alt;
      if (img.title) patch.title = img.title;
      if (img.caption) patch.caption = img.caption;
      try {
        await wpFetch(`${apiBase}/media/${media.id}`, {
          method: "POST",
          headers: { Authorization: authHeader, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(patch),
        });
      } catch { /* best-effort */ }
    }
    return media.id;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 200);

  try {
    let payload: PublishRequest;
    try { payload = await req.json(); }
    catch { return jsonResponse({ success: false, error: "Invalid JSON body" }, 200); }

    const {
      wpUrl, username, appPassword, title, content, excerpt,
      categories, tags, categoryNames, tagNames,
      slug, metaDescription, seoTitle, sourceUrl, existingPostId,
      authorId, canonicalUrl, schemaJson, featuredImage, scheduledDate,
    } = payload;

    if (!wpUrl || !username || !appPassword || !title || !content) {
      return jsonResponse({ success: false, error: "Missing required fields: wpUrl, username, appPassword, title, content" }, 200);
    }

    const status = payload.status ?? (scheduledDate ? "future" : "draft");

    let baseUrl = wpUrl.trim().replace(/\/+$/, "");
    if (!baseUrl.startsWith("http")) baseUrl = `https://${baseUrl}`;

    const apiBase = `${baseUrl}/wp-json/wp/v2`;
    const apiUrl = `${apiBase}/posts`;
    const authBase64 = btoa(`${username}:${appPassword}`);
    const authHeader = `Basic ${authBase64}`;
    const authHeaders: Record<string, string> = {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const wpFetch = wpFetchFactory();

    // ─── Existing post lookup ─────────────────────────────────────
    let targetPostId: number | null = existingPostId ? parseInt(String(existingPostId), 10) : null;
    if (targetPostId !== null && isNaN(targetPostId)) targetPostId = null;

    const trySlug = async (s: string) => {
      try {
        const r = await wpFetch(`${apiUrl}?slug=${encodeURIComponent(s)}&status=any`, { headers: authHeaders });
        if (r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr) && arr.length > 0) return arr[0].id as number;
        }
      } catch { /* */ }
      return null;
    };
    if (!targetPostId && slug) {
      const cleanSlug = slug.replace(/^\/+|\/+$/g, "").split("/").pop() || slug;
      targetPostId = await trySlug(cleanSlug);
    }
    if (!targetPostId && sourceUrl) {
      const m = sourceUrl.match(/\/([^\/]+)\/?$/);
      if (m) targetPostId = await trySlug(m[1].replace(/\/$/, ""));
    }

    // ─── Phase 5 resolutions (parallel) ───────────────────────────
    const [resolvedCatIds, resolvedTagIds, featuredMediaId] = await Promise.all([
      categoryNames?.length ? resolveTerms(apiBase, authHeaders, "categories", categoryNames, wpFetch) : Promise.resolve([] as number[]),
      tagNames?.length      ? resolveTerms(apiBase, authHeaders, "tags",       tagNames,      wpFetch) : Promise.resolve([] as number[]),
      featuredImage         ? uploadFeaturedImage(apiBase, authHeader, featuredImage, wpFetch)         : Promise.resolve(null),
    ]);
    const allCategoryIds = [...(categories ?? []), ...resolvedCatIds];
    const allTagIds      = [...(tags       ?? []), ...resolvedTagIds];

    // ─── Build content ────────────────────────────────────────────
    const processedContent = schemaJson ? `${buildSchemaBlock(schemaJson)}\n${content}` : content;

    const postData: Record<string, unknown> = { title, content: processedContent, status };
    if (excerpt) postData.excerpt = excerpt;
    if (slug) postData.slug = slug.replace(/^\/+|\/+$/g, "").split("/").pop() || slug;
    if (allCategoryIds.length) postData.categories = allCategoryIds;
    if (allTagIds.length)      postData.tags = allTagIds;
    if (featuredMediaId)       postData.featured_media = featuredMediaId;
    if (typeof authorId === "number") postData.author = authorId;
    if (status === "future" && scheduledDate) {
      postData.date = scheduledDate;
      postData.date_gmt = scheduledDate;
    }
    if (metaDescription || seoTitle || canonicalUrl) {
      postData.meta = buildSeoMeta(metaDescription || "", seoTitle || "", title, canonicalUrl);
    }

    const targetUrl = targetPostId ? `${apiUrl}/${targetPostId}` : apiUrl;
    const method = targetPostId ? "PUT" : "POST";

    let response: Response;
    try {
      response = await wpFetch(targetUrl, { method, headers: authHeaders, body: JSON.stringify(postData) });
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      const isTimeout = msg.includes("abort") || msg.includes("timeout");
      return jsonResponse({
        success: false,
        error: isTimeout
          ? "Connection to WordPress timed out after 60s. Check URL and site availability."
          : `Could not connect to WordPress: ${msg}`,
        status: isTimeout ? 504 : 502,
      }, 200);
    }

    const responseText = await response.text();

    if (!response.ok) {
      let errorMessage = `WordPress API error: ${response.status}`;
      try {
        const errorData = JSON.parse(responseText);
        errorMessage = errorData.message || errorData.error || errorMessage;
      } catch { /* */ }
      if (response.status === 401) errorMessage = "Authentication failed. Check your username and application password.";
      else if (response.status === 403) errorMessage = "Permission denied. Ensure the user has publish capabilities.";
      else if (response.status === 404) errorMessage = "WordPress REST API not found. Ensure permalinks are enabled and REST API is accessible.";
      return jsonResponse({ success: false, error: errorMessage, status: response.status }, 200);
    }

    let post: { id: number; link: string; status: string; title?: { rendered: string }; slug: string };
    try { post = JSON.parse(responseText); }
    catch { return jsonResponse({ success: false, error: "Invalid response from WordPress" }, 200); }

    return jsonResponse({
      success: true,
      updated: !!targetPostId,
      post: {
        id: post.id,
        url: post.link,
        link: post.link,
        status: post.status,
        title: post.title?.rendered || title,
        slug: post.slug,
      },
      resolved: {
        categoryIds: resolvedCatIds.length ? resolvedCatIds : undefined,
        tagIds:      resolvedTagIds.length ? resolvedTagIds : undefined,
        featuredMediaId: featuredMediaId ?? undefined,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse({ success: false, error: msg }, 200);
  }
});
