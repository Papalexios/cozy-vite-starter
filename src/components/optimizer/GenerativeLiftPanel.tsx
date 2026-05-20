// src/components/optimizer/GenerativeLiftPanel.tsx
// Phase 7 — surfaces Information Gain reports from the persisted store.
// Shows lift score, blindspots, missing entities, and contrarian angles
// for every generated article that has an `informationGain` payload.

import { useMemo, useState } from "react";
import { useContentStore } from "@/lib/store";
import { Sparkles, AlertTriangle, Target, Lightbulb, Database } from "lucide-react";

function scoreColor(score: number) {
  if (score >= 80) return "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
  if (score >= 60) return "text-amber-400 bg-amber-500/10 border-amber-500/30";
  return "text-rose-400 bg-rose-500/10 border-rose-500/30";
}

export function GenerativeLiftPanel() {
  const generated = useContentStore((s) => s.generatedContentsStore);
  const [openItemId, setOpenItemId] = useState<string | null>(null);

  const items = useMemo(() => {
    return Object.entries(generated)
      .filter(([, c]) => !!c?.informationGain)
      .map(([id, c]) => ({ id, title: c.title || c.primaryKeyword, ig: c.informationGain! }))
      .sort((a, b) => b.ig.liftScore - a.ig.liftScore);
  }, [generated]);

  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No Information Gain reports yet.</p>
        <p className="text-xs mt-1 opacity-70">
          Generate content to see GEO lift analysis vs. top SERP competitors.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-emerald-400" />
          <h3 className="text-lg font-semibold">Generative Lift Analysis</h3>
        </div>
        <span className="text-xs text-muted-foreground">{items.length} article(s)</span>
      </div>

      <p className="text-xs text-muted-foreground">
        How much unique signal your draft adds vs. the top SERP results
        (semantic diff against cached competitor embeddings).
      </p>

      <div className="space-y-2">
        {items.map(({ id, title, ig }) => {
          const isOpen = openItemId === id;
          return (
            <div key={id} className="border border-border rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenItemId(isOpen ? null : id)}
                className="w-full p-4 flex items-center justify-between gap-4 hover:bg-muted/40 transition-colors text-left"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{title}</div>
                  <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
                    <span>{ig.blindspots.length} blindspots</span>
                    <span>{ig.missingEntities.length} missing entities</span>
                    <span>{ig.contrarianAngles.length} unique angles</span>
                    {ig.cached && (
                      <span className="inline-flex items-center gap-1 text-emerald-400">
                        <Database className="w-3 h-3" /> cache hit
                      </span>
                    )}
                  </div>
                </div>
                <div
                  className={`px-3 py-1.5 rounded-lg border text-sm font-bold tabular-nums ${scoreColor(
                    ig.liftScore
                  )}`}
                >
                  {ig.liftScore}/100
                </div>
              </button>

              {isOpen && (
                <div className="p-4 bg-muted/20 border-t border-border space-y-4 text-sm">
                  {ig.contrarianAngles.length > 0 && (
                    <Section
                      icon={<Lightbulb className="w-4 h-4 text-amber-400" />}
                      title="Unique Angles (No Competitor Covers These)"
                      tone="amber"
                    >
                      <ul className="space-y-1.5 list-disc list-inside">
                        {ig.contrarianAngles.map((a, i) => (
                          <li key={i} className="text-foreground/90">{a}</li>
                        ))}
                      </ul>
                    </Section>
                  )}

                  {ig.missingEntities.length > 0 && (
                    <Section
                      icon={<Target className="w-4 h-4 text-sky-400" />}
                      title="Missing Entities"
                      tone="sky"
                    >
                      <div className="flex flex-wrap gap-1.5">
                        {ig.missingEntities.map((e, i) => (
                          <span
                            key={i}
                            className="px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/30 text-xs"
                          >
                            {e.name}
                          </span>
                        ))}
                      </div>
                    </Section>
                  )}

                  {ig.blindspots.length > 0 && (
                    <Section
                      icon={<AlertTriangle className="w-4 h-4 text-rose-400" />}
                      title="Competitor Topics Your Draft Misses"
                      tone="rose"
                    >
                      <ul className="space-y-1.5 list-disc list-inside">
                        {ig.blindspots.slice(0, 8).map((b, i) => (
                          <li key={i} className="text-foreground/80">{b}</li>
                        ))}
                      </ul>
                    </Section>
                  )}

                  {ig.competitorUrls.length > 0 && (
                    <div className="pt-2 border-t border-border/50">
                      <div className="text-xs text-muted-foreground mb-1.5">
                        Compared against {ig.competitorUrls.length} top-ranking pages:
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {ig.competitorUrls.slice(0, 6).map((u, i) => (
                          <a
                            key={i}
                            href={u}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-emerald-400 hover:underline truncate max-w-[200px]"
                          >
                            {new URL(u).hostname.replace(/^www\./, "")}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  tone,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  tone: "amber" | "sky" | "rose";
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h4 className={`text-xs font-semibold uppercase tracking-wide text-${tone}-400`}>{title}</h4>
      </div>
      <div>{children}</div>
    </div>
  );
}
