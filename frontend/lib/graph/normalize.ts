import type { GraphData, GraphLink, GraphNode } from "./types";
import { UNGROUPED, UNRESOLVED_GROUP } from "./theme";

/** A cleaned-up graph with index-based structure for layout, drawing and queries. */
export interface NormalizedGraph {
  /** Unique nodes; every one has a label and a group. */
  nodes: GraphNode[];
  /** Unique directed links between existing nodes, without self-loops. */
  links: GraphLink[];
  linkSource: Uint32Array;
  linkTarget: Uint32Array;
  indexOf: Map<string, number>;
  /** Undirected edges (A→B and B→A collapse into one) used for layout and drawing. */
  edgeSource: Uint32Array;
  edgeTarget: Uint32Array;
  /** Bit 1: edgeSource links to edgeTarget. Bit 2: the reverse. */
  edgeDir: Uint8Array;
  edgeWeight: Float32Array;
  /** Distinct neighbours per node. */
  degree: Uint32Array;
  neighbors: number[][];
  outgoing: number[][];
  incoming: number[][];
  /** Group keys in first-seen order. */
  groups: string[];
  dropped: { duplicateNodes: number; duplicateLinks: number; selfLoops: number; dangling: number; invalid: number };
}

export interface NormalizeOptions {
  /** Create an unresolved node for link ends with no note (default), or drop those links. */
  createUnresolved?: boolean;
}

// Pair keys are a * KEY + b; exact in a double for up to 2^26 nodes.
const KEY = 2 ** 26;

function endpointId(value: unknown): string {
  if (value && typeof value === "object" && "id" in value) return String((value as { id: unknown }).id);
  return value == null ? "" : String(value);
}

function withDefaults(node: GraphNode, id: string): GraphNode {
  const group = node.group || (node.unresolved ? UNRESOLVED_GROUP : UNGROUPED);
  return { ...node, id, label: node.label || id, group };
}

export function normalizeGraph(data: GraphData, options: NormalizeOptions = {}): NormalizedGraph {
  const createUnresolved = options.createUnresolved ?? true;
  const dropped = { duplicateNodes: 0, duplicateLinks: 0, selfLoops: 0, dangling: 0, invalid: 0 };
  const nodes: GraphNode[] = [];
  const indexOf = new Map<string, number>();

  for (const raw of data.nodes) {
    const id = endpointId(raw?.id);
    if (!id) { dropped.invalid++; continue; }
    const at = indexOf.get(id);
    if (at === undefined) {
      indexOf.set(id, nodes.length);
      nodes.push(withDefaults(raw, id));
    } else {
      dropped.duplicateNodes++;
      // A real note beats a placeholder declared earlier for the same id.
      if (nodes[at].unresolved && !raw.unresolved) nodes[at] = withDefaults(raw, id);
    }
  }

  const resolve = (id: string): number => {
    const at = indexOf.get(id);
    if (at !== undefined) return at;
    if (!createUnresolved || !id) return -1;
    indexOf.set(id, nodes.length);
    nodes.push({ id, label: id, group: UNRESOLVED_GROUP, unresolved: true });
    return nodes.length - 1;
  };

  const links: GraphLink[] = [];
  const ls: number[] = [], lt: number[] = [];
  const es: number[] = [], et: number[] = [], ed: number[] = [], ew: number[] = [];
  const directed = new Set<number>();
  const undirected = new Map<number, number>();

  for (const link of data.links) {
    const sourceId = endpointId(link?.source), targetId = endpointId(link?.target);
    if (!sourceId || !targetId) { dropped.invalid++; continue; }
    const s = resolve(sourceId), t = resolve(targetId);
    if (s < 0 || t < 0) { dropped.dangling++; continue; }
    if (s === t) { dropped.selfLoops++; continue; }
    const key = s * KEY + t;
    if (directed.has(key)) { dropped.duplicateLinks++; continue; }
    directed.add(key);
    const weight = typeof link.weight === "number" && link.weight > 0 && Number.isFinite(link.weight) ? link.weight : 1;
    links.push({ source: nodes[s].id, target: nodes[t].id, weight });
    ls.push(s);
    lt.push(t);

    const pair = Math.min(s, t) * KEY + Math.max(s, t);
    const edge = undirected.get(pair);
    if (edge === undefined) {
      undirected.set(pair, es.length);
      es.push(s); et.push(t); ed.push(1); ew.push(weight);
    } else {
      ed[edge] |= es[edge] === s ? 1 : 2;
      ew[edge] = Math.max(ew[edge], weight);
    }
  }

  const n = nodes.length;
  const neighbors: number[][] = Array.from({ length: n }, () => []);
  const outgoing: number[][] = Array.from({ length: n }, () => []);
  const incoming: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < es.length; e++) {
    neighbors[es[e]].push(et[e]);
    neighbors[et[e]].push(es[e]);
  }
  for (let l = 0; l < ls.length; l++) {
    outgoing[ls[l]].push(lt[l]);
    incoming[lt[l]].push(ls[l]);
  }
  const degree = new Uint32Array(n);
  for (let i = 0; i < n; i++) degree[i] = neighbors[i].length;

  const groups: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!seen.has(node.group!)) { seen.add(node.group!); groups.push(node.group!); }
  }

  return {
    nodes, links, indexOf, groups, dropped, degree, neighbors, outgoing, incoming,
    linkSource: Uint32Array.from(ls),
    linkTarget: Uint32Array.from(lt),
    edgeSource: Uint32Array.from(es),
    edgeTarget: Uint32Array.from(et),
    edgeDir: Uint8Array.from(ed),
    edgeWeight: Float32Array.from(ew),
  };
}

