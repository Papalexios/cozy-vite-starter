// src/components/optimizer/PerformanceFeedbackPanel.tsx
// Phase 6 — Performance Feedback Loop UI
//
// Self-contained panel: pick a site → see decay, refresh calendar,
// topical authority, and ROI cards. Best-effort: silently degrades
// when Supabase / GSC data isn't yet populated.

import { useEffect, useMemo, useState } from "react";
import { withSupabase } from "@/lib/supabaseClient";
import {
  detectDecay, type DecayItem,
  buildRefreshCalendar, type RefreshCandidate,
  scoreTopicalAuthority, type TopicalAuthorityReport,
  computeRoi, type RoiReport,
} from "@/lib/feedback";
import { TrendingDown, TrendingUp, Activity, RefreshCw, Layers, Target, AlertTriangle } from "lucide-react";
import { useCallback, useRef } from "react";

interface SiteOption { id: string; name: string; wp_url: string }
interface PublishLogLite { id: string; draft_id: string; wp_url: string | null; published_at: string }

export function PerformanceFeedbackPanel() {
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [siteId, setSiteId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [decay, setDecay] = useState<DecayItem[]>([]);
  const [calendar, setCalendar] = useState<RefreshCandidate[]>([]);
  const [authority, setAuthority] = useState<TopicalAuthorityReport | null>(null);
  const [rois, setRois] = useState<RoiReport[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Load sites
  useEffect(() => {
    (async () => {
      const list = await withSupabase(async (sb) => {
        const { data, error } = await sb.from("sites").select("id,name,wp_url").order("created_at", { ascending: false });
        if (error) throw error;
        return (data ?? []) as SiteOption[];
      }, [] as SiteOption[]);
      setSites(list);
      if (list.length && !siteId) setSiteId(list[0].id);
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load all signals when site changes
  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const [d, c, a, recentPublishes] = await Promise.all([
          detectDecay({ site_id: siteId }),
          buildRefreshCalendar({ site_id: siteId, limit: 15 }),
          scoreTopicalAuthority({ site_id: siteId, persist: false }),
          withSupabase(async (sb) => {
            const { data, error } = await sb.from("publish_logs")
              .select("id,draft_id,wp_url,published_at")
              .eq("site_id", siteId)
              .eq("status", "success")
              .order("published_at", { ascending: false })
              .limit(8);
            if (error) throw error;
            return (data ?? []) as PublishLogLite[];
          }, [] as PublishLogLite[]),
        ]);
        if (cancelled) return;
        setDecay(d); setCalendar(c); setAuthority(a);

        const roiList = await Promise.all(
          recentPublishes.filter((p) => p.wp_url).map((p) =>
            computeRoi({ draft_id: p.draft_id, site_id: siteId, page_url: p.wp_url!, publishedAt: p.published_at })
              .catch(() => null)
          )
        );
        if (!cancelled) setRois(roiList.filter((r): r is RoiReport => !!r));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [siteId]);

  const decayedCount = decay.length;
  const highSeverity = useMemo(() => decay.filter((d) => d.severity === "high").length, [decay]);

  if (!sites.length) {
    return (
      <div className="rounded-xl border border-border/50 bg-card/40 p-6 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 mb-2 text-foreground font-medium">
          <Activity className="w-4 h-4" /> Performance Feedback Loop
        </div>
        Connect Lovable Cloud and add a site to start tracking performance over time.
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" /> Performance Feedback Loop
          </h2>
          <p className="text-xs text-muted-foreground">Decay detection, refresh calendar, topical authority and ROI per draft.</p>
        </div>
        <select
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          className="bg-background border border-border rounded-lg px-3 py-1.5 text-sm"
        >
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Top KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={<TrendingDown className="w-4 h-4" />} label="Pages decayed (28d)" value={String(decayedCount)} sub={`${highSeverity} high severity`} tone={decayedCount > 0 ? "warn" : "ok"} />
        <Kpi icon={<RefreshCw className="w-4 h-4" />} label="Refresh backlog" value={String(calendar.length)} sub="prioritised" tone="info" />
        <Kpi icon={<Layers className="w-4 h-4" />} label="Topical authority" value={authority ? `${authority.score}/100` : "—"} sub={authority ? `${authority.distinctQueries} queries` : "no GSC yet"} tone="info" />
        <Kpi icon={<Target className="w-4 h-4" />} label="Ranking pages" value={authority ? `${authority.rankingPages}/${authority.totalPages || "?"}` : "—"} sub="indexed coverage" tone="info" />
      </div>

      {/* Refresh calendar */}
      <Card title="Refresh calendar" subtitle="Pages most worth rewriting next, scored from decay + opportunities + age." loading={loading}>
        {calendar.length === 0 ? (
          <Empty>No refresh candidates yet. Import GSC data and run a sitemap crawl to populate this list.</Empty>
        ) : (
          <ul className="divide-y divide-border/50">
            {calendar.map((c) => (
              <li key={c.page_url} className="py-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground truncate">
                    {c.title || c.page_url}
                  </div>
                  <a href={c.page_url} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground truncate block hover:text-primary">{c.page_url}</a>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {c.reasons.slice(0, 4).map((r, i) => (
                      <span key={i} className="text-[10px] uppercase tracking-wide bg-muted/50 text-muted-foreground px-1.5 py-0.5 rounded">{r}</span>
                    ))}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-bold text-primary">{c.score}</div>
                  <div className="text-[10px] uppercase text-muted-foreground">{c.recommendedAction.replace("_", " ")}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Decay list */}
      <Card title="Decay detector" subtitle="Position drops ≥ 3 or impressions down ≥ 20% vs prior 28 days." loading={loading}>
        {decay.length === 0 ? (
          <Empty>No decay detected. Either everything's healthy or no historical GSC/ranking data has been imported yet.</Empty>
        ) : (
          <ul className="divide-y divide-border/50">
            {decay.slice(0, 10).map((d, i) => (
              <li key={i} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <a href={d.page_url} target="_blank" rel="noreferrer" className="text-foreground hover:text-primary truncate block">{d.page_url}</a>
                  <div className="text-xs text-muted-foreground">
                    {d.kind === "position_drop"
                      ? `Avg position ${d.previous} → ${d.current}`
                      : `Impressions ${d.previous} → ${d.current} (${(d.delta * 100).toFixed(0)}%)`}
                  </div>
                </div>
                <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${
                  d.severity === "high" ? "bg-destructive/20 text-destructive" :
                  d.severity === "medium" ? "bg-amber-500/20 text-amber-400" :
                  "bg-muted/40 text-muted-foreground"
                }`}>{d.severity}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ROI cards */}
      <Card title="ROI — recently published" subtitle="Before/after deltas vs 28-day pre-publish baseline." loading={loading}>
        {rois.length === 0 ? (
          <Empty>No ROI data yet. Publish a draft (with Lovable Cloud + GSC connected) to start tracking before/after impact.</Empty>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {rois.map((r) => (
              <div key={r.draft_id} className="rounded-lg border border-border/50 bg-card/40 p-3 space-y-2">
                <a href={r.page_url} target="_blank" rel="noreferrer" className="text-sm font-medium text-foreground hover:text-primary truncate block">{r.page_url}</a>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.daysSincePublish}d since publish</div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <Delta label="Impressions" delta={r.delta.impressions} current={r.current.impressions} />
                  <Delta label="Clicks" delta={r.delta.clicks} current={r.current.clicks} />
                  <Delta label="CTR" delta={r.delta.ctr} current={r.current.ctr} format={(n) => `${(n * 100).toFixed(2)}%`} />
                  <Delta label="Position" delta={r.delta.position} current={r.current.position} positiveBetter />
                </div>
                {!r.baseline && <div className="text-[10px] text-amber-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> No pre-publish baseline captured.</div>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Top gaps */}
      {authority && authority.topGaps.length > 0 && (
        <Card title="Top GSC queries" subtitle="Highest-impression queries you currently surface for.">
          <div className="flex flex-wrap gap-1.5">
            {authority.topGaps.map((q) => (
              <span key={q} className="text-xs bg-muted/40 text-foreground/90 px-2 py-1 rounded">{q}</span>
            ))}
          </div>
        </Card>
      )}
    </section>
  );
}

// ─── Tiny presentational helpers ───────────────────────────────────────
function Kpi({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: "ok" | "warn" | "info" }) {
  const toneCls = tone === "warn" ? "text-amber-400" : tone === "ok" ? "text-emerald-400" : "text-primary";
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3">
      <div className={`flex items-center gap-1.5 text-xs ${toneCls}`}>{icon}<span className="uppercase tracking-wide">{label}</span></div>
      <div className="mt-1 text-xl font-bold text-foreground">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Card({ title, subtitle, children, loading }: { title: string; subtitle?: string; children: React.ReactNode; loading?: boolean }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card/40 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {loading && <RefreshCw className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-muted-foreground py-3">{children}</div>;
}

function Delta({ label, delta, current, format, positiveBetter }: { label: string; delta: number; current: number; format?: (n: number) => string; positiveBetter?: boolean }) {
  const fmt = format ?? ((n) => Math.round(n).toString());
  const good = positiveBetter ? delta > 0 : delta > 0;
  const bad = positiveBetter ? delta < 0 : delta < 0;
  return (
    <div className="flex items-center justify-between rounded bg-background/40 px-2 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-medium flex items-center gap-1">
        {fmt(current)}
        {delta !== 0 && (
          <span className={`text-[10px] flex items-center ${good ? "text-emerald-400" : bad ? "text-destructive" : "text-muted-foreground"}`}>
            {good ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {fmt(Math.abs(delta))}
          </span>
        )}
      </span>
    </div>
  );
}
