import { useState, useCallback } from 'react';
import { useOptimizerStore } from '@/lib/store';
import { getSupabaseClient, getSupabaseConfig } from '@/lib/supabaseClient';
import { recordPublish } from '@/lib/db/contentMemory';
import { captureBaseline } from '@/lib/feedback';

interface PublishResult {
  success: boolean;
  postId?: number;
  postUrl?: string;
  error?: string;
}

export function useWordPressPublish() {
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const { config } = useOptimizerStore();

  const publish = useCallback(async (
    title: string,
    content: string,
    options?: {
      excerpt?: string;
      status?: 'draft' | 'publish' | 'pending' | 'private' | 'future';
      slug?: string;
      metaDescription?: string;
      seoTitle?: string;
      sourceUrl?: string;
      existingPostId?: number;
      /** Phase 1 content-memory linkage (optional, no-op if Supabase not configured). */
      draftId?: string;
      siteId?: string;
      /** Phase 5 — extended publish features. */
      categories?: number[];
      tags?: number[];
      categoryNames?: string[];
      tagNames?: string[];
      authorId?: number;
      canonicalUrl?: string;
      schemaJson?: unknown;
      featuredImage?: { url: string; alt?: string; caption?: string; title?: string; filename?: string };
      scheduledDate?: string;
    }
  ): Promise<PublishResult> => {
    setIsPublishing(true);
    setPublishResult(null);

    try {
      if (!config.wpUrl || !config.wpUsername || !config.wpAppPassword) {
        throw new Error('WordPress not configured. Add WordPress URL, username, and application password in Setup.');
      }

      try {
        const parsed = new URL(config.wpUrl.startsWith('http') ? config.wpUrl : `https://${config.wpUrl}`);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('WordPress URL must use HTTP or HTTPS');
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('HTTP')) throw e;
        throw new Error('Invalid WordPress URL format');
      }

      const safeSlug = options?.slug ? options.slug.replace(/^\/+/, '').split('/').pop() : undefined;

      const body = {
        wpUrl: config.wpUrl,
        username: config.wpUsername,
        appPassword: config.wpAppPassword,
        title,
        content,
        excerpt: options?.excerpt,
        status: options?.status || (options?.scheduledDate ? 'future' : 'draft'),
        slug: safeSlug,
        metaDescription: options?.metaDescription,
        seoTitle: options?.seoTitle,
        sourceUrl: options?.sourceUrl,
        existingPostId: options?.existingPostId,
        // Phase 5 fields:
        categories: options?.categories,
        tags: options?.tags,
        categoryNames: options?.categoryNames,
        tagNames: options?.tagNames,
        authorId: options?.authorId,
        canonicalUrl: options?.canonicalUrl,
        schemaJson: options?.schemaJson,
        featuredImage: options?.featuredImage,
        scheduledDate: options?.scheduledDate,
      };


      // ===== Strategy 1: Try local/Cloudflare proxy first (only if it returns JSON) =====
      try {
        const res = await fetch('/api/wordpress-publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(body),
        });

        const contentType = res.headers.get('content-type') || '';
        // If route is missing on host, SPA returns text/html — skip to Supabase fallback
        if (!contentType.includes('application/json')) {
          console.warn('[WordPressPublish] /api/wordpress-publish unavailable (non-JSON response). Using Supabase Edge Function.');
          throw new Error('__FALLBACK__');
        }

        const json = await res.json().catch(() => null);

        if (json?.success) {
          const post = json.post as Record<string, unknown> | undefined;
          const result: PublishResult = {
            success: true,
            postId: post?.id as number | undefined,
            postUrl: (post?.url || post?.link) as string | undefined,
          };
          setPublishResult(result);
          return result;
        }

        if (json?.error) {
          const errorMsg = String(json.error);
          if (res.status === 401 || errorMsg.includes('Authentication') || errorMsg.includes('authentication')) {
            throw new Error('WordPress authentication failed. Check your username and application password in Setup.');
          }
          if (res.status === 403) {
            throw new Error('Permission denied. Ensure the WordPress user has publishing capabilities.');
          }
          if (res.status === 404 && errorMsg.includes('REST API')) {
            throw new Error('WordPress REST API not found. Ensure permalinks are enabled.');
          }
          throw new Error(errorMsg);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === '__FALLBACK__') {
          // Intentional fallback to Supabase
        } else if (msg.includes('authentication') || msg.includes('Permission') || msg.includes('REST API') || msg.includes('not configured')) {
          throw e;
        } else {
          console.warn('[WordPressPublish] Server proxy failed, falling back to Supabase:', msg);
        }
      }

      // ===== Strategy 2: Supabase Edge Function via direct fetch (bypass supabase-js) =====
      const { url: sbUrl, anonKey: sbKey, configured } = getSupabaseConfig();

      let data: Record<string, unknown> | null = null;
      let lastError: Error | null = null;

      if (configured) {
        const fnUrl = `${sbUrl.replace(/\/+$/, '')}/functions/v1/wordpress-publish`;
        const maxAttempts = 2;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 90_000);
            let res: Response;
            try {
              res = await fetch(fnUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                  'apikey': sbKey,
                  'Authorization': `Bearer ${sbKey}`,
                  'x-client-info': 'wp-content-optimizer-pro',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
              });
            } finally {
              clearTimeout(timeoutId);
            }

            const text = await res.text();
            try {
              data = JSON.parse(text);
            } catch {
              throw new Error(
                `Edge Function returned non-JSON (${res.status}). The function may not be deployed. ` +
                `Response: ${text.slice(0, 200)}`
              );
            }
            break;
          } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            const msg = lastError.message || '';
            if (attempt < maxAttempts - 1) {
              await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
              continue;
            }
            if (msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('network') || msg.toLowerCase().includes('abort')) {
              console.warn('[WordPressPublish] Edge Function unreachable, attempting direct WP REST publish:', msg);
              data = null;
            } else {
              throw lastError;
            }
          }
        }
      }

      // ===== Strategy 3: Direct WordPress REST API from browser (last resort) =====
      if (!data) {
        try {
          const wpBase = (config.wpUrl.startsWith('http') ? config.wpUrl : `https://${config.wpUrl}`).replace(/\/+$/, '');
          const auth = btoa(`${config.wpUsername}:${config.wpAppPassword}`);
          const apiUrl = `${wpBase}/wp-json/wp/v2/posts`;

          // Try to find existing post by slug
          let existingId: number | null = options?.existingPostId ?? null;
          if (!existingId && safeSlug) {
            try {
              const sr = await fetch(`${apiUrl}?slug=${encodeURIComponent(safeSlug)}&status=any`, {
                headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
              });
              if (sr.ok) {
                const arr = await sr.json();
                if (Array.isArray(arr) && arr.length > 0) existingId = arr[0].id;
              }
            } catch { /* ignore */ }
          }

          const postData: Record<string, unknown> = {
            title, content, status: options?.status || 'draft',
          };
          if (options?.excerpt) postData.excerpt = options.excerpt;
          if (safeSlug) postData.slug = safeSlug;
          if (options?.metaDescription || options?.seoTitle) {
            postData.meta = {
              _yoast_wpseo_metadesc: options.metaDescription || '',
              _yoast_wpseo_title: options.seoTitle || title,
              rank_math_description: options.metaDescription || '',
              rank_math_title: options.seoTitle || title,
            };
          }

          const targetUrl = existingId ? `${apiUrl}/${existingId}` : apiUrl;
          const wpRes = await fetch(targetUrl, {
            method: existingId ? 'PUT' : 'POST',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(postData),
          });

          const wpText = await wpRes.text();
          let wpJson: any = {};
          try { wpJson = JSON.parse(wpText); } catch { /* */ }

          if (!wpRes.ok) {
            const errMsg = wpJson?.message || `WordPress error (${wpRes.status})`;
            if (wpRes.status === 401) throw new Error('WordPress authentication failed. Check username and application password.');
            if (wpRes.status === 403) throw new Error('Permission denied. Ensure the WordPress user has publishing capabilities.');
            throw new Error(errMsg);
          }

          data = {
            success: true,
            post: { id: wpJson.id, url: wpJson.link, link: wpJson.link, status: wpJson.status, slug: wpJson.slug },
          };
        } catch (directErr) {
          const dMsg = directErr instanceof Error ? directErr.message : String(directErr);
          if (dMsg.toLowerCase().includes('failed to fetch') || dMsg.toLowerCase().includes('cors')) {
            throw new Error(
              'Failed to publish: Edge Function unreachable AND direct browser publish blocked by CORS. ' +
              `Original error: ${lastError?.message || 'unknown'}. ` +
              'Fix: ensure the Supabase Edge Function "wordpress-publish" is deployed, OR enable CORS for the WP REST API on your site.'
            );
          }
          throw directErr;
        }
      }

      if (!data?.success) {
        const serverError = (data?.error as string) || '';
        const statusCode = data?.status as number;
        let errorMsg = serverError || lastError?.message || 'Failed to publish to WordPress';

        if (statusCode === 401 || serverError.includes('Authentication')) {
          errorMsg = 'WordPress authentication failed. Check your username and application password in Setup.';
        } else if (statusCode === 403) {
          errorMsg = 'Permission denied. Ensure the WordPress user has publishing capabilities.';
        } else if (statusCode === 404) {
          errorMsg = 'WordPress REST API not found. Ensure permalinks are enabled.';
        }

        throw new Error(errorMsg);
      }

      const post = data.post as Record<string, unknown> | undefined;
      const result: PublishResult = {
        success: true,
        postId: post?.id as number | undefined,
        postUrl: (post?.url || post?.link) as string | undefined,
      };

      // Phase 1: best-effort persistence to content memory
      if (options?.draftId && options?.siteId) {
        recordPublish({
          draft_id: options.draftId,
          site_id: options.siteId,
          status: 'success',
          wp_post_id: result.postId ?? null,
          wp_url: result.postUrl ?? null,
          response: data,
          html: content,
        }).catch((e) => console.warn('[ContentMemory] recordPublish failed:', e));
      }

      setPublishResult(result);
      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const result: PublishResult = {
        success: false,
        error: errorMsg,
      };
      if (options?.draftId && options?.siteId) {
        recordPublish({
          draft_id: options.draftId,
          site_id: options.siteId,
          status: 'error',
          error: errorMsg,
        }).catch((e) => console.warn('[ContentMemory] recordPublish (error) failed:', e));
      }
      setPublishResult(result);
      return result;
    } finally {
      setIsPublishing(false);
    }
  }, [config]);

  const clearResult = useCallback(() => {
    setPublishResult(null);
  }, []);

  return {
    publish,
    isPublishing,
    publishResult,
    clearResult,
    isConfigured: !!(config.wpUrl && config.wpUsername && config.wpAppPassword),
  };
}