/** Counts the notes people wrote: unresolved placeholders and attachments don't count. */
export function countNotes(data: { nodes: readonly GraphNode[] }): number {
  let notes = 0;
  for (const node of data.nodes) if (!node.unresolved && node.group !== "attachment") notes++;
  return notes;
}

/**
 * Whether `next` is a different graph altogether (another vault was loaded) rather than a filtered,
 * local or edited view of `previous`: fewer than half the notes of the smaller one are shared.
 */
export function isDifferentGraph(previous: NormalizedGraph, next: NormalizedGraph): boolean {
  if (previous === next) return false;
  const smaller = Math.min(previous.nodes.length, next.nodes.length);
  // To or from an empty view (a search with no match) is still the same vault.
  if (smaller === 0) return false;
  let shared = 0;
  for (const node of next.nodes) if (previous.indexOf.has(node.id) && ++shared * 2 >= smaller) return false;
  return true;
}

export interface DuplicatePair {
  a: string;
  b: string;
  /** Edit distance between the normalised labels; 0 means they only differ in case, spacing or punctuation. */
  distance: number;
}

/** Lowercase, accents stripped, spaces and punctuation removed ("+" and "#" kept: C, C++ and C# differ). */
export function normalizeLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[ -⁯⸀-⹿　-〿]/g, "")
    .replace(/[^a-z0-9+#\u0080-￿]+/g, "");
}

// Short labels must match exactly; longer ones tolerate one or two typos.
function allowedDistance(length: number): number {
  return length < 5 ? 0 : length < 9 ? 1 : 2;
}

function histogram(key: string): Uint8Array {
  const hist = new Uint8Array(37);
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    const slot = c >= 97 && c <= 122 ? c - 97 : c >= 48 && c <= 57 ? c - 22 : 36;
    if (hist[slot] < 255) hist[slot]++;
  }
  return hist;
}

/** Optimal-string-alignment Damerau–Levenshtein distance, giving up past `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const lb = b.length;
  let before = new Int32Array(lb + 1);
  let prev = new Int32Array(lb + 1);
  let cur = new Int32Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, before[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const spare = before;
    before = prev;
    prev = cur;
    cur = spare;
  }
  return prev[lb];
}

/**
 * Pairs of notes whose labels are probably the same note written twice ("Cacheing" / "Caching").
 * Labels are bucketed by length and pre-filtered by letter counts, so thousands of notes stay fast.
 */
export function findLikelyDuplicates(nodes: readonly GraphNode[]): DuplicatePair[] {
  const items = nodes
    .map((node) => {
      const key = normalizeLabel(node.label || node.id);
      return { id: node.id, key, digits: key.replace(/[^0-9]/g, ""), hist: histogram(key) };
    })
    .filter((item) => item.key.length > 0)
    .sort((x, y) => x.key.length - y.key.length);

  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const allowed = allowedDistance(a.key.length);
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (b.key.length - a.key.length > allowed) break;
      // "Part 1" and "Part 2" are siblings, not duplicates.
      if (a.digits !== b.digits) continue;
      let diff = 0;
      for (let k = 0; k < 37 && diff <= 2 * allowed; k++) diff += Math.abs(a.hist[k] - b.hist[k]);
      if (diff > 2 * allowed) continue;
      const distance = a.key === b.key ? 0 : editDistance(a.key, b.key, allowed);
      if (distance <= allowed) pairs.push({ a: a.id, b: b.id, distance });
    }
  }
  return pairs.sort((x, y) => x.distance - y.distance);
}

export interface Components {
  /** Component number per node; components are sorted largest first. */
  componentOf: Int32Array;
  components: number[][];
}

export function connectedComponents(graph: NormalizedGraph): Components {
  const n = graph.nodes.length;
  const raw: number[][] = [];
  const seen = new Uint8Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const members = [start];
    seen[start] = 1;
    for (let head = 0; head < members.length; head++) {
      for (const next of graph.neighbors[members[head]]) {
        if (!seen[next]) { seen[next] = 1; members.push(next); }
      }
    }
    raw.push(members);
  }
  const components = raw.sort((x, y) => y.length - x.length);
  const componentOf = new Int32Array(n);
  components.forEach((members, c) => { for (const i of members) componentOf[i] = c; });
  return { componentOf, components };
}

export interface LocalSubgraph extends GraphData {
  /** Hops from the focus note to each included note. */
  depthOf: Map<string, number>;
}

/** The notes within `depth` hops of `focusId`, following outgoing and/or incoming links. */
export function localSubgraph(
  graph: NormalizedGraph,
  focusId: string,
  depth: number,
  { incoming = true, outgoing = true }: { incoming?: boolean; outgoing?: boolean } = {},
): LocalSubgraph {
  const start = graph.indexOf.get(focusId);
  if (start === undefined) return { nodes: [], links: [], depthOf: new Map() };
  const hops = new Map<number, number>([[start, 0]]);
  let frontier = [start];
  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const next: number[] = [];
    for (const i of frontier) {
      if (outgoing) for (const j of graph.outgoing[i]) if (!hops.has(j)) { hops.set(j, level); next.push(j); }
      if (incoming) for (const j of graph.incoming[i]) if (!hops.has(j)) { hops.set(j, level); next.push(j); }
    }
    frontier = next;
  }
  const links: GraphLink[] = [];
  for (let l = 0; l < graph.links.length; l++) {
    if (hops.has(graph.linkSource[l]) && hops.has(graph.linkTarget[l])) links.push(graph.links[l]);
  }
  const depthOf = new Map<string, number>();
  for (const [i, d] of hops) depthOf.set(graph.nodes[i].id, d);
  return { nodes: [...hops.keys()].map((i) => graph.nodes[i]), links, depthOf };
}
