// src/pages/Status.tsx
// Live health-check page for NeuronWriter proxy, WordPress, AI models.
import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, XCircle, Loader2, AlertTriangle, ArrowLeft, PlayCircle, ShieldCheck, ExternalLink, GitCompare, RefreshCw, Database } from "lucide-react";
import { useOptimizerStore } from "@/lib/store";
import { NeuronWriterService } from "@/lib/sota/NeuronWriterService";
import { createSOTAEngine } from "@/lib/sota/SOTAContentGenerationEngine";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabaseClient";
import {
  getLatestFactCheckReport,
  loadPersistedFactCheckReport,
  subscribeFactCheckReport,
  recheckClaim,
  wordDiff,
  type FactCheckReport,
  type FactCheckClaim,
  type FactCheckOutcome,
  type DiffOp,
} from "@/lib/sota/FactCheckReport";

type CheckStatus = "idle" | "running" | "ok" | "warn" | "error";
interface CheckResult {
  status: CheckStatus;
  latencyMs?: number;
  message?: string;
  detail?: string;
  raw?: unknown;
}

const initial: CheckResult = { status: "idle" };

const StatusBadge = ({ s }: { s: CheckStatus }) => {
  const map: Record<CheckStatus, { c: string; t: string; icon: JSX.Element }> = {
    idle: { c: "bg-muted/40 text-muted-foreground border-muted-foreground/20", t: "Idle", icon: <span className="w-2 h-2 rounded-full bg-muted-foreground/40" /> },
    running: { c: "bg-sky-500/10 text-sky-300 border-sky-500/30", t: "Running", icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> },
    ok: { c: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30", t: "Healthy", icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
    warn: { c: "bg-amber-500/10 text-amber-300 border-amber-500/30", t: "Warning", icon: <AlertTriangle className="w-3.5 h-3.5" /> },
    error: { c: "bg-red-500/10 text-red-300 border-red-500/30", t: "Error", icon: <XCircle className="w-3.5 h-3.5" /> },
  };
  const m = map[s];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${m.c}`}>
      {m.icon}
      {m.t}
    </span>
  );
};

const Card = ({
  title, subtitle, result, children, action,
}: {
  title: string; subtitle?: string; result: CheckResult;
  children?: React.ReactNode; action?: React.ReactNode;
}) => (
  <div className="rounded-2xl border border-border/60 bg-card/40 backdrop-blur p-5 space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      <StatusBadge s={result.status} />
    </div>
    {result.message && (
      <p className={`text-sm ${result.status === "error" ? "text-red-300" : result.status === "warn" ? "text-amber-300" : "text-muted-foreground"}`}>
        {result.message}
      </p>
    )}
    {typeof result.latencyMs === "number" && (
      <p className="text-xs text-muted-foreground">Latency: {result.latencyMs} ms</p>
    )}
    {result.detail && (
      <pre className="text-xs bg-black/40 border border-border/40 rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap break-words text-muted-foreground">{result.detail}</pre>
    )}
    {children}
    {action && <div className="pt-1">{action}</div>}
  </div>
);

const Btn = ({ onClick, disabled, children, variant = "primary" }: { onClick: () => void; disabled?: boolean; children: React.ReactNode; variant?: "primary" | "ghost" }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
      variant === "primary"
        ? "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        : "bg-muted/40 text-foreground hover:bg-muted/60 disabled:opacity-50"
    }`}
  >
    {children}
  </button>
);

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, latencyMs: Math.round(performance.now() - start) };
}

