// src/components/optimizer/cluster/ClusterPlannerModal.tsx
// Phase 10 — Root-topic input → plans pillar + spokes → renders ReactFlow canvas.

import { useState } from 'react';
import { Loader2, Network, Sparkles, X, Save } from 'lucide-react';
import { toast } from 'sonner';
import { useOptimizerStore } from '@/lib/store';
import { planCluster } from '@/lib/sota/clusters/ClusterPlanner';
import { buildLinkMatrix, embedCluster } from '@/lib/sota/clusters/LinkMatrix';
import type { ClusterLink, TopicCluster } from '@/lib/sota/clusters/ClusterTypes';
import { ClusterRepository } from '@/lib/db/clusterRepository';
import { isSupabaseConfigured } from '@/lib/supabaseClient';
import { ClusterCanvas } from './ClusterCanvas';

export function ClusterPlannerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = (useOptimizerStore() as any).config || {};
  const apiKeys = {
    geminiApiKey: config.geminiApiKey,
    openaiApiKey: config.openaiApiKey,
    anthropicApiKey: config.anthropicApiKey,
    openrouterApiKey: config.openrouterApiKey,
    groqApiKey: config.groqApiKey,
    serperApiKey: config.serperApiKey,
  };
  const selectedModel = config.defaultModel || 'gemini';
  const [rootTopic, setRootTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [spokes, setSpokes] = useState(10);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [cluster, setCluster] = useState<TopicCluster | null>(null);
  const [links, setLinks] = useState<ClusterLink[]>([]);

  if (!open) return null;

  const handlePlan = async () => {
    if (!rootTopic.trim()) {
      toast.error('Enter a root topic');
      return;
    }
    setLoading(true);
    setSavedId(null);
    try {
      const planned = await planCluster({
        rootTopic: rootTopic.trim(),
        audience: audience.trim() || undefined,
        spokes,
        apiKeys: apiKeys || {},
        model: (selectedModel as any) || 'gemini',
      });
      const embedded = await embedCluster(planned);
      const matrix = buildLinkMatrix(embedded);
      setCluster(embedded);
      setLinks(matrix);
      toast.success(`Planned 1 pillar + ${embedded.nodes.length - 1} spokes`);
    } catch (e: any) {
      toast.error(`Plan failed: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!cluster) return;
    if (!isSupabaseConfigured()) {
      toast.error('Connect Supabase in Setup to persist clusters.');
      return;
    }
    setSaving(true);
    try {
      const saved = await ClusterRepository.save(cluster);
      if (!saved) {
        toast.error('Save failed — check that migration 005 has been run in Supabase.');
        return;
      }
      setSavedId(saved.id);
      setCluster(saved);
      toast.success('Cluster saved.');
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-3xl shadow-2xl w-full max-w-6xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-card/95 backdrop-blur border-b border-border px-6 py-4 flex items-center justify-between rounded-t-3xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">
              <Network className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-foreground">Topical Cluster Planner</h2>
              <p className="text-xs text-muted-foreground">Pillar + spokes with cosine-linked internal anchors</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Root topic</label>
              <input
                value={rootTopic}
                onChange={(e) => setRootTopic(e.target.value)}
                placeholder="e.g. AI for B2B SaaS marketing"
                className="w-full px-4 py-3 bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Spokes</label>
              <input
                type="number"
                min={4}
                max={20}
                value={spokes}
                onChange={(e) => setSpokes(Number(e.target.value) || 10)}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Audience (optional)</label>
            <input
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="e.g. mid-market SaaS marketers"
              className="w-full px-4 py-3 bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <button
            onClick={handlePlan}
            disabled={loading || !rootTopic.trim()}
            className="w-full px-6 py-3.5 bg-primary text-primary-foreground font-bold rounded-xl hover:brightness-110 disabled:opacity-50 transition flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
            {loading ? 'Planning + embedding…' : 'Plan cluster'}
          </button>

          {cluster && (
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-foreground truncate">{cluster.rootTopic}</h3>
                  {cluster.summary && <p className="text-xs text-muted-foreground line-clamp-2">{cluster.summary}</p>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-xs text-muted-foreground">{links.length} links · {cluster.nodes.length} nodes</div>
                  <button
                    onClick={handleSave}
                    disabled={saving || !!savedId}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 transition"
                  >
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    {savedId ? 'Saved' : saving ? 'Saving…' : 'Save cluster'}
                  </button>
                </div>
              </div>
              <ClusterCanvas cluster={cluster} links={links} />
              <details className="rounded-xl border border-border bg-background/40 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-foreground">Spoke list</summary>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {cluster.nodes.filter((n) => n.kind === 'spoke').map((n) => (
                    <li key={n.id} className="flex items-start gap-2">
                      <span className="text-primary mt-0.5">•</span>
                      <span><span className="text-foreground font-medium">{n.title}</span> — <span className="font-mono text-[10px]">{n.targetKeyword}</span></span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
