// /domain-verification — explains how to verify the domain in Google Search Console
// and where to find the verification meta tag in this codebase.

import { Link } from "react-router-dom";
import { useEffect } from "react";
import {
  ArrowLeft, ShieldCheck, Code2, ExternalLink, Globe, FileCode2, Settings2,
} from "lucide-react";

const EXPECTED_TOKEN = "dMprgB-sgfze8mqCfHSXQOOJEcy_LlqTa3FFUWyRGcQ";
const HOMEPAGE = "https://contentoptimizer.app/";

export default function DomainVerification() {
  useEffect(() => {
    document.title = "Domain Verification — Google Search Console · WP Content Optimizer PRO";
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute(
      "content",
      "Step-by-step guide to verify contentoptimizer.app in Google Search Console using the HTML meta tag method.",
    );
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto p-6 md:p-10 space-y-8">
        <header>
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
            <ArrowLeft className="w-4 h-4" /> Back to dashboard
          </Link>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="w-7 h-7 text-primary" /> Domain Verification
          </h1>
          <p className="text-muted-foreground mt-2">
            How to prove ownership of <span className="font-mono text-foreground">contentoptimizer.app</span> to
            Google Search Console using the HTML meta-tag method.
          </p>
        </header>

        <section className="rounded-2xl border border-border p-6 space-y-3">
          <h2 className="text-lg font-bold flex items-center gap-2"><Globe className="w-5 h-5 text-primary" /> Why HTML meta tag?</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            DNS TXT records on Lovable-bought domains must be added manually in <strong>Project Settings → Domains
            → ⋯ → Configure → Manage DNS records</strong>. The HTML meta-tag method is equivalent and works
            end-to-end from the app: the tag lives in <code className="font-mono">index.html</code>, ships with
            every deploy, and Google fetches your homepage to verify.
          </p>
        </section>

        <section className="rounded-2xl border border-border p-6 space-y-4">
          <h2 className="text-lg font-bold flex items-center gap-2"><FileCode2 className="w-5 h-5 text-primary" /> Where the meta tag lives</h2>
          <p className="text-sm text-muted-foreground">
            File: <code className="font-mono text-foreground">index.html</code> · inside <code className="font-mono">&lt;head&gt;</code>
          </p>
          <pre className="text-xs bg-muted/30 border border-border/40 rounded-lg p-4 overflow-x-auto font-mono">
{`<meta name="google-site-verification" content="${EXPECTED_TOKEN}" />`}
          </pre>
          <p className="text-xs text-muted-foreground">
            If Google gives you a different token, replace the <code>content</code> value, then publish.
          </p>
        </section>

        <section className="rounded-2xl border border-border p-6 space-y-4">
          <h2 className="text-lg font-bold flex items-center gap-2"><Code2 className="w-5 h-5 text-primary" /> Step-by-step</h2>
          <ol className="space-y-4 text-sm">
            <li>
              <div className="font-semibold">1. Publish the app</div>
              <p className="text-muted-foreground text-xs mt-1">Click <strong>Publish → Update</strong> in Lovable. Frontend changes (including the meta tag) only ship after publishing.</p>
            </li>
            <li>
              <div className="font-semibold">2. Confirm the tag is live</div>
              <p className="text-muted-foreground text-xs mt-1">
                Open <a className="text-primary hover:underline" href={`view-source:${HOMEPAGE}`}>view-source:{HOMEPAGE}</a> and search for
                <code className="font-mono"> google-site-verification</code>. Or use the <Link to="/" className="text-primary hover:underline">After-publish check</Link> button on the dashboard.
              </p>
            </li>
            <li>
              <div className="font-semibold">3. Add the property in Google Search Console</div>
              <p className="text-muted-foreground text-xs mt-1">
                Open{" "}
                <a className="text-primary hover:underline inline-flex items-center gap-1" href="https://search.google.com/search-console/welcome" target="_blank" rel="noreferrer">
                  Search Console <ExternalLink className="w-3 h-3" />
                </a>
                , choose <strong>URL prefix</strong>, and enter <code className="font-mono">{HOMEPAGE}</code>.
              </p>
            </li>
            <li>
              <div className="font-semibold">4. Choose the HTML tag method &amp; verify</div>
              <p className="text-muted-foreground text-xs mt-1">
                Google will show a meta tag. If it matches what's in this app, click <strong>Verify</strong>. If it doesn't, copy
                the new token, paste it into <code className="font-mono">index.html</code>, publish again, then verify.
              </p>
            </li>
            <li>
              <div className="font-semibold">5. Submit your sitemap</div>
              <p className="text-muted-foreground text-xs mt-1">
                In Search Console → Sitemaps, submit <code className="font-mono">{HOMEPAGE}sitemap.xml</code>. Or use the in-app{" "}
                <Link to="/search-console" className="text-primary hover:underline inline-flex items-center gap-1">
                  Search Console page <Settings2 className="w-3 h-3" />
                </Link>
                {" "}to do it once your connector is linked.
              </p>
            </li>
          </ol>
        </section>

        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 space-y-2">
          <h2 className="text-sm font-bold text-amber-300">Troubleshooting</h2>
          <ul className="text-xs text-muted-foreground space-y-1.5 list-disc list-inside">
            <li>Verification fails with "tag not found" → confirm you clicked Publish, then wait 30–60 seconds for the CDN.</li>
            <li>Tag is in code but not on live site → another deploy is pending; re-publish.</li>
            <li>Sign-in rate limited → Google throttles new OAuth users. Reuse an existing connector via the <Link to="/search-console" className="text-primary hover:underline">Search Console settings page</Link> instead.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