const Status = () => {
  const { config } = useOptimizerStore();

  const [cfProxy, setCfProxy] = useState<CheckResult>(initial);
  const [sbProxy, setSbProxy] = useState<CheckResult>(initial);
  const [nwE2E, setNwE2E] = useState<CheckResult>(initial);
  const [wpRoot, setWpRoot] = useState<CheckResult>(initial);
  const [wpAuth, setWpAuth] = useState<CheckResult>(initial);
  const [models, setModels] = useState<Record<string, CheckResult>>({});
  const [migrations, setMigrations] = useState<Record<string, CheckResult>>({});

  // ── NeuronWriter proxy probes ──────────────────────────────────────────────
  async function probeProxy(url: string, setter: (r: CheckResult) => void) {
    setter({ status: "running" });
    try {
      const apiKey = config.neuronWriterApiKey;
      if (!apiKey) {
        setter({ status: "warn", message: "No NeuronWriter API key configured. Add it in Setup." });
        return;
      }
      const { result, latencyMs } = await timed(async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(url.includes("supabase") && config.supabaseAnonKey
              ? { Authorization: `Bearer ${config.supabaseAnonKey}`, apikey: config.supabaseAnonKey }
              : {}),
          },
          body: JSON.stringify({ endpoint: "/list-projects", method: "POST", apiKey, body: {} }),
        });
        const text = await res.text();
        return { res, text };
      });
      const { res, text } = result;
      const looksHtml = /^\s*<(!doctype|html)/i.test(text);
      if (looksHtml) {
        setter({ status: "error", latencyMs, message: "Proxy not deployed (returned HTML/SPA fallback).", detail: text.slice(0, 400) });
        return;
      }
      let parsed: any = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      if (!res.ok || parsed?.success === false) {
        setter({
          status: "error",
          latencyMs,
          message: `HTTP ${res.status} · ${parsed?.error || "Proxy reported failure"}`,
          detail: typeof parsed === "string" ? parsed.slice(0, 600) : JSON.stringify(parsed, null, 2).slice(0, 800),
        });
        return;
      }
      const projectCount =
        parsed?.data?.projects?.length ??
        (Array.isArray(parsed?.data) ? parsed.data.length : undefined);
      setter({
        status: "ok",
        latencyMs,
        message: `Proxy reachable. ${projectCount !== undefined ? `${projectCount} project(s) available.` : "NeuronWriter responded."}`,
      });
    } catch (e: any) {
      setter({ status: "error", message: `Network error: ${e?.message || e}` });
    }
  }

  const supabaseProxyUrl = config.supabaseUrl
    ? `${config.supabaseUrl.replace(/\/$/, "")}/functions/v1/neuronwriter-proxy`
    : "";

  // ── NeuronWriter end-to-end test ───────────────────────────────────────────
  async function runNWE2E() {
    if (!config.neuronWriterApiKey) {
      setNwE2E({ status: "warn", message: "Add NeuronWriter API key in Setup first." });
      return;
    }
    setNwE2E({ status: "running", message: "Listing projects…" });
    const svc = new NeuronWriterService({
      neuronWriterApiKey: config.neuronWriterApiKey,
      supabaseUrl: config.supabaseUrl,
      supabaseAnonKey: config.supabaseAnonKey,
    });
    try {
      const proj = await svc.listProjects();
      if (!proj.success || !proj.projects?.length) {
        setNwE2E({ status: "error", message: proj.error || "No projects returned." });
        return;
      }
      const projectId = config.neuronWriterProjectId || proj.projects[0].id;
      const keyword = `sota health ${new Date().toISOString().slice(0, 10)}`;
      setNwE2E({ status: "running", message: `Project ${projectId} · finding/creating query "${keyword}"…` });

      const found = await svc.findQueryByKeyword(projectId, keyword);
      let queryId = found.query?.id;
      if (!queryId) {
        const created = await svc.createQuery(projectId, keyword);
        if (!created.success || !created.query?.id) {
          setNwE2E({ status: "error", message: created.error || "Failed to create query." });
          return;
        }
        queryId = created.query.id;
      }

      // Poll up to 12 times (~60s) for "ready"
      let analysis: any;
      for (let i = 0; i < 12; i++) {
        setNwE2E({ status: "running", message: `Polling analysis (${i + 1}/12)…` });
        const a = await svc.getQueryAnalysis(queryId!);
        if (a.success && (a.analysis?.status === "ready" || (a.analysis?.terms?.length || 0) > 0)) {
          analysis = a.analysis;
          break;
        }
        await new Promise(r => setTimeout(r, 5000));
      }

      if (!analysis) {
        setNwE2E({ status: "warn", message: `Query ${queryId} created but not ready within timeout. Will be ready in NeuronWriter shortly.` });
        return;
      }
      setNwE2E({
        status: "ok",
        message: `End-to-end OK. Project=${projectId} · Query=${queryId} · ${analysis.terms?.length || 0} terms · ${analysis.entities?.length || 0} entities · status=${analysis.status}.`,
        detail: JSON.stringify({
          query_id: queryId,
          status: analysis.status,
          terms: analysis.terms?.slice(0, 5),
          entities: analysis.entities?.slice(0, 5),
          h2: analysis.headingsH2?.slice(0, 3),
        }, null, 2),
      });
    } catch (e: any) {
      setNwE2E({ status: "error", message: e?.message || String(e) });
    }
  }

  // ── WordPress checks ───────────────────────────────────────────────────────
  async function checkWpRoot() {
    if (!config.wpUrl) { setWpRoot({ status: "warn", message: "No WordPress URL configured." }); return; }
    setWpRoot({ status: "running" });
    try {
      const url = `${config.wpUrl.replace(/\/$/, "")}/wp-json/`;
      const { result, latencyMs } = await timed(() => fetch(url, { headers: { Accept: "application/json" } }));
      if (!result.ok) {
        setWpRoot({ status: "error", latencyMs, message: `HTTP ${result.status} from ${url}` });
        return;
      }
      const json: any = await result.json().catch(() => ({}));
      setWpRoot({
        status: "ok",
        latencyMs,
        message: `Site: ${json?.name || "(unknown)"} · WP REST API ${json?.namespaces?.length ? "available" : "reachable"}`,
        detail: JSON.stringify({ name: json?.name, description: json?.description, url: json?.url, namespaces: json?.namespaces?.slice?.(0, 5) }, null, 2),
      });
    } catch (e: any) {
      setWpRoot({ status: "error", message: `Cannot reach WP REST API: ${e?.message || e}` });
    }
  }

  async function checkWpAuth() {
    if (!config.wpUrl || !config.wpUsername || !config.wpAppPassword) {
      setWpAuth({ status: "warn", message: "Need WP URL + username + Application Password." });
      return;
    }
    setWpAuth({ status: "running" });
    try {
      const url = `${config.wpUrl.replace(/\/$/, "")}/wp-json/wp/v2/users/me?context=edit`;
      const auth = btoa(`${config.wpUsername}:${config.wpAppPassword}`);
      const { result, latencyMs } = await timed(() =>
        fetch(url, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } })
      );
      const text = await result.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch {}
      if (!result.ok) {
        setWpAuth({
          status: "error",
          latencyMs,
          message: `Auth failed: HTTP ${result.status} · ${body?.code || ""} ${body?.message || ""}`.trim(),
          detail: typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body, null, 2).slice(0, 600),
        });
        return;
      }
      const caps = body?.capabilities || {};
      const canPublish = caps.publish_posts || caps.edit_posts || body?.roles?.includes?.("administrator");
      setWpAuth({
        status: canPublish ? "ok" : "warn",
        latencyMs,
        message: `Authenticated as ${body?.name || body?.slug} (${(body?.roles || []).join(", ") || "no roles"}). ${canPublish ? "Publish capability detected." : "Missing publish capability."}`,
      });
    } catch (e: any) {
      setWpAuth({ status: "error", message: `Network error: ${e?.message || e}` });
    }
  }

  // ── AI Model probes ────────────────────────────────────────────────────────
  const providers: { key: keyof typeof config; label: string; check: () => Promise<CheckResult> }[] = [
    {
      key: "openrouterApiKey", label: "OpenRouter",
      check: async () => {
        if (!config.openrouterApiKey) return { status: "warn", message: "No API key set." };
        try {
          const { result, latencyMs } = await timed(() =>
            fetch("https://openrouter.ai/api/v1/auth/key", { headers: { Authorization: `Bearer ${config.openrouterApiKey}` } })
          );
          const j = await result.json().catch(() => ({}));
          if (!result.ok) return { status: "error", latencyMs, message: `HTTP ${result.status}`, detail: JSON.stringify(j).slice(0, 400) };
          return { status: "ok", latencyMs, message: `Key valid · model: ${config.openrouterModelId}`, detail: JSON.stringify(j?.data || j, null, 2).slice(0, 500) };
        } catch (e: any) { return { status: "error", message: e?.message }; }
      },
    },
    {
      key: "groqApiKey", label: "Groq",
      check: async () => {
        if (!config.groqApiKey) return { status: "warn", message: "No API key set." };
        try {
          const { result, latencyMs } = await timed(() =>
            fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${config.groqApiKey}` } })
          );
          if (!result.ok) return { status: "error", latencyMs, message: `HTTP ${result.status}` };
          const j = await result.json().catch(() => ({}));
          const has = (j?.data || []).some((m: any) => m.id === config.groqModelId);
          return { status: has ? "ok" : "warn", latencyMs, message: has ? `Model ${config.groqModelId} available.` : `Key valid but model ${config.groqModelId} not found.` };
        } catch (e: any) { return { status: "error", message: e?.message }; }
      },
    },
    {
      key: "openaiApiKey", label: "OpenAI",
      check: async () => {
        if (!config.openaiApiKey) return { status: "warn", message: "No API key set." };
        try {
          const { result, latencyMs } = await timed(() =>
            fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${config.openaiApiKey}` } })
          );
          if (!result.ok) return { status: "error", latencyMs, message: `HTTP ${result.status}` };
          return { status: "ok", latencyMs, message: "Key valid." };
        } catch (e: any) { return { status: "error", message: e?.message }; }
      },
    },
    {
      key: "anthropicApiKey", label: "Anthropic",
      check: async () => {
        if (!config.anthropicApiKey) return { status: "warn", message: "No API key set." };
        // Anthropic blocks browser CORS; presence-only check.
        return { status: "ok", message: "Key present (browser CORS blocks live ping; key will be used server-side)." };
      },
    },
    {
      key: "geminiApiKey", label: "Gemini",
      check: async () => {
        if (!config.geminiApiKey) return { status: "warn", message: "No API key set." };
        try {
          const { result, latencyMs } = await timed(() =>
            fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.geminiApiKey)}`)
          );
          if (!result.ok) return { status: "error", latencyMs, message: `HTTP ${result.status}` };
          const j = await result.json().catch(() => ({}));
          return { status: "ok", latencyMs, message: `Key valid · ${j?.models?.length || 0} models available.` };
        } catch (e: any) { return { status: "error", message: e?.message }; }
      },
    },
  ];

  async function runAllModels() {
    setModels(Object.fromEntries(providers.map(p => [p.label, { status: "running" } as CheckResult])));
    const entries = await Promise.all(providers.map(async p => [p.label, await p.check()] as const));
    setModels(Object.fromEntries(entries));
  }

  const autoRanRef = useRef(false);
  const [factReport, setFactReport] = useState<FactCheckReport | null>(
    () => getLatestFactCheckReport() || loadPersistedFactCheckReport()
  );
  useEffect(() => {
    document.title = "Status — Integrations Health · WP Content Optimizer PRO";
    const desc = "Live health checks for the NeuronWriter proxy, WordPress REST connection, AI gateway, and fact-check reports.";
    let tag = document.querySelector('meta[name="description"]');
    if (!tag) { tag = document.createElement("meta"); tag.setAttribute("name", "description"); document.head.appendChild(tag); }
    tag.setAttribute("content", desc);
    const unsub = subscribeFactCheckReport(setFactReport);
    if (autoRanRef.current) return unsub;
    autoRanRef.current = true;
    runAll();
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAll() {
    probeProxy("/api/neuronwriter", setCfProxy);
    if (supabaseProxyUrl) probeProxy(supabaseProxyUrl, setSbProxy);
    else setSbProxy({ status: "warn", message: "No Supabase URL configured. Add it in Setup to enable the fallback proxy." });
    checkWpRoot();
    checkWpAuth();
    runAllModels();
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 backdrop-blur bg-background/70 border-b border-border/50">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
          <h1 className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">System Status</h1>
          <Btn onClick={runAll}><PlayCircle className="w-4 h-4" /> Run all checks</Btn>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        <section>
          <h2 className="text-2xl font-bold mb-1">Health checks</h2>
          <p className="text-sm text-muted-foreground">
            Live diagnostics for every external dependency. Errors below are exactly what the engine sees at runtime.
          </p>
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">NeuronWriter</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <Card
              title="Cloudflare proxy"
              subtitle="POST /api/neuronwriter → list-projects"
              result={cfProxy}
              action={<Btn onClick={() => probeProxy("/api/neuronwriter", setCfProxy)}>Probe Cloudflare proxy</Btn>}
            />
            <Card
              title="Supabase edge function (fallback)"
              subtitle={supabaseProxyUrl || "Configure Supabase URL in Setup"}
              result={sbProxy}
              action={
                <Btn
                  disabled={!supabaseProxyUrl}
                  onClick={() => probeProxy(supabaseProxyUrl, setSbProxy)}
                >
                  Probe Supabase proxy
                </Btn>
              }
            />
          </div>
          <Card
            title="End-to-end NeuronWriter test"
            subtitle="Lists projects → finds/creates a query → polls until analysis is ready (publish-ready data)."
            result={nwE2E}
            action={<Btn onClick={runNWE2E}>Run E2E NeuronWriter test</Btn>}
          />
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">WordPress</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <Card
              title="REST API root"
              subtitle="GET /wp-json/"
              result={wpRoot}
              action={<Btn onClick={checkWpRoot}>Check REST API</Btn>}
            />
            <Card
              title="Authenticated user"
              subtitle="GET /wp-json/wp/v2/users/me (Application Password)"
              result={wpAuth}
              action={<Btn onClick={checkWpAuth}>Check publish credentials</Btn>}
            />
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">AI Models</h3>
          <div className="grid md:grid-cols-2 gap-4">
            {providers.map(p => (
              <Card
                key={p.label}
                title={p.label}
                subtitle={
                  p.label === "OpenRouter" ? `Model: ${config.openrouterModelId}` :
                  p.label === "Groq" ? `Model: ${config.groqModelId}` :
                  p.label === "Gemini" ? "Google Generative Language API" :
                  `${p.label} API key`
                }
                result={models[p.label] || initial}
                action={<Btn variant="ghost" onClick={async () => {
                  setModels(m => ({ ...m, [p.label]: { status: "running" } }));
                  const r = await p.check();
                  setModels(m => ({ ...m, [p.label]: r }));
                }}>Check {p.label}</Btn>}
              />
            ))}
          </div>
          <Btn onClick={runAllModels}>Check all model providers</Btn>
        </section>

        <FactCheckSection report={factReport} />
      </main>
    </div>
  );
};

// ── Fact-check report section ───────────────────────────────────────────────
const outcomeStyle: Record<FactCheckOutcome, { label: string; cls: string }> = {
  kept:       { label: "Kept",       cls: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" },
  corrected:  { label: "Corrected",  cls: "bg-sky-500/10 text-sky-300 border-sky-500/30" },
  softened:   { label: "Softened",   cls: "bg-amber-500/10 text-amber-300 border-amber-500/30" },
  removed:    { label: "Removed",    cls: "bg-red-500/10 text-red-300 border-red-500/30" },
  unverified: { label: "Unverified", cls: "bg-muted/40 text-muted-foreground border-muted-foreground/20" },
};

const FactCheckSection = ({ report }: { report: FactCheckReport | null }) => {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <ShieldCheck className="w-4 h-4" /> Live fact-check (latest run)
      </h3>

      {!report && (
        <div className="rounded-2xl border border-border/60 bg-card/40 backdrop-blur p-6 text-sm text-muted-foreground">
          No fact-check has run yet. Generate an article — the orchestrator's Phase 7c will populate this section
          with the up-to-6 highest-stakes claims, the live web sources used to verify them, and whether the final
          HTML kept, corrected, softened, or removed each one. Serper queries are cached per claim for 24 hours
          to cut cost and latency on subsequent runs.
        </div>
      )}

      {report && (
        <div className="rounded-2xl border border-border/60 bg-card/40 backdrop-blur p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm">
                <span className="text-muted-foreground">Keyword:</span>{" "}
                <span className="font-medium text-foreground">{report.keyword || "—"}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(report.generatedAt).toLocaleString()} · Scanned {report.totalParagraphsScanned} paragraphs ·
                Detected {report.candidatesDetected} candidates · Checked {report.claimsChecked} ·
                Cached {report.claims.filter(c => c.cached).length}/{report.claims.length}
              </p>
            </div>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
              report.reconciled ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                                : "bg-amber-500/10 text-amber-300 border-amber-500/30"
            }`}>
              {report.reconciled ? "Reconciled" : "Not reconciled"}
            </span>
          </div>

          {report.notes && (
            <p className="text-xs text-muted-foreground italic">{report.notes}</p>
          )}

          {report.claims.length === 0 && (
            <p className="text-sm text-muted-foreground">No claim paragraphs were extracted.</p>
          )}

          <ol className="space-y-3">
            {report.claims.map((c) => (
              <ClaimRow key={c.index} claim={c} />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
};

// ── Single claim row with diff + re-check ──────────────────────────────────
const ClaimRow = ({ claim }: { claim: FactCheckClaim }) => {
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const o = outcomeStyle[claim.outcome];

  const before = (claim.originalParagraphHtml || "")
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const after = (claim.finalText ||
    (claim.finalParagraphHtml || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  );
  const hasDiff = !!before && before !== after;

  async function onRecheck() {
    setBusy(true);
    setMsg("Calling Serper + reconciliation…");
    try {
      const report = getLatestFactCheckReport();
      const apiKeys = (report?.apiKeys || {}) as any;
      // Build a fresh engine from the in-memory report's apiKeys snapshot.
      const engine = createSOTAEngine(apiKeys);
      const r = await recheckClaim({ index: claim.index, engine });
      setMsg(r.message || (r.ok ? "Done." : "Failed."));
    } catch (e: any) {
      setMsg(`Error: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-border/40 bg-black/20 p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-foreground leading-relaxed">
          <span className="text-muted-foreground mr-1">#{claim.index + 1}</span>
          {claim.claim.length > 320 ? `${claim.claim.slice(0, 320)}…` : claim.claim}
        </p>
        <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${o.cls}`}>
          {o.label}
        </span>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {claim.cached ? "cache hit" : "live Serper"} · {claim.latencyMs ?? 0} ms · {claim.sources.length} source(s)
        {claim.recheckedAt && (
          <> · re-checked {new Date(claim.recheckedAt).toLocaleTimeString()}</>
        )}
      </p>

      {claim.sources.length > 0 && (
        <ul className="space-y-1">
          {claim.sources.map((s, i) => (
            <li key={i} className="text-xs">
              <a href={s.link} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200">
                <ExternalLink className="w-3 h-3" />
                {s.title || s.link}
              </a>
              {s.snippet && (
                <p className="text-muted-foreground mt-0.5 line-clamp-2">{s.snippet}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => setShowDiff(s => !s)}
          disabled={!hasDiff && claim.outcome !== "removed"}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border border-border/50 bg-muted/30 text-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed"
          title={hasDiff ? "Show word-level diff" : "No textual change"}
        >
          <GitCompare className="w-3 h-3" />
          {showDiff ? "Hide diff" : "Show diff"}
        </button>
        <button
          type="button"
          onClick={onRecheck}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border border-sky-500/30 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Re-check this claim
        </button>
        {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
      </div>

      {showDiff && (
        <div className="grid md:grid-cols-2 gap-3 pt-2">
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-[10px] uppercase tracking-wider text-red-300 mb-1">Draft</p>
            <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap break-words">
              {before || <em className="text-muted-foreground">— empty —</em>}
            </p>
          </div>
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
            <p className="text-[10px] uppercase tracking-wider text-emerald-300 mb-1">Reconciled</p>
            <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap break-words">
              {after
                ? <DiffInline ops={wordDiff(before, after)} />
                : <em className="text-muted-foreground">— removed from final article —</em>}
            </p>
          </div>
        </div>
      )}
    </li>
  );
};

const DiffInline = ({ ops }: { ops: DiffOp[] }) => (
  <>
    {ops.map((op, i) => {
      if (op.type === "equal")  return <span key={i}>{op.text}</span>;
      if (op.type === "insert") return <span key={i} className="bg-emerald-500/20 text-emerald-200 rounded px-0.5">{op.text}</span>;
      return <span key={i} className="bg-red-500/20 text-red-200 line-through rounded px-0.5">{op.text}</span>;
    })}
  </>
);

export default Status;
