-- =====================================================================
-- Phase 3 — Server-side Pipeline + Job Queue (lite)
-- WP Content Optimizer PRO
--
-- Adds lock/heartbeat columns to public.content_jobs and exposes
-- claim / heartbeat / complete / cancel / release-stale RPCs.
--
-- Apply via Supabase Dashboard → SQL Editor (or psql).
-- Idempotent: safe to re-run.
-- =====================================================================

-- ===== EXTRA COLUMNS ON content_jobs =================================
alter table public.content_jobs
  add column if not exists claimed_by   text,
  add column if not exists claimed_at   timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists attempts     integer not null default 0,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists priority     integer not null default 0;

create index if not exists idx_jobs_queue_pick
  on public.content_jobs (status, priority desc, created_at asc);
create index if not exists idx_jobs_heartbeat
  on public.content_jobs (status, heartbeat_at);

-- Allow a 'cancelling' transient status (CHECK is not enforced — text col).
-- Document the lifecycle:
--   queued → running → done
--                    ↘ error (retryable until attempts>=max_attempts)
--                    ↘ cancelling → cancelled
comment on column public.content_jobs.status is
  'queued | running | done | error | cancelling | cancelled';

-- ===== CLAIM NEXT JOB ================================================
-- SECURITY DEFINER: bypasses RLS so worker (anon/auth) can pick up own jobs.
-- Filtered by owner_id = auth.uid() so each browser only claims its own work.
create or replace function public.claim_next_content_job(_worker_id text)
returns public.content_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  picked public.content_jobs;
begin
  with cte as (
    select id
    from public.content_jobs
    where status = 'queued'
      and owner_id = auth.uid()
      and attempts < max_attempts
    order by priority desc, created_at asc
    for update skip locked
    limit 1
  )
  update public.content_jobs j
     set status       = 'running',
         claimed_by   = _worker_id,
         claimed_at   = now(),
         heartbeat_at = now(),
         started_at   = coalesce(j.started_at, now()),
         attempts     = j.attempts + 1
   from cte
  where j.id = cte.id
  returning j.* into picked;

  return picked;
end;
$$;

-- ===== HEARTBEAT =====================================================
create or replace function public.heartbeat_content_job(_job_id uuid, _progress jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.content_jobs
     set heartbeat_at = now(),
         progress     = coalesce(_progress, progress)
   where id = _job_id
     and owner_id = auth.uid()
     and status   = 'running';
end;
$$;

-- ===== COMPLETE / FAIL ===============================================
create or replace function public.complete_content_job(_job_id uuid, _progress jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.content_jobs
     set status       = 'done',
         progress     = coalesce(_progress, progress),
         finished_at  = now(),
         heartbeat_at = now()
   where id = _job_id
     and owner_id = auth.uid();
end;
$$;

create or replace function public.fail_content_job(_job_id uuid, _error text, _retry boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.content_jobs;
begin
  select * into j from public.content_jobs where id = _job_id and owner_id = auth.uid();
  if not found then return; end if;

  if _retry and j.attempts < j.max_attempts then
    update public.content_jobs
       set status       = 'queued',
           error        = _error,
           claimed_by   = null,
           claimed_at   = null,
           heartbeat_at = now()
     where id = _job_id;
  else
    update public.content_jobs
       set status      = 'error',
           error       = _error,
           finished_at = now()
     where id = _job_id;
  end if;
end;
$$;

-- ===== CANCEL ========================================================
create or replace function public.request_cancel_content_job(_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.content_jobs
     set status = case when status = 'queued' then 'cancelled' else 'cancelling' end,
         finished_at = case when status = 'queued' then now() else finished_at end
   where id = _job_id
     and owner_id = auth.uid()
     and status in ('queued', 'running');
end;
$$;

-- ===== RELEASE STALE (call from pg_cron every minute) ================
-- Re-queues jobs whose worker died (no heartbeat in N seconds).
create or replace function public.release_stale_content_jobs(_stale_seconds integer default 120)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  released integer;
begin
  with upd as (
    update public.content_jobs
       set status       = case
                            when attempts >= max_attempts then 'error'
                            else 'queued'
                          end,
           error        = coalesce(error, '') ||
                          case when error is null then '' else E'\n' end ||
                          'worker stalled (no heartbeat > ' || _stale_seconds || 's)',
           claimed_by   = null,
           claimed_at   = null,
           finished_at  = case when attempts >= max_attempts then now() else finished_at end
     where status = 'running'
       and (heartbeat_at is null or heartbeat_at < now() - make_interval(secs => _stale_seconds))
    returning 1
  )
  select count(*)::int into released from upd;
  return released;
end;
$$;

-- Grants ---------------------------------------------------------------
grant execute on function public.claim_next_content_job(text)               to authenticated;
grant execute on function public.heartbeat_content_job(uuid, jsonb)         to authenticated;
grant execute on function public.complete_content_job(uuid, jsonb)          to authenticated;
grant execute on function public.fail_content_job(uuid, text, boolean)      to authenticated;
grant execute on function public.request_cancel_content_job(uuid)           to authenticated;
grant execute on function public.release_stale_content_jobs(integer)        to authenticated, anon;

-- ===== OPTIONAL: pg_cron schedule (uncomment if pg_cron is enabled) ==
-- create extension if not exists pg_cron;
-- select cron.schedule(
--   'release-stale-content-jobs',
--   '* * * * *',
--   $$ select public.release_stale_content_jobs(120); $$
-- );
