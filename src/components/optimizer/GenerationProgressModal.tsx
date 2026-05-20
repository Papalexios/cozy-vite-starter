// src/components/optimizer/GenerationProgressModal.tsx
// Phase 8 — Live agent progress modal driven by AgentRunner's AgentEvent stream.
// Pure presentational; pass the events array in.

import { CheckCircle2, Loader2, AlertCircle, Circle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import type { AgentEvent, AgentName } from '@/lib/sota/agents';

interface Props {
  open: boolean;
  events: AgentEvent[];
  onClose?: () => void;
  title?: string;
}

const AGENTS: { id: AgentName; label: string; description: string }[] = [
  { id: 'researcher', label: 'Researcher',  description: 'SERP, references, videos' },
  { id: 'architect',  label: 'Architect',   description: 'Outline, title, FAQs' },
  { id: 'copywriter', label: 'Copywriter',  description: 'Full draft generation' },
  { id: 'critic',     label: 'Critic',      description: 'Self-critique + rewrite' },
];

function statusFor(events: AgentEvent[], agent: AgentName): AgentEvent['status'] {
  const filtered = events.filter((e) => e.agent === agent);
  if (!filtered.length) return 'pending';
  return filtered[filtered.length - 1].status;
}

function StatusIcon({ status }: { status: AgentEvent['status'] }) {
  if (status === 'done')    return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
  if (status === 'running') return <Loader2 className="h-5 w-5 text-primary animate-spin" />;
  if (status === 'error')   return <AlertCircle className="h-5 w-5 text-destructive" />;
  if (status === 'skipped') return <Circle className="h-5 w-5 text-muted-foreground" />;
  return <Circle className="h-5 w-5 text-muted-foreground/40" />;
}

export function GenerationProgressModal({ open, events, onClose, title = 'Generating content' }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 my-4">
          {AGENTS.map((a) => {
            const s = statusFor(events, a.id);
            return (
              <div key={a.id} className="flex items-start gap-3 rounded-lg border bg-card p-3">
                <StatusIcon status={s} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-sm">{a.label}</p>
                    <Badge variant={s === 'done' ? 'default' : 'secondary'} className="text-[10px]">{s}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{a.description}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Event log</p>
          <ScrollArea className="h-64 rounded-md border bg-muted/30 p-3">
            <ul className="space-y-1 font-mono text-[11px]">
              {events.slice().reverse().map((e, idx) => (
                <li key={`${e.timestamp}-${idx}`} className="flex gap-2">
                  <span className="text-muted-foreground/70 shrink-0">
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="font-semibold capitalize shrink-0 w-20">{e.agent}</span>
                  <span className="text-foreground/80">{e.message}</span>
                  {typeof e.elapsedMs === 'number' && (
                    <span className="text-muted-foreground ml-auto shrink-0">{(e.elapsedMs / 1000).toFixed(1)}s</span>
                  )}
                </li>
              ))}
              {events.length === 0 && (
                <li className="text-muted-foreground">Waiting for agents to start…</li>
              )}
            </ul>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default GenerationProgressModal;
