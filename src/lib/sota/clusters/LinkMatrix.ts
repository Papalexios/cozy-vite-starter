// src/lib/sota/clusters/LinkMatrix.ts
// Phase 10 — Computes spoke↔pillar↔sibling internal links via cosine similarity
// over embeddings of cluster node titles+keywords (reuses Phase 7 /api/embed).

import { embedTexts, cosineSimilarity } from '../geo/embeddings';
import type { ClusterLink, ClusterNode, TopicCluster } from './ClusterTypes';

function nodeText(n: ClusterNode): string {
  return `${n.title}. Target keyword: ${n.targetKeyword}.`;
}

/** Compute embeddings for all nodes (mutates cluster.nodes[i].embedding). */
export async function embedCluster(cluster: TopicCluster): Promise<TopicCluster> {
  const texts = cluster.nodes.map(nodeText);
  const vectors = await embedTexts(texts).catch((e) => {
    console.warn('[LinkMatrix] embedTexts failed:', e?.message || e);
    return [] as number[][];
  });
  if (vectors.length === cluster.nodes.length) {
    cluster.nodes.forEach((n, i) => { n.embedding = vectors[i]; });
  }
  return cluster;
}

export interface LinkMatrixOptions {
  /** Max sibling-to-sibling links per spoke. Default 3. */
  maxSiblingsPerSpoke?: number;
  /** Skip sibling links below this cosine. Default 0.55. */
  siblingThreshold?: number;
}

/** Build the full link list: every spoke ↔ pillar + top-K sibling pairs. */
export function buildLinkMatrix(cluster: TopicCluster, opts: LinkMatrixOptions = {}): ClusterLink[] {
  const maxSiblings = opts.maxSiblingsPerSpoke ?? 3;
  const threshold = opts.siblingThreshold ?? 0.55;
  const links: ClusterLink[] = [];

  const pillar = cluster.nodes.find((n) => n.kind === 'pillar');
  const spokes = cluster.nodes.filter((n) => n.kind === 'spoke');
  if (!pillar) return links;

  // Spoke ↔ pillar (always)
  for (const s of spokes) {
    const sim = pillar.embedding && s.embedding ? cosineSimilarity(pillar.embedding, s.embedding) : 1;
    links.push({ fromId: s.id, toId: pillar.id, anchor: pillar.targetKeyword, similarity: sim });
    links.push({ fromId: pillar.id, toId: s.id, anchor: s.targetKeyword, similarity: sim });
  }

  // Spoke ↔ sibling (top-K)
  for (const s of spokes) {
    if (!s.embedding) continue;
    const ranked = spokes
      .filter((o) => o.id !== s.id && !!o.embedding)
      .map((o) => ({ node: o, sim: cosineSimilarity(s.embedding!, o.embedding!) }))
      .filter((x) => x.sim >= threshold)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, maxSiblings);
    for (const r of ranked) {
      links.push({ fromId: s.id, toId: r.node.id, anchor: r.node.targetKeyword, similarity: r.sim });
    }
  }

  return links;
}
