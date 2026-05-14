// Publish & Verification checklist panel.
// Lists exact steps for Google Search Console verification, plus a one-click
// "Verify live meta tag" button that fetches the deployed homepage through the
// Cloudflare proxy and confirms the google-site-verification meta tag is present.

import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CheckCircle2, Circle, ExternalLink, Loader2, ShieldCheck,
  XCircle, Globe, Settings2,
} from "lucide-react";

const HOMEPAGE = "https://contentoptimizer.app/";
const EXPECTED_TOKEN = "dMprgB-sgfze8mqCfHSXQOOJEcy_LlqTa3FFUWyRGcQ";

type CheckState = "idle" | "checking" | "ok" | "missing" | "error";

interface Step {
  title: string;
  detail: string;
  href?: string;
  hrefLabel?: string;
}

const STEPS: Step[] = [
  {
    title: "Click Publish → Update in Lovable",
    detail:
      "Frontend changes (including the verification meta tag in index.html) only go live after you publish. Publish first, then verify.",
  },
  {
    title: "Confirm the meta tag is live on your homepage",
    detail:
      "Use the button below — it fetches https://contentoptimizer.app/ and looks for <meta name=\"google-site-verification\" …>. Must succeed before Google can verify.",
  },
  {
    title: "Open Google Search Console",
    detail:
      "Sign in with the Google account you want to own the property, then add a new property of type \"URL prefix\" using https://contentoptimizer.app/.",
    href: "https://search.google.com/search-console/welcome",
    hrefLabel: "Open Search Console",
  },
  {
    title: "Choose the HTML tag verification method",
    detail:
      "Google will show you a meta tag — it should match the one already in this app's <head>. Click Verify; Google fetches your homepage and confirms.",
  },
  {
    title: "Submit your sitemap",
    detail:
      "After verification, go to Sitemaps and submit https://contentoptimizer.app/sitemap.xml. You can also do this from the in-app Search Console page once the connector is linked.",
    href: "/search-console",
    hrefLabel: "Open in-app Search Console",
  },
];

export default function PublishVerificationChecklist() {
  const [check, setCheck] = useState<CheckState>("idle");
  const [foundToken, setFoundToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const verifyLive = async () => {
    setCheck("checking");
    setError(null);
    setFoundToken(null);
    try {
      const res = await fetch(`/api/proxy?url=${encodeURIComponent(HOMEPAGE)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Proxy returned ${res.status}`);
      }
      const html = await res.text();
      const match = html.match(
        /<meta[^>]+name=["']google-site-verification["'][^>]+content=["']([^"']+)["']/i,
      );
      if (match?.[1]) {
        setFoundToken(match[1]);
        setCheck("ok");
        toast.success(
          match[1] === EXPECTED_TOKEN
            ? "Meta tag is live and matches expected token."
            : "Meta tag is live (different token than the one in code).",
        );
      } else {
        setCheck("missing");
        toast.warning("No google-site-verification meta tag found on the live homepage. Did you publish?");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setCheck("error");
      toast.error(msg);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-card/50 p-6 space-y-5">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold">Publish & Search Console verification</h2>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/domain-verification"
            className="text-xs inline-flex items-center gap-1 text-primary hover:underline"
          >
            <Globe className="w-3.5 h-3.5" /> How verification works
          </Link>
          <Link
            to="/search-console"
            className="text-xs inline-flex items-center gap-1 text-primary hover:underline"
          >
            <Settings2 className="w-3.5 h-3.5" /> Settings
          </Link>
        </div>
      </header>

      <ol className="space-y-3">
        {STEPS.map((s, i) => (
          <li key={i} className="flex gap-3 p-3 rounded-lg bg-muted/20 border border-border/40">
            <div className="mt-0.5">
              <Circle className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">
                {i + 1}. {s.title}
              </div>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{s.detail}</p>
              {s.href && (
                s.href.startsWith("/") ? (
                  <Link to={s.href} className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1">
                    {s.hrefLabel} <ExternalLink className="w-3 h-3" />
                  </Link>
                ) : (
                  <a
                    href={s.href} target="_blank" rel="noreferrer"
                    className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1"
                  >
                    {s.hrefLabel} <ExternalLink className="w-3 h-3" />
                  </a>
                )
              )}
            </div>
          </li>
        ))}
      </ol>

      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-bold">After-publish check</div>
            <div className="text-xs text-muted-foreground">
              Fetches the live homepage and confirms the verification meta tag is present.
            </div>
          </div>
          <button
            onClick={verifyLive}
            disabled={check === "checking"}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {check === "checking" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ShieldCheck className="w-4 h-4" />
            )}
            Verify live meta tag
          </button>
        </div>

        {check === "ok" && foundToken && (
          <div className="flex items-start gap-2 text-xs p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-semibold">Meta tag is live on {HOMEPAGE}</div>
              <div className="font-mono break-all opacity-80 mt-1">content="{foundToken}"</div>
              {foundToken !== EXPECTED_TOKEN && (
                <div className="mt-1 text-amber-300">
                  Note: token differs from the one in this codebase ({EXPECTED_TOKEN}). That's fine if Google issued you a new one.
                </div>
              )}
            </div>
          </div>
        )}

        {check === "missing" && (
          <div className="flex items-start gap-2 text-xs p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300">
            <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              No <code className="font-mono">google-site-verification</code> meta tag found.
              The change isn't live yet — click <strong>Publish → Update</strong> in Lovable, wait ~30s, then re-run this check.
            </div>
          </div>
        )}

        {check === "error" && error && (
          <div className="flex items-start gap-2 text-xs p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300">
            <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </section>
  );
}
