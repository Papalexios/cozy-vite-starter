// src/lib/db/jobQueue.ts
// Phase 3 — typed client wrappers over the job-queue RPCs (migration 002).

import { withSupabase } from '@/lib/supabaseClient';
import type { ContentJobRow, ContentJobType } from './types';

export type JobProgress = {
  phase?: string;
  step?: number;
  totalSteps?: number;
  message?: string;
  pct?: number;
  [k: string]: unknown;
};

export interface EnqueueJobInput {
  site_id: string;
  owner_id: string;
  type: ContentJobType | string;
  config: Record<string, unknown>;
  priority?: number;
  max_attempts?: number;
}

export const JobQueue = {
  /** Insert a new job in `queued` status. Returns null when Supabase isn't configured. */
  enqueue: (input: EnqueueJobInput) => withSupabase(async (sb) => {
    const { data, error } = await sb.from('content_jobs').insert({
      site_id: input.site_id,
      owner_id: input.owner_id,
      type: input.type,
      status: 'queued',
      config: input.config,
      progress: {},
      priority: input.priority ?? 0,
      max_attempts: input.max_attempts ?? 3,
    }).select().single();
    if (error) throw error;
    return data as ContentJobRow;
  }, null),

  /** Atomic FOR UPDATE SKIP LOCKED claim. Returns null if no job available. */
  claim: (workerId: string) => withSupabase(async (sb) => {
    const { data, error } = await sb.rpc('claim_next_content_job', { _worker_id: workerId });
    if (error) throw error;
    // RPC returns a single row (or null when nothing was claimed).
    const row = Array.isArray(data) ? data[0] : data;
    return (row && row.id) ? (row as ContentJobRow) : null;
  }, null),

  heartbeat: (jobId: string, progress?: JobProgress) => withSupabase(async (sb) => {
    const { error } = await sb.rpc('heartbeat_content_job', {
      _job_id: jobId,
      _progress: progress ?? null,
    });
    if (error) throw error;
    return true;
  }, false),

  complete: (jobId: string, progress?: JobProgress) => withSupabase(async (sb) => {
    const { error } = await sb.rpc('complete_content_job', {
      _job_id: jobId,
      _progress: progress ?? null,
    });
    if (error) throw error;
    return true;
  }, false),

  fail: (jobId: string, errorMessage: string, retry = true) => withSupabase(async (sb) => {
    const { error } = await sb.rpc('fail_content_job', {
      _job_id: jobId,
      _error: errorMessage,
      _retry: retry,
    });
    if (error) throw error;
    return true;
  }, false),

  requestCancel: (jobId: string) => withSupabase(async (sb) => {
    const { error } = await sb.rpc('request_cancel_content_job', { _job_id: jobId });
    if (error) throw error;
    return true;
  }, false),

  releaseStale: (staleSeconds = 120) => withSupabase(async (sb) => {
    const { data, error } = await sb.rpc('release_stale_content_jobs', { _stale_seconds: staleSeconds });
    if (error) throw error;
    return (data as number) ?? 0;
  }, 0),

  get: (jobId: string) => withSupabase(async (sb) => {
    const { data, error } = await sb.from('content_jobs').select('*').eq('id', jobId).maybeSingle();
    if (error) throw error;
    return data as ContentJobRow | null;
  }, null),

  /** Has the user requested cancellation while the job was running? */
  isCancelRequested: async (jobId: string): Promise<boolean> => {
    const row = await JobQueue.get(jobId);
    return !!row && (row.status === 'cancelling' || row.status === 'cancelled');
  },
};
