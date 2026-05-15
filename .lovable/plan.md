# WP Content Optimizer PRO — Phased Upgrade Plan

Stack stays: **Vite + React + Lovable Cloud (Supabase) + Cloudflare Pages Functions**. No Next.js/Nest/BullMQ rebuild. Postgres replaces Zustand-as-database. Edge functions + `pg_cron` replace Redis/BullMQ. We extend the existing `wordpress-publish` edge function instead of shipping a PHP plugin (revisit later if needed).

Each phase is shippable on its own. Don't start phase N+1 until N is verified in production.

---

## Phase 1 — Database & Content Memory (foundation)

Goal: every entity the optimizer touches is persisted, multi-site, RLS-protected.

**Tables (Lovable Cloud / Supabase):**
- `sites` — wp_url, name, app_password (encrypted), default_author, owner_id
- `pages` — site_id, url, title, word_count, last_crawled_at, content_hash, health_score
- `keywords` — site_id, page_id?, keyword, intent, target_position, source (manual/gsc/serp)
- `content_jobs` — site_id, type (generate/refresh/godmode), status, config jsonb, error, timestamps
- `drafts` — job_id, page_id?, title, html, meta_description, slug, quality_score jsonb, neuronwriter_query_id, model
- `sources` — draft_id, url, title, domain, authority_score, verified_at, http_status
- `internal_links` — draft_id, anchor, target_url, paragraph_index
- `publish_logs` — draft_id, site_id, wp_post_id, wp_url, status, published_at, response jsonb
- `revisions` — draft_id, version, html, diff_summary, created_at
- `ranking_snapshots` — site_id, keyword_id, position, url, captured_at (daily)
- `gsc_metrics` — site_id, page_url, query, impressions, clicks, ctr, position, date

**RLS:** every table scoped by `owner_id` via `sites.owner_id = auth.uid()`. Roles in separate `user_roles` table per house rules.

**Migration of existing flows:**
- Replace Zustand `persist` for generations/godmode history with Supabase reads/writes (keep Zustand for ephemeral UI state only).
- Wire `EnterpriseContentOrchestrator` final step → insert `drafts` + `sources` + `internal_links`.
- Wire `wordpress-publish` edge function → insert `publish_logs` + create `revisions` row.

**Acceptance:** sign in → see all sites/drafts/publishes across devices; nothing lost on reload.

---

## Phase 2 — Real SEO Data (GSC + sitemap grounding)

Goal: kill model-guessed search volume. Every keyword recommendation is grounded in real signals.

- **Google Search Console** connector (already available). Daily edge function (`pg_cron`) pulls `searchanalytics/query` per site → `gsc_metrics` table. Backfill 16 months on first connect.
- **Sitemap crawl** (existing `crawlSitemap`) → upsert `pages` + `content_hash`. Diff detects changed/stale pages.
- **PageSpeed Insights** edge function on demand → store CWV per page.
- **SERP grounding**: existing `SERPAnalyzer` results persisted to `keywords.serp_snapshot` so we don't re-fetch.
- **Optional later**: DataForSEO/Semrush adapters behind a `KeywordDataProvider` interface.

**UI:** Dashboard widget — "Top GSC opportunities" (high impressions + low CTR + position 5–15). Click → seed a content job.

**Acceptance:** keyword picker shows real impressions/clicks/position from GSC, not model estimates.

---

## Phase 3 — Server-side Pipeline + Job Queue (lite)

Goal: long generations survive browser refresh; God Mode runs without the tab open.

- New edge function `content-job-runner` invoked by `pg_cron` every minute. Picks `content_jobs` where `status='queued'`, claims with `FOR UPDATE SKIP LOCKED`, runs orchestrator phases server-side, updates `status` + `progress` jsonb.
- Orchestrator phases (already standardized 0-9b) become idempotent steps; each writes intermediate state so a crashed job resumes.
- Browser polls `content_jobs` row via Supabase realtime → live progress UI (no more stuck modals).
- Retry/backoff (already in code) moves to runner.
- Cancel button sets `status='cancelling'`; runner checks between phases.

**Acceptance:** start a 6k-word generation, close the tab, come back in 10 min — draft is in DB.

---

## Phase 4 — Fact-Checking & Source Verification

Goal: every factual claim has a verified citation; YMYL gets stricter rules.

