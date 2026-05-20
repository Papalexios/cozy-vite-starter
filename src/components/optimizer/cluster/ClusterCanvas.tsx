// src/components/optimizer/cluster/ClusterCanvas.tsx
// Phase 10 — ReactFlow visualizer for a topical cluster.

import { useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { ClusterLink, TopicCluster } from '@/lib/sota/clusters/ClusterTypes';

interface ClusterCanvasProps {
  cluster: TopicCluster;
  links: ClusterLink[];
  onNodeClick?: (nodeId: string) => void;
}

export function ClusterCanvas({ cluster, links, onNodeClick }: ClusterCanvasProps) {
  const { nodes, edges } = useMemo(() => {
    const spokes = cluster.nodes.filter((n) => n.kind === 'spoke');
    const pillar = cluster.nodes.find((n) => n.kind === 'pillar');
    const radius = Math.max(260, spokes.length * 32);
    const cx = 0;
    const cy = 0;

    const nodes: Node[] = [];
    if (pillar) {
      nodes.push({
        id: pillar.id,
        position: { x: cx, y: cy },
        data: { label: `★ ${pillar.title}` },
        style: {
          background: 'hsl(var(--primary))',
          color: 'hsl(var(--primary-foreground))',
          border: '2px solid hsl(var(--primary))',
          borderRadius: 16,
          padding: 12,
          fontWeight: 700,
          fontSize: 13,
          width: 220,
          textAlign: 'center' as const,
        },
      });
    }
    spokes.forEach((s, i) => {
      const angle = (i / spokes.length) * Math.PI * 2;
      nodes.push({
        id: s.id,
        position: { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius },
        data: { label: s.title },
        style: {
          background: 'hsl(var(--card))',
          color: 'hsl(var(--card-foreground))',
          border: '1px solid hsl(var(--border))',
          borderRadius: 12,
          padding: 10,
          fontSize: 11,
          width: 180,
          textAlign: 'center' as const,
        },
      });
    });

    const edges: Edge[] = links.map((l, idx) => ({
      id: `e-${idx}`,
      source: l.fromId,
      target: l.toId,
      animated: l.fromId === pillar?.id || l.toId === pillar?.id,
      style: {
        stroke: 'hsl(var(--primary) / 0.4)',
        strokeWidth: Math.max(0.8, l.similarity * 2.2),
      },
      markerEnd: { type: MarkerType.ArrowClosed },
      label: l.similarity ? l.similarity.toFixed(2) : undefined,
      labelStyle: { fill: 'hsl(var(--muted-foreground))', fontSize: 9 },
      labelBgStyle: { fill: 'hsl(var(--background))' },
    }));

    return { nodes, edges };
  }, [cluster, links]);

  return (
    <div className="w-full h-[600px] rounded-2xl border border-border bg-background/50 overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        onNodeClick={(_, node) => onNodeClick?.(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color="hsl(var(--border))" />
        <Controls />
        <MiniMap nodeColor={() => 'hsl(var(--primary))'} maskColor="hsl(var(--background) / 0.6)" />
      </ReactFlow>
    </div>
  );
}
