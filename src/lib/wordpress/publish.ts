// src/lib/wordpress/publish.ts
// SOTA WordPress Publish — v4.0 (Phase 5)
// Runtime-agnostic (Node, Edge, CF Workers). Canonical implementation used by:
//   - functions/api/wordpress-publish.ts (Cloudflare Pages)
//   - src/hooks/useWordPressPublish.ts   (browser direct fallback)
// The Supabase edge function mirrors this logic (cannot import from /src).

export type PublishStatus = 'draft' | 'publish' | 'pending' | 'private' | 'future';

export interface FeaturedImageInput {
  url: string;
  alt?: string;
  caption?: string;
  title?: string;
  /** Override filename. Defaults to URL basename. */
  filename?: string;
}

export interface WordPressPublishPayload {
  wpUrl: string;
  username: string;
  appPassword: string;
  title: string;
  content: string;
  excerpt?: string;
  status?: PublishStatus;
  categories?: number[];
  tags?: number[];
  /** Phase 5: upsert categories/tags by name. Resolved → IDs server-side. */
  categoryNames?: string[];
  tagNames?: string[];
  slug?: string;
  metaDescription?: string;
  seoTitle?: string;
  sourceUrl?: string;
  existingPostId?: number | string;

  /** Phase 5 — author mapping (WP user ID). */
  authorId?: number;
  /** Phase 5 — canonical URL (Yoast/Rank Math meta). */
  canonicalUrl?: string;
  /** Phase 5 — schema.org JSON-LD object (or pre-stringified). Injected as Gutenberg core/html block. */
  schemaJson?: unknown;
  /** Phase 5 — featured image upload to Media Library. */
  featuredImage?: FeaturedImageInput;
  /** Phase 5 — scheduled publish (ISO datetime). When set, status defaults to 'future'. */
  scheduledDate?: string;
}

export interface WordPressPublishResult {
  success: boolean;
  updated?: boolean;
  post?: {
    id: number;
    url: string;
    link?: string;
    status: string;
    title: string;
    slug: string;
  };
  /** IDs of resources that were created server-side as part of this publish. */
  resolved?: {
    categoryIds?: number[];
    tagIds?: number[];
    featuredMediaId?: number;
  };
  error?: string;
  status?: number;
}

// ─── helpers exported for tests ──────────────────────────────────────

export function transformYouTubeEmbeds(html: string): string {
  let processed = html;
  processed = processed.replace(
    /<iframe[^>]*src=["']https?:\/\/(?:www\.)?(?:youtube\.com\/embed|youtube-nocookie\.com\/embed)\/([a-zA-Z0-9_-]+)[^"']*["'][^>]*>[\s\S]*?<\/iframe>/gi,
    (_m, videoId: string) => `[embed]https://www.youtube.com/watch?v=${videoId}[/embed]`,
  );
  processed = processed.replace(
    /<figure[^>]*>\s*<div[^>]*>\s*<iframe[^>]*src=["']https?:\/\/(?:www\.)?(?:youtube\.com\/embed|youtube-nocookie\.com\/embed)\/([a-zA-Z0-9_-]+)[^"']*["'][^>]*>[\s\S]*?<\/iframe>\s*<\/div>\s*<figcaption[^>]*>([\s\S]*?)<\/figcaption>\s*<\/figure>/gi,
    (_m, videoId: string, caption: string) => {
      const cleanCaption = caption.replace(/<[^>]*>/g, '').trim();
      return `[embed]https://www.youtube.com/watch?v=${videoId}[/embed]\n<p style="text-align: center; color: #6b7280; font-size: 14px;">${cleanCaption}</p>`;
    },
  );
  return processed;
}

