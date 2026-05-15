// src/lib/jobs/BrowserJobWorker.ts
// Phase 3 — singleton in-browser worker that claims and runs THIS user's queued
// content_jobs. Survives navigation and tab refreshes (re-attaches to whichever
// 'running' job is still owned by this worker_id).
//
// IMPORTANT: This is a co-operative client worker, not a server runner. It uses
// the same RLS-protected RPCs (`claim_next_content_job`, `heartbeat`, …) as a
// future Deno/pg_cron runner — so server-side execution can replace it later
// without changing the protocol.

import { JobQueue, type JobProgress } from '@/lib/db/jobQueue';
import type { ContentJobRow } from '@/lib/db/types';
import { isSupabaseConfigured } from '@/lib/supabaseClient';

type JobHandler = (job: ContentJobRow, ctx: JobContext) => Promise<JobProgress | void>;

export interface JobContext {
  /** Push progress to DB; throttled. */
  report(progress: JobProgress): Promise<void>;
  /** True once the user has requested cancellation. */
  isCancelled(): Promise<boolean>;
  /** Throw a CancelledError if cancelled (use between phases). */
  throwIfCancelled(): Promise<void>;
}

export class CancelledError extends Error {
  constructor() { super('Job cancelled'); this.name = 'CancelledError'; }
}

const HEARTBEAT_MS = 15_000;
const POLL_MS = 5_000;

class BrowserJobWorker {
  private workerId: string;
  private handlers = new Map<string, JobHandler>();
  private running = false;
  private currentJob: ContentJobRow | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgress: JobProgress = {};

  constructor() {
    // Stable per-tab id, persisted so a reload can resume its own running job.
    const KEY = 'wpco_worker_id';
    let id: string | null = null;
    try { id = localStorage.getItem(KEY); } catch { /* ignore */ }
    if (!id) {
      id = `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
    }
    this.workerId = id;
  }

  get id() { return this.workerId; }

  /** Register a handler for a given job.type. */
  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  /** Start the polling loop. Safe to call multiple times. */
  start() {
    if (this.running || !isSupabaseConfigured) return;
    this.running = true;
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    this.stopHeartbeat();
  }

  private async tick() {
    if (!this.running) return;
    try {
      if (!this.currentJob) {
        const job = await JobQueue.claim(this.workerId);
        if (job) {
          this.currentJob = job;
          this.startHeartbeat();
          // Fire-and-forget; tick() will resume polling after completion.
          this.runJob(job).catch((e) => console.error('[BrowserJobWorker] runJob fatal', e));
        }
      }
    } catch (err) {
      console.warn('[BrowserJobWorker] claim failed', err);
    } finally {
      this.pollTimer = setTimeout(() => this.tick(), POLL_MS);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.currentJob) return;
      JobQueue.heartbeat(this.currentJob.id, this.lastProgress).catch(() => {});
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private async runJob(job: ContentJobRow) {
    const handler = this.handlers.get(job.type);
    const ctx: JobContext = {
      report: async (progress) => {
        this.lastProgress = { ...this.lastProgress, ...progress };
        await JobQueue.heartbeat(job.id, this.lastProgress);
      },
      isCancelled: async () => JobQueue.isCancelRequested(job.id),
      throwIfCancelled: async () => {
        if (await JobQueue.isCancelRequested(job.id)) throw new CancelledError();
      },
    };

    try {
      if (!handler) {
        await JobQueue.fail(job.id, `No handler registered for job type "${job.type}"`, false);
        return;
      }
      const finalProgress = await handler(job, ctx);
      await JobQueue.complete(job.id, finalProgress ?? this.lastProgress);
    } catch (err) {
      if (err instanceof CancelledError) {
        // Mark explicitly cancelled (don't retry).
        await JobQueue.fail(job.id, 'Cancelled by user', false);
      } else {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error('[BrowserJobWorker] job failed', job.id, msg);
        await JobQueue.fail(job.id, msg, true);
      }
    } finally {
      this.stopHeartbeat();
      this.currentJob = null;
      this.lastProgress = {};
    }
  }
}

// Export a process-wide singleton.
export const browserJobWorker = new BrowserJobWorker();
