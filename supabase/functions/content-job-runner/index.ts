// supabase/functions/content-job-runner/index.ts
// Phase 3 — server-side maintenance for the content_jobs queue.
//
// Today: scheduled via `pg_cron` (or a CRON-triggered HTTP call), this function
// re-queues jobs whose browser worker died (no heartbeat in N seconds) by
// invoking the `release_stale_content_jobs` RPC. Returns a JSON summary.
//
// Tomorrow: this same endpoint is the natural home for a full server-side
// orchestrator port — it already speaks the queue protocol (claim / heartbeat
// / complete / fail). Until that lands, browsers are the executors.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

interface RunnerRequest {
  staleSeconds?: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) {
      return json({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' }, 500);
    }

    let body: RunnerRequest = {};
    if (req.method === 'POST') {
      try { body = await req.json(); } catch { /* empty body is fine */ }
    }
    const staleSeconds = clampInt(body.staleSeconds ?? 120, 30, 3600);

    const sb = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await sb.rpc('release_stale_content_jobs', { _stale_seconds: staleSeconds });
    if (error) {
      return json({ error: error.message }, 500);
    }

    return json({
      ok: true,
      released: typeof data === 'number' ? data : 0,
      staleSeconds,
      ranAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return json({ error: err?.message ?? String(err) }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function clampInt(n: number, min: number, max: number) {
  const v = Math.floor(Number(n) || 0);
  return Math.max(min, Math.min(max, v));
}
