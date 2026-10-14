import type { GraphNode } from "./types";
import { connectedComponents, findLikelyDuplicates, type NormalizedGraph } from "./normalize";

export interface GraphInsights {
  /** `a` is the less-connected note, so usually the one to merge into `b`. */
  duplicates: { a: GraphNode; b: GraphNode; distance: number }[];
  unresolved: { node: GraphNode; referencedBy: number }[];
  /** Groups of two or more notes not connected to the main graph, largest first. */
  clusters: GraphNode[][];
  orphans: GraphNode[];
  hubs: { node: GraphNode; degree: number }[];
}

/** Housekeeping hints about a vault: likely duplicates, dangling links, islands and hubs. */
export function computeInsights(graph: NormalizedGraph, hubCount = 5): GraphInsights {
  const { nodes, indexOf, degree } = graph;
  const duplicates = findLikelyDuplicates(nodes).map(({ a, b, distance }) => {
    const i = indexOf.get(a)!, j = indexOf.get(b)!;
    return degree[i] <= degree[j] ? { a: nodes[i], b: nodes[j], distance } : { a: nodes[j], b: nodes[i], distance };
  });

  const unresolved = nodes
    .map((node, i) => ({ node, referencedBy: graph.incoming[i].length }))
    .filter(({ node }) => node.unresolved)
    .sort((x, y) => y.referencedBy - x.referencedBy);

  const { components } = connectedComponents(graph);
  const islands = components.slice(1);
  const clusters = islands.filter((c) => c.length > 1).map((c) => c.map((i) => nodes[i]));
  const orphans = islands.filter((c) => c.length === 1).map(([i]) => nodes[i]);

  const hubs = nodes
    .map((node, i) => ({ node, degree: degree[i] }))
    .filter((hub) => hub.degree > 1)
    .sort((x, y) => y.degree - x.degree)
    .slice(0, hubCount);

  return { duplicates, unresolved, clusters, orphans, hubs };
}