/** Wraps a JSON-LD object/string in a Gutenberg core/html block (preserved by WP block editor). */
export function buildSchemaBlock(schemaJson: unknown): string {
  if (!schemaJson) return '';
  const json = typeof schemaJson === 'string' ? schemaJson : JSON.stringify(schemaJson, null, 2);
  return [
    '<!-- wp:html -->',
    `<script type="application/ld+json">\n${json}\n</script>`,
    '<!-- /wp:html -->',
    '',
  ].join('\n');
}

export function buildSeoMeta(input: {
  metaDescription?: string;
  seoTitle?: string;
  fallbackTitle: string;
  canonicalUrl?: string;
}): Record<string, string> {
  const desc = input.metaDescription || '';
  const title = input.seoTitle || input.fallbackTitle;
  const meta: Record<string, string> = {
    // Yoast
    _yoast_wpseo_metadesc: desc,
    _yoast_wpseo_title: title,
    // Rank Math
    rank_math_description: desc,
    rank_math_title: title,
    // All in One SEO
    _aioseo_description: desc,
    _aioseo_title: title,
  };
  if (input.canonicalUrl) {
    meta._yoast_wpseo_canonical = input.canonicalUrl;
    meta.rank_math_canonical_url = input.canonicalUrl;
    meta._aioseo_canonical_url = input.canonicalUrl;
  }
  return meta;
}

// ─── runtime-agnostic helpers ────────────────────────────────────────

function b64(str: string): string {
  return typeof btoa === 'function' ? btoa(str) : Buffer.from(str).toString('base64');
}

function withTimeout(timeoutMs = 60_000) {
  return async (url: string, options: RequestInit = {}): Promise<Response> => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  };
}

interface WPHelpers {
  apiBase: string;
  authHeaders: Record<string, string>;
  fetchWp: (url: string, options?: RequestInit) => Promise<Response>;
}

