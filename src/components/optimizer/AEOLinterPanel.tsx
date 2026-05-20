// src/components/optimizer/AEOLinterPanel.tsx
// Phase 9 — AEO Snippet-Bait Linter UI.
// Re-lints the active draft HTML on every render. Shows score, issue list
// grouped by severity, and a "Run auto-fix" button (wired by the parent).

import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Info, Sparkles, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { lintSnippetBait, type LintIssue, type LintReport, type LintSeverity } from '@/lib/sota/aeo/snippetBaitLinter';

interface Props {
  html: string;
  onAutoFix?: () => void;
  isFixing?: boolean;
}

const SEVERITY_META: Record<LintSeverity, { label: string; cls: string; Icon: typeof Info }> = {
  error: { label: 'error', cls: 'text-red-400 border-red-500/30 bg-red-500/10', Icon: XCircle },
  warn:  { label: 'warn',  cls: 'text-amber-400 border-amber-500/30 bg-amber-500/10', Icon: AlertTriangle },
  info:  { label: 'info',  cls: 'text-sky-400 border-sky-500/30 bg-sky-500/10', Icon: Info },
};

function scoreColor(score: number): string {
  if (score >= 85) return 'text-emerald-400';
  if (score >= 65) return 'text-amber-400';
  return 'text-red-400';
}

export function AEOLinterPanel({ html, onAutoFix, isFixing }: Props) {
  const report: LintReport = useMemo(() => lintSnippetBait(html || ''), [html]);

  const errors = report.issues.filter((i) => i.severity === 'error');
  const warns  = report.issues.filter((i) => i.severity === 'warn');
  const infos  = report.issues.filter((i) => i.severity === 'info');

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5 space-y-5">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            AEO Snippet-Bait Linter
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Live audit for paragraph-snippet, voice-search, and AI-Overview eligibility.
          </p>
        </div>
        <div className="text-right">
          <div className={cn("text-3xl font-black tabular-nums leading-none", scoreColor(report.score))}>
            {report.score}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">AEO score</div>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <Stat label="Sections" value={report.totalSections} />
        <Stat label="Direct-answer leads" value={`${report.sectionsWithLeadAnswer}/${report.totalSections}`} />
        <Stat label="TL;DR present" value={report.hasTLDR ? 'Yes' : 'No'} ok={report.hasTLDR} />
        <Stat label="Issues" value={report.issues.length} />
      </div>

      {onAutoFix && (
        <button
          onClick={onAutoFix}
          disabled={isFixing || errors.length + warns.length === 0}
          className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-gradient-to-r from-primary to-emerald-500 text-white text-sm font-semibold disabled:opacity-40 hover:brightness-110 transition flex items-center justify-center gap-2"
        >
          <Sparkles className="w-4 h-4" />
          {isFixing ? 'Rewriting leads…' : `Auto-fix ${Math.min(8, errors.length + warns.length)} lead paragraph(s)`}
        </button>
      )}

      {report.issues.length === 0 ? (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 flex items-center gap-3 text-emerald-300">
          <CheckCircle2 className="w-5 h-5" />
          <span className="text-sm">No issues detected. Article is snippet-bait ready.</span>
        </div>
      ) : (
        <div className="space-y-2">
          {[...errors, ...warns, ...infos].slice(0, 30).map((issue, idx) => (
            <IssueRow key={`${issue.rule}-${idx}`} issue={issue} />
          ))}
          {report.issues.length > 30 && (
            <p className="text-xs text-muted-foreground italic">…and {report.issues.length - 30} more.</p>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, ok }: { label: string; value: number | string; ok?: boolean }) {
  return (
    <div className="rounded-lg border border-white/10 bg-background/40 p-3">
      <div className={cn("text-base font-bold tabular-nums", ok === false ? "text-amber-400" : "text-foreground")}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function IssueRow({ issue }: { issue: LintIssue }) {
  const meta = SEVERITY_META[issue.severity];
  return (
    <div className={cn("rounded-lg border p-3 flex gap-3", meta.cls)}>
      <meta.Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider">{issue.rule.replace(/-/g, ' ')}</p>
          <span className="text-[10px] opacity-70">H{issue.headingLevel} · {meta.label}</span>
        </div>
        <p className="text-sm font-medium text-foreground/90 mt-1 truncate">{issue.headingText}</p>
        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{issue.excerpt}</p>
        <p className="text-[11px] mt-2 opacity-80">→ {issue.recommendation}</p>
      </div>
    </div>
  );
}

export default AEOLinterPanel;
