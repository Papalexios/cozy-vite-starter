// src/lib/sota/clusters/ClusterTypes.ts
// Phase 10 — Topical cluster type definitions.

export type ClusterNodeKind = 'pillar' | 'spoke';
export type ClusterNodeStatus = 'planned' | 'drafting' | 'done';

export interface ClusterNode {
  id: string;
  kind: ClusterNodeKind;
  title: string;
  targetKeyword: string;
  contentType?: 'how-to' | 'guide' | 'comparison' | 'listicle' | 'deep-dive';
  intent?: 'informational' | 'commercial' | 'transactional' | 'navigational';
  status: ClusterNodeStatus;
  draftId?: string | null;
  position: number;
  embedding?: number[] | null;
}

export interface TopicCluster {
  id: string;
  rootTopic: string;
  pillarKeyword: string;
  summary?: string;
  nodes: ClusterNode[];
  createdAt: string;
}

export interface ClusterLink {
  fromId: string;
  toId: string;
  anchor: string;
  similarity: number;
}