Builds on existing `AuthoritativeSourceGate` + `ReferenceService`.
- **Claim extractor** (LLM call): split draft into atomic claims, tag `factual | opinion | definitional`.
- **Evidence binder**: each factual claim must map to ≥1 `sources` row with HTTP-verified URL + domain on whitelist OR live-verified.
- **YMYL mode** (auto-detected from keyword/category): require ≥2 sources per claim, block publish if any unverified.
- **Freshness check**: source `last_modified` < 24mo for time-sensitive topics.
- **Hallucination flags** in Review UI: unsupported claims highlighted in red, user must approve or remove before publish.

**Acceptance:** publishing a draft with unsupported YMYL claim is blocked with actionable diff.

---

## Phase 5 — WordPress Publisher Upgrade (no plugin)

Extend existing `supabase/functions/wordpress-publish`:
- Featured image upload to Media Library (`/wp/v2/media`) with alt/title/caption.
- Categories/tags upsert by name → ID resolution.
- Yoast (`_yoast_wpseo_*`) and Rank Math (`rank_math_*`) meta via REST `meta` field (requires App Password user with `edit_posts` + meta exposure — document fallback).
- Canonical URL + custom excerpt + author mapping.
- Schema injected as Gutenberg `core/html` block at top.
- Scheduled publish via `status=future` + `date`.
- Rollback: re-PUT previous `revisions.html` by version.

**Acceptance:** one click publishes with featured image, Yoast title/desc, categories, schema, canonical — verified in WP admin.

---

## Phase 6 — Performance Feedback Loop (the moat)

Requires Phases 1–2.
- **Decay detector**: weekly job compares `ranking_snapshots` 28-day vs prior 28-day → flag drops ≥3 positions or impressions ≥20% down.
- **CTR opportunity**: GSC position 1–10 with CTR < expected curve → flag for title/meta rewrite.
- **Cannibalization**: same query ranking 2+ URLs on same site → flag merge/canonical.
- **Refresh calendar**: scored backlog of pages to rewrite, surfaced on dashboard.
- **Before/after**: 28 days post-publish, attach `ranking_snapshots` + `gsc_metrics` deltas to the `publish_logs` row → "ROI" card per draft.
- **Topical authority score** per site: coverage of entity graph vs top competitors.

**Acceptance:** dashboard shows "5 pages decayed this week" + "republishing post X gained +12 positions, +340 clicks/mo".

---

## Phase 7 — Schema Strategy Hardening

- Schema type chosen by content-type heuristics: evergreen → `BlogPosting`/`Article`, news → `NewsArticle`, recipe/howto → `HowTo`, product → `Product`. No more blanket `NewsArticle`.
- FAQPage emitted only when site is in allowed verticals (gov/health/etc.) OR user opts in with warning.
- Validate against Google Rich Results Test API in Review step; show errors before publish.

---

## Phase 8 — Testing & CI Hardening

CI already exists (`.github/workflows/ci.yml`). Add:
- Vitest contract tests for each orchestrator phase (fixtures in/out).
- Schema snapshot tests per content type.
- Prompt regression tests (golden output diff threshold).
- Playwright E2E: setup → strategy → review → publish (mock WP).
- Mock WP server for publisher tests.
- Dependency + secret scanning (already partly via `npm audit`).

---

## Sequencing & dependencies

```text
Phase 1 (DB) ──┬─► Phase 3 (Job runner)
               ├─► Phase 2 (GSC) ──► Phase 6 (Feedback loop)
               └─► Phase 5 (WP publisher upgrade)
Phase 4 (Fact-check) parallel to 3, depends on 1.
Phase 7 (Schema) parallel any time after 1.
Phase 8 (CI) parallel throughout.
```

Estimated effort (rough, single agent):
- P1: 1 session  ·  P2: 1 session  ·  P3: 1–2 sessions  ·  P4: 1–2 sessions
- P5: 1 session  ·  P6: 2 sessions  ·  P7: 0.5 session  ·  P8: 1 session

---

## What I will NOT do (per your earlier answers)

- No Next.js / NestJS / BullMQ / Redis rebuild.
- No PHP WordPress plugin (extend edge function instead).
- No new third-party paid SEO API as a hard dependency (GSC is free; SERP/Semrush stay optional behind interface).

---

## Approve to start

Reply **"start phase 1"** (or pick another) and I'll execute that phase only — schema migration, RLS, wiring existing flows to persist. Everything else waits.
