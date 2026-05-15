// src/hooks/useJobProgress.ts
// Phase 3 — subscribe to a single content_jobs row over Supabase Realtime.
// Falls back to a 3s poll if realtime isn't available.

import { useEffect, useState } from 'react';
import { getSupabaseClient, isSupabaseConfigured } from '@/lib/supabaseClient';
import { JobQueue } from '@/lib/db/jobQueue';
import type { ContentJobRow } from '@/lib/db/types';

export function useJobProgress(jobId: string | null | undefined) {
  const [job, setJob] = useState<ContentJobRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId || !isSupabaseConfigured) return;
    let cancelled = false;

    // initial fetch
    JobQueue.get(jobId).then((row) => { if (!cancelled) setJob(row); }).catch((e) => {
      if (!cancelled) setError(String(e?.message ?? e));
    });

    const sb = getSupabaseClient();
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let channel: ReturnType<typeof sb.channel> | null = null;

    try {
      channel = sb
        .channel(`content_job_${jobId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'content_jobs', filter: `id=eq.${jobId}` },
          (payload) => {
            const next = (payload.new ?? null) as ContentJobRow | null;
            if (next) setJob(next);
          },
        )
        .subscribe();
    } catch {
      // ignore — fall back to polling
    }

    pollTimer = setInterval(() => {
      JobQueue.get(jobId).then((row) => { if (!cancelled && row) setJob(row); }).catch(() => {});
    }, 3000);

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (channel) { try { sb.removeChannel(channel); } catch { /* noop */ } }
    };
  }, [jobId]);

  const isTerminal = !!job && ['done', 'error', 'cancelled'].includes(job.status);

  return { job, error, isTerminal };
}
