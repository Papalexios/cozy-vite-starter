// Google Search Console integration page.
// Shows connector state, last-attempt time, retry countdown with exponential backoff,
// manual sitemap submission, and lets the user reuse an existing linked connector.

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { getSupabase } from "@/lib/supabaseClient";
import {
  CheckCircle2, XCircle, Clock, RefreshCw, Send, Link2,
  AlertTriangle, ArrowLeft, Globe, Loader2,
} from "lucide-react";

type ConnState = "idle" | "checking" | "connected" | "rate_limited" | "not_configured" | "error";

interface StatusResp {
  configured: boolean;
  ok?: boolean;
  outcome?: string;
  latency_ms?: number;
  rateLimited?: boolean;
  error?: string;
}

interface SiteEntry { siteUrl: string; permissionLevel?: string }

const DEFAULT_SITE = "https://contentoptimizer.app/";
const DEFAULT_SITEMAP = "https://contentoptimizer.app/sitemap.xml";
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 min
const INITIAL_BACKOFF_MS = 2_000;

function fmtTime(ts: number | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}
function fmtDuration(ms: number) {
  if (ms <= 0) return "0s";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

export default function SearchConsole() {
  const [state, setState] = useState<ConnState>("idle");
  const [statusData, setStatusData] = useState<StatusResp | null>(null);
  const [lastAttempt, setLastAttempt] = useState<number | null>(null);
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [sites, setSites] = useState<SiteEntry[]>([]);
  const [siteUrl, setSiteUrl] = useState(DEFAULT_SITE);
  const [sitemapUrl, setSitemapUrl] = useState(DEFAULT_SITEMAP);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    document.title = "Search Console — Integration · WP Content Optimizer PRO";
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", "Connect Google Search Console, submit your sitemap, and monitor integration status with automatic retry on rate limits.");
  }, []);

  // tick every second for countdown
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const callProxy = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is not configured. Add credentials in Setup & Config.");
    const { data, error } = await client.functions.invoke("gsc-proxy", {
      body: { action, ...payload },
    });
    if (error) throw new Error(error.message || "Edge function error");
    return data as any;
  }, []);

  const checkStatus = useCallback(async (manual = false) => {
    setState("checking");
    setLastAttempt(Date.now());
    attemptRef.current += 1;
    try {
      const data: StatusResp = await callProxy("status");
      setStatusData(data);
      if (!data.configured) {
        setState("not_configured");
        backoffRef.current = INITIAL_BACKOFF_MS;
        setNextRetryAt(null);
        return;
      }
      if (data.rateLimited || /rate.?limit/i.test(data.error ?? "")) {
        setState("rate_limited");
        const wait = Math.min(backoffRef.current, MAX_BACKOFF_MS);
        const next = Date.now() + wait;
        setNextRetryAt(next);
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => checkStatus(false), wait);
        if (manual) toast.warning(`Rate limited. Retrying in ${fmtDuration(wait)}.`);
        return;
      }
      if (data.ok || data.outcome === "verified" || data.outcome === "skipped") {
        setState("connected");
        backoffRef.current = INITIAL_BACKOFF_MS;
        setNextRetryAt(null);
        // Load sites in background
        try {
          const s = await callProxy("listSites");
          setSites(s.sites ?? []);
        } catch { /* ignore */ }
        if (manual) toast.success("Search Console connected.");
        return;
      }
      setState("error");
      if (manual) toast.error(data.error ?? "Connection check failed.");
    } catch (err) {
      setState("error");
      const msg = err instanceof Error ? err.message : String(err);
      setStatusData({ configured: false, error: msg });
      if (manual) toast.error(msg);
    }
  }, [callProxy]);

  useEffect(() => {
    checkStatus(false);
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelRetry = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setNextRetryAt(null);
    backoffRef.current = INITIAL_BACKOFF_MS;
  };

  const submitSitemap = async () => {
    setSubmitting(true);
    setSubmitResult(null);
    try {
      const feedpath = sitemapUrl.trim();
      const site = siteUrl.trim().endsWith("/") ? siteUrl.trim() : siteUrl.trim() + "/";
      const data = await callProxy("submitSitemap", { siteUrl: site, feedpath });
      if (data?.success) {
        setSubmitResult({ ok: true, msg: `Submitted ${feedpath} to ${site}` });
        toast.success("Sitemap submitted to Google Search Console.");
      } else if (data?.rateLimited) {
        setSubmitResult({ ok: false, msg: "Rate-limited by Google. Retry shortly." });
        toast.warning("Rate-limited. Try again in a minute.");
      } else {
        setSubmitResult({ ok: false, msg: data?.error || "Submission failed." });
        toast.error(data?.error || "Submission failed.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitResult({ ok: false, msg });
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const countdown = nextRetryAt ? Math.max(0, nextRetryAt - now) : 0;

  const stateMeta = useMemo(() => {
    switch (state) {
      case "connected":
        return { label: "Connected", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30", Icon: CheckCircle2 };
      case "rate_limited":
        return { label: "Rate limited", color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/30", Icon: AlertTriangle };
      case "not_configured":
        return { label: "Not connected", color: "text-zinc-300", bg: "bg-zinc-500/10 border-zinc-500/30", Icon: Link2 };
      case "error":
        return { label: "Error", color: "text-red-400", bg: "bg-red-500/10 border-red-500/30", Icon: XCircle };
      case "checking":
        return { label: "Checking…", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/30", Icon: Loader2 };
      default:
        return { label: "Idle", color: "text-zinc-400", bg: "bg-zinc-500/10 border-zinc-500/30", Icon: Clock };
    }
  }, [state]);

  const StatusIcon = stateMeta.Icon;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto p-6 md:p-10 space-y-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
              <ArrowLeft className="w-4 h-4" /> Back to dashboard
            </Link>
            <h1 className="text-3xl font-bold tracking-tight">Google Search Console</h1>
            <p className="text-muted-foreground mt-1">Integration status, retry monitoring & manual sitemap submission.</p>
          </div>
        </header>

        {/* Status card */}
        <section className={`border rounded-2xl p-6 ${stateMeta.bg}`}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <StatusIcon className={`w-7 h-7 ${stateMeta.color} ${state === "checking" ? "animate-spin" : ""}`} />
              <div>
                <div className={`text-lg font-bold ${stateMeta.color}`}>{stateMeta.label}</div>
                <div className="text-xs text-muted-foreground">
                  Last attempt: {fmtTime(lastAttempt)} · Attempts: {attemptRef.current}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => checkStatus(true)}
                disabled={state === "checking"}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${state === "checking" ? "animate-spin" : ""}`} />
                Check now
              </button>
              {nextRetryAt && (
                <button
                  onClick={cancelRetry}
                  className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted/40"
                >
                  Cancel retry
                </button>
              )}
            </div>
          </div>

          {nextRetryAt && (
            <div className="mt-4 p-3 rounded-lg bg-background/50 border border-border/40 text-sm flex items-center justify-between">
              <span className="text-amber-300">Next automatic retry in</span>
              <span className="font-mono font-bold tabular-nums">{fmtDuration(countdown)}</span>
            </div>
          )}

          {statusData?.error && (
            <div className="mt-3 text-xs text-red-300/90 break-words">
              {statusData.error}
            </div>
          )}
        </section>

        {/* Reuse / connect */}
        <section className="border border-border rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Link2 className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-bold">Connection</h2>
          </div>
          {state === "not_configured" ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                No Google Search Console connector is linked to this project. If Google's OAuth is rate-limited,
                wait a few minutes before retrying — your linked connection will be reused automatically once
                available.
              </p>
              <p className="text-sm text-muted-foreground">
                In the Lovable chat, ask: <em>"Connect Google Search Console using my existing connection."</em>
                The connection picker will let you pick an already-linked account instead of starting a new OAuth flow.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Using the linked Google Search Console connector. Verified sites:
              </p>
              {sites.length === 0 ? (
                <div className="text-sm text-muted-foreground italic">No verified sites yet.</div>
              ) : (
                <ul className="divide-y divide-border/40 rounded-lg border border-border/40">
                  {sites.map((s) => (
                    <li key={s.siteUrl} className="flex items-center justify-between p-3 text-sm">
                      <span className="flex items-center gap-2"><Globe className="w-4 h-4 text-muted-foreground" />{s.siteUrl}</span>
                      <button
                        onClick={() => setSiteUrl(s.siteUrl)}
                        className="text-xs text-primary hover:underline"
                      >
                        Use for submission
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        {/* Manual sitemap submission */}
        <section className="border border-border rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Send className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-bold">Submit sitemap manually</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Push your sitemap URL to Google Search Console. Works whenever the connector is linked — independent
            of any in-app OAuth sign-in flow.
          </p>

          <div className="grid gap-3">
            <label className="text-xs font-medium text-muted-foreground">Site (verified property)</label>
            <input
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://contentoptimizer.app/"
              className="w-full px-3 py-2 rounded-lg bg-muted/30 border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <label className="text-xs font-medium text-muted-foreground">Sitemap URL</label>
            <input
              value={sitemapUrl}
              onChange={(e) => setSitemapUrl(e.target.value)}
              placeholder="https://contentoptimizer.app/sitemap.xml"
              className="w-full px-3 py-2 rounded-lg bg-muted/30 border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          <button
            onClick={submitSitemap}
            disabled={submitting || state === "not_configured"}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Submit sitemap
          </button>

          {submitResult && (
            <div
              className={`mt-2 p-3 rounded-lg text-sm border ${
                submitResult.ok
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-red-500/10 border-red-500/30 text-red-300"
              }`}
            >
              {submitResult.msg}
            </div>
          )}

          {state === "not_configured" && (
            <p className="text-xs text-muted-foreground">
              Connect Google Search Console to enable submission.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