function makeHelpers(wpUrl: string, username: string, appPassword: string, timeoutMs = 60_000): WPHelpers {
  const baseUrl = (wpUrl.startsWith('http') ? wpUrl : `https://${wpUrl}`).replace(/\/+$/, '');
  return {
    apiBase: `${baseUrl}/wp-json/wp/v2`,
    authHeaders: {
      Authorization: `Basic ${b64(`${username}:${appPassword}`)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    fetchWp: withTimeout(timeoutMs),
  };
}

// ─── Phase 5: term resolution (categories/tags upsert by name) ───────

async function resolveTerms(
  helpers: WPHelpers,
  taxonomy: 'categories' | 'tags',
  names: string[],
): Promise<number[]> {
  if (!names?.length) return [];
  const out: number[] = [];
  for (const rawName of names) {
    const name = rawName?.trim();
    if (!name) continue;
    try {
      // 1. Search by name
      const searchUrl = `${helpers.apiBase}/${taxonomy}?search=${encodeURIComponent(name)}&per_page=20`;
      const res = await helpers.fetchWp(searchUrl, { headers: helpers.authHeaders });
      if (res.ok) {
        const arr = (await res.json()) as Array<{ id: number; name: string }>;
        const match = arr.find((t) => t.name?.toLowerCase() === name.toLowerCase());
        if (match) {
          out.push(match.id);
          continue;
        }
      }
      // 2. Create if missing
      const createRes = await helpers.fetchWp(`${helpers.apiBase}/${taxonomy}`, {
        method: 'POST',
        headers: helpers.authHeaders,
        body: JSON.stringify({ name }),
      });
      if (createRes.ok) {
        const created = (await createRes.json()) as { id: number };
        if (created?.id) out.push(created.id);
      } else if (createRes.status === 400) {
        // term_exists race — re-search
        const retryRes = await helpers.fetchWp(searchUrl, { headers: helpers.authHeaders });
        if (retryRes.ok) {
          const arr = (await retryRes.json()) as Array<{ id: number; name: string }>;
          const match = arr.find((t) => t.name?.toLowerCase() === name.toLowerCase());
          if (match) out.push(match.id);
        }
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

// ─── Phase 5: featured image upload ──────────────────────────────────

async function uploadFeaturedImage(
  helpers: WPHelpers,
  img: FeaturedImageInput,
): Promise<number | null> {
  if (!img?.url) return null;
  try {
    // 1. Fetch the image bytes
    const imgRes = await helpers.fetchWp(img.url, { method: 'GET' });
    if (!imgRes.ok) return null;
    const buf = await imgRes.arrayBuffer();
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    const filename = (img.filename || (() => {
      try {
        const u = new URL(img.url);
        const last = u.pathname.split('/').filter(Boolean).pop() || 'featured-image.jpg';
        return last.includes('.') ? last : `${last}.jpg`;
      } catch { return 'featured-image.jpg'; }
    })()).replace(/[^a-zA-Z0-9._-]/g, '_');

    // 2. Upload to /wp/v2/media (raw binary + Content-Disposition)
    const mediaRes = await helpers.fetchWp(`${helpers.apiBase}/media`, {
      method: 'POST',
      headers: {
        Authorization: helpers.authHeaders.Authorization,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        Accept: 'application/json',
      },
      body: buf,
    });
    if (!mediaRes.ok) return null;
    const media = (await mediaRes.json()) as { id: number };
    if (!media?.id) return null;

    // 3. Patch alt/title/caption
    if (img.alt || img.title || img.caption) {
      const patch: Record<string, unknown> = {};
      if (img.alt) patch.alt_text = img.alt;
      if (img.title) patch.title = img.title;
      if (img.caption) patch.caption = img.caption;
      try {
        await helpers.fetchWp(`${helpers.apiBase}/media/${media.id}`, {
          method: 'POST',
          headers: helpers.authHeaders,
          body: JSON.stringify(patch),
        });
      } catch { /* metadata is best-effort */ }
    }
    return media.id;
  } catch {
    return null;
  }
}

// ─── existing post lookup ────────────────────────────────────────────

async function findExistingPostId(
  helpers: WPHelpers,
  opts: { existingPostId?: number | string; slug?: string; sourceUrl?: string },
): Promise<number | null> {
  const apiUrl = `${helpers.apiBase}/posts`;
  let id: number | null = opts.existingPostId ? parseInt(String(opts.existingPostId), 10) : null;
  if (id !== null && isNaN(id)) id = null;

  const trySlug = async (slug: string) => {
    try {
      const res = await helpers.fetchWp(`${apiUrl}?slug=${encodeURIComponent(slug)}&status=any`, {
        headers: helpers.authHeaders,
      });
      if (res.ok) {
        const posts = (await res.json()) as Array<{ id: number }>;
        if (posts.length > 0) return posts[0].id;
      }
    } catch { /* ignore */ }
    return null;
  };

  if (!id && opts.slug) {
    const cleanSlug = opts.slug.replace(/^\/+|\/+$/g, '').split('/').pop() || opts.slug;
    id = await trySlug(cleanSlug);
  }
  if (!id && opts.sourceUrl) {
    const m = opts.sourceUrl.match(/\/([^/]+)\/?$/);
    if (m) id = await trySlug(m[1].replace(/\/$/, ''));
  }
  return id;
}

// ─── core publish ────────────────────────────────────────────────────

export async function publishToWordPress(
  payload: WordPressPublishPayload,
): Promise<WordPressPublishResult> {
  const {
    wpUrl, username, appPassword, title, content, excerpt,
    categories, tags, categoryNames, tagNames,
    slug, metaDescription, seoTitle, sourceUrl, existingPostId,
    authorId, canonicalUrl, schemaJson, featuredImage, scheduledDate,
  } = payload;

  // status defaults — if scheduledDate is set without status, default to 'future'
  const status: PublishStatus = payload.status ?? (scheduledDate ? 'future' : 'draft');

  const helpers = makeHelpers(wpUrl, username, appPassword);
  const apiUrl = `${helpers.apiBase}/posts`;

  // ─── Find existing post ────────────────────────────────────────
  const targetPostId = await findExistingPostId(helpers, { existingPostId, slug, sourceUrl });

  // ─── Phase 5 resolutions (parallel) ────────────────────────────
  const [resolvedCategoryIds, resolvedTagIds, featuredMediaId] = await Promise.all([
    categoryNames?.length ? resolveTerms(helpers, 'categories', categoryNames) : Promise.resolve([] as number[]),
    tagNames?.length       ? resolveTerms(helpers, 'tags', tagNames)            : Promise.resolve([] as number[]),
    featuredImage          ? uploadFeaturedImage(helpers, featuredImage)        : Promise.resolve(null),
  ]);

  const allCategoryIds = [...(categories ?? []), ...resolvedCategoryIds];
  const allTagIds      = [...(tags       ?? []), ...resolvedTagIds];

  // ─── Build content (schema block + youtube transforms) ─────────
  let processedContent = transformYouTubeEmbeds(content);
  if (schemaJson) {
    processedContent = `${buildSchemaBlock(schemaJson)}\n${processedContent}`;
  }

  // ─── Build post payload ────────────────────────────────────────
  const postData: Record<string, unknown> = { title, content: processedContent, status };
  if (excerpt) postData.excerpt = excerpt;
  if (slug) postData.slug = slug.replace(/^\/+|\/+$/g, '').split('/').pop() || slug;
  if (allCategoryIds.length) postData.categories = allCategoryIds;
  if (allTagIds.length)      postData.tags = allTagIds;
  if (featuredMediaId)       postData.featured_media = featuredMediaId;
  if (typeof authorId === 'number') postData.author = authorId;
  if (status === 'future' && scheduledDate) {
    // WP expects local site time in ISO; pass through, WP handles tz.
    postData.date = scheduledDate;
    postData.date_gmt = scheduledDate;
  }

  if (metaDescription || seoTitle || canonicalUrl) {
    postData.meta = buildSeoMeta({ metaDescription, seoTitle, fallbackTitle: title, canonicalUrl });
  }

  // ─── Publish / Update ─────────────────────────────────────────
  const targetUrl = targetPostId ? `${apiUrl}/${targetPostId}` : apiUrl;
  const method = targetPostId ? 'PUT' : 'POST';

  let response: Response;
  try {
    response = await helpers.fetchWp(targetUrl, {
      method,
      headers: helpers.authHeaders,
      body: JSON.stringify(postData),
    });
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const isTimeout = msg.includes('abort') || msg.includes('timeout');
    return {
      success: false,
      error: isTimeout
        ? 'Connection to WordPress timed out. Check URL and site availability.'
        : `Could not connect to WordPress: ${msg}`,
      status: isTimeout ? 504 : 502,
    };
  }

  const responseText = await response.text();

  if (!response.ok) {
    let errorMessage = `WordPress API error: ${response.status}`;
    try {
      const errorData = JSON.parse(responseText);
      errorMessage = errorData.message || errorData.error || errorMessage;
    } catch { /* */ }
    if (response.status === 401) errorMessage = 'Authentication failed. Check username and application password.';
    if (response.status === 403) errorMessage = 'Permission denied. Ensure the user has publish capabilities.';
    if (response.status === 404) errorMessage = 'WordPress REST API not found. Ensure permalinks are enabled.';
    return { success: false, error: errorMessage, status: response.status };
  }

  let post: { id: number; link: string; status: string; title?: { rendered: string }; slug: string };
  try {
    post = JSON.parse(responseText);
  } catch {
    return { success: false, error: 'Invalid response from WordPress' };
  }

  return {
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
      categoryIds: resolvedCategoryIds.length ? resolvedCategoryIds : undefined,
      tagIds:      resolvedTagIds.length      ? resolvedTagIds      : undefined,
      featuredMediaId: featuredMediaId ?? undefined,
    },
  };
}
