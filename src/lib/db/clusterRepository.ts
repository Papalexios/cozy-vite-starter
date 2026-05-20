// src/lib/db/clusterRepository.ts
// Phase 10 — Persistence for topical clusters (pillar + spokes).
// Best-effort: returns null/[] when Supabase isn't configured.

import { withSupabase } from '@/lib/supabaseClient';
import type { ClusterNode, TopicCluster } from '@/lib/sota/clusters/ClusterTypes';

interface DbCluster {
  id: string;
  site_id: string | null;
  owner_id: string | null;
  root_topic: string;
  pillar_keyword: string;
  summary: string | null;
  created_at: string;
}

interface DbClusterNode {
  id: string;
  cluster_id: string;
  kind: 'pillar' | 'spoke';
  title: string;
  target_keyword: string;
  content_type: string | null;
  intent: string | null;
  status: string;
  draft_id: string | null;
  position: number;
  embedding: number[] | null;
}

function rowToCluster(c: DbCluster, nodes: DbClusterNode[]): TopicCluster {
  return {
    id: c.id,
    rootTopic: c.root_topic,
    pillarKeyword: c.pillar_keyword,
    summary: c.summary ?? undefined,
    createdAt: c.created_at,
    nodes: nodes
      .sort((a, b) => a.position - b.position)
      .map<ClusterNode>((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        targetKeyword: n.target_keyword,
        contentType: (n.content_type as any) ?? undefined,
        intent: (n.intent as any) ?? undefined,
        status: (n.status as any) || 'planned',
        draftId: n.draft_id ?? undefined,
        position: n.position,
        embedding: n.embedding ?? undefined,
      })),
  };
}

export const ClusterRepository = {
  /** Save (insert) a full cluster + its nodes. Returns the persisted cluster (with DB ids) or null. */
  save: (cluster: TopicCluster, opts?: { siteId?: string; ownerId?: string }) =>
    withSupabase(async (sb) => {
      const { data: created, error } = await sb
        .from('topic_clusters')
        .insert({
          site_id: opts?.siteId ?? null,
          owner_id: opts?.ownerId ?? null,
          root_topic: cluster.rootTopic,
          pillar_keyword: cluster.pillarKeyword,
          summary: cluster.summary ?? null,
        })
        .select()
        .single();
      if (error) throw error;
      const clusterId = (created as DbCluster).id;

      const payload = cluster.nodes.map((n, i) => ({
        cluster_id: clusterId,
        kind: n.kind,
        title: n.title,
        target_keyword: n.targetKeyword,
        content_type: n.contentType ?? null,
        intent: n.intent ?? null,
        status: n.status || 'planned',
        draft_id: n.draftId ?? null,
        position: typeof n.position === 'number' ? n.position : i,
        embedding: n.embedding ?? null,
      }));

      const { data: insertedNodes, error: nodeErr } = await sb
        .from('cluster_nodes')
        .insert(payload)
        .select();
      if (nodeErr) {
        console.warn('[ClusterRepository] node insert failed', nodeErr.message);
        return rowToCluster(created as DbCluster, []);
      }
      return rowToCluster(created as DbCluster, (insertedNodes ?? []) as DbClusterNode[]);
    }, null as TopicCluster | null),

  /** List all clusters (most recent first). */
  list: (opts?: { siteId?: string; limit?: number }) =>
    withSupabase(async (sb) => {
      let q = sb
        .from('topic_clusters')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(opts?.limit ?? 50);
      if (opts?.siteId) q = q.eq('site_id', opts.siteId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as DbCluster[];
    }, [] as DbCluster[]),

  /** Load a full cluster + its nodes. */
  get: (id: string) =>
    withSupabase(async (sb) => {
      const { data: cluster, error } = await sb
        .from('topic_clusters')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      if (!cluster) return null;
      const { data: nodes, error: nodeErr } = await sb
        .from('cluster_nodes')
        .select('*')
        .eq('cluster_id', id);
      if (nodeErr) throw nodeErr;
      return rowToCluster(cluster as DbCluster, (nodes ?? []) as DbClusterNode[]);
    }, null as TopicCluster | null),

  /** Update a single node's status (e.g. when its draft is created/published). */
  updateNodeStatus: (nodeId: string, status: 'planned' | 'drafting' | 'done', draftId?: string) =>
    withSupabase(async (sb) => {
      const { error } = await sb
        .from('cluster_nodes')
        .update({ status, ...(draftId ? { draft_id: draftId } : {}) })
        .eq('id', nodeId);
      if (error) throw error;
      return true;
    }, false),

  remove: (id: string) =>
    withSupabase(async (sb) => {
      const { error } = await sb.from('topic_clusters').delete().eq('id', id);
      if (error) throw error;
      return true;
    }, false),
};
