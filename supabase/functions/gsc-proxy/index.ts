// Google Search Console proxy via Lovable connector gateway.
// Supports: status, listSites, submitSitemap, listSitemaps.
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/google_search_console';
const VERIFY_URL = 'https://connector-gateway.lovable.dev/api/v1/verify_credentials';

interface Body {
  action: 'status' | 'listSites' | 'submitSitemap' | 'listSitemaps';
  siteUrl?: string;
  feedpath?: string;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  const GSC_API_KEY = Deno.env.get('GOOGLE_SEARCH_CONSOLE_API_KEY');

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!LOVABLE_API_KEY || !GSC_API_KEY) {
    return json({
      configured: false,
      error: 'Google Search Console connector is not linked to this project.',
    }, body.action === 'status' ? 200 : 503);
  }

  const headers = {
    'Authorization': `Bearer ${LOVABLE_API_KEY}`,
    'X-Connection-Api-Key': GSC_API_KEY,
    'Content-Type': 'application/json',
  };

  try {
    if (body.action === 'status') {
      const r = await fetch(VERIFY_URL, { method: 'POST', headers });
      const data = await r.json().catch(() => ({}));
      const rateLimited = r.status === 429 || /rate.?limit/i.test(JSON.stringify(data));
      return json({
        configured: true,
        ok: r.ok && data?.outcome !== 'failed',
        outcome: data?.outcome,
        latency_ms: data?.latency_ms,
        rateLimited,
        error: data?.error || (!r.ok ? `HTTP ${r.status}` : undefined),
      });
    }

    if (body.action === 'listSites') {
      const r = await fetch(`${GATEWAY_URL}/webmasters/v3/sites`, { headers });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return json({ error: data?.message || `HTTP ${r.status}`, rateLimited: r.status === 429 }, r.status);
      }
      return json({ sites: data?.siteEntry || [] });
    }

    if (body.action === 'submitSitemap') {
      if (!body.siteUrl || !body.feedpath) return json({ error: 'siteUrl and feedpath required' }, 400);
      const site = encodeURIComponent(body.siteUrl);
      const feed = encodeURIComponent(body.feedpath);
      const r = await fetch(
        `${GATEWAY_URL}/webmasters/v3/sites/${site}/sitemaps/${feed}`,
        { method: 'PUT', headers },
      );
      if (!r.ok) {
        const text = await r.text();
        return json({ error: text || `HTTP ${r.status}`, rateLimited: r.status === 429 }, r.status);
      }
      return json({ success: true, siteUrl: body.siteUrl, feedpath: body.feedpath });
    }

    if (body.action === 'listSitemaps') {
      if (!body.siteUrl) return json({ error: 'siteUrl required' }, 400);
      const site = encodeURIComponent(body.siteUrl);
      const r = await fetch(`${GATEWAY_URL}/webmasters/v3/sites/${site}/sitemaps`, { headers });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: data?.message || `HTTP ${r.status}` }, r.status);
      return json({ sitemaps: data?.sitemap || [] });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
