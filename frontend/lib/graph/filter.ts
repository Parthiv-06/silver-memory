import type { FilterSettings, GraphData, GraphLink, GraphNode } from "./types";
import { localSubgraph, type NormalizedGraph } from "./normalize";

export interface LocalView {
  focusId: string;
  depth: number;
}

/** The part of the graph the filters, hidden groups and local-graph focus leave visible. */
export function filterGraph(
  graph: NormalizedGraph,
  filters: FilterSettings,
  hiddenGroups: readonly string[] = [],
  local?: LocalView | null,
): GraphData {
  const { search, showOrphans, showUnresolved } = filters;
  const hidden = new Set(hiddenGroups);
  const query = search.trim().toLowerCase();
  const n = graph.nodes.length;
  const keep = new Uint8Array(n);
  const focus = local ? graph.indexOf.get(local.focusId) : undefined;

  if (local && focus !== undefined) {
    for (const id of localSubgraph(graph, local.focusId, local.depth).depthOf.keys()) keep[graph.indexOf.get(id)!] = 1;
  } else {
    keep.fill(1);
  }

  for (let i = 0; i < n; i++) {
    if (!keep[i] || i === focus) continue;
    const node = graph.nodes[i];
    if (hidden.has(node.group!) || (!showUnresolved && node.unresolved)) keep[i] = 0;
    else if (query && !node.label.toLowerCase().includes(query)) keep[i] = 0;
  }

  // An orphan has no links at all in the vault, so a search match doesn't vanish just because
  // its neighbours were filtered out.
  if (!showOrphans) for (let i = 0; i < n; i++) if (graph.degree[i] === 0 && i !== focus) keep[i] = 0;

  const links: GraphLink[] = [];
  for (let l = 0; l < graph.links.length; l++) {
    if (keep[graph.linkSource[l]] && keep[graph.linkTarget[l]]) links.push(graph.links[l]);
  }

  const nodes: GraphNode[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) nodes.push(graph.nodes[i]);
  return { nodes, links };
}
