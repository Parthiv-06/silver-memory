# Connect your knowledge graph

`<GraphView>` draws any set of notes and links as an Obsidian-style graph: force layout in a Web
Worker, Canvas 2D rendering, command search (Ctrl/⌘ K), filters, groups, a local graph, insights
(likely duplicates, unresolved links, islands, hubs) and a minimap. It only needs plain data.

```tsx
import { GraphView } from "@/components/graph/graph-view";

<GraphView data={graph} onOpenNote={(id) => router.push(`/notes/${id}`)} />
```

The demo lives at `/graph` (`app/graph`), showing the System Design vault from `sample-data.ts`.

## The data contract

```ts
interface GraphData {
  nodes: { id: string; label: string; group?: string; tags?: string[]; unresolved?: boolean; meta?: Record<string, unknown> }[];
  links: { source: string; target: string; weight?: number }[]; // source links to target, like [[wikilinks]]
  groups?: Record<string, { label?: string; color?: string }>;  // optional display names and colours
}
```

- `id` is what links point at; `label` is what people read. Use the note path or a slug for `id`.
- `group` drives colour and the Groups filter. Known keys (`hub`, `concept`, `infra`, `data`,
  `pattern`, `case`, `misc`) have fixed colours; other groups get the next free palette colour.
  The best-connected `hub` notes (or, without that group, the best-connected notes) always keep
  their label.
- Links to ids with no node become **unresolved** notes (dashed rings), as in Obsidian.
- Duplicate nodes and links, and self-links, are dropped. A→B plus B→A draws as one line.
- `meta` is yours. The `/graph` page opens `meta.url` when present (see "Open note" below).
- Exporters' `null` and `""` values (`"group": null`, `"weight": null`, …) mean "not set", and
  d3-style link ends (`{ "source": { "id": "a" } }`) are accepted.

## Three ways to connect

### 1. A JSON URL (no code)

Serve `GraphData` JSON from anywhere that allows CORS, then build or run with:

```bash
NEXT_PUBLIC_GRAPH_URL=https://example.com/vault-graph.json npm run dev
```

`/graph` fetches it with `fetchGraph`, shows a loading state, and on a bad response or invalid
shape shows the exact problem (e.g. `Invalid graph from …: links[3].target must be a node id`),
with a retry and a fallback to the sample vault. `edges` is accepted as an alias for `links`, and
numeric ids are converted to strings.

### 2. Markdown notes (an Obsidian vault)

```ts
import { fromMarkdownNotes } from "@/lib/graph/adapters";

const data = fromMarkdownNotes(
  [{ path: "Infra/Caching.md", content: "See [[CDN]] and [[Latency vs Throughput|latency]]." }],
  { embeds: "link", attachments: false, groupBy: "folder", resolveAliases: false },
);
```

It understands `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Folder/Note]]`, `![[embeds]]`,
links in frontmatter properties (`up: "[[MOC]]"`, as Obsidian 1.4+ graphs them) and markdown
links in all three of Obsidian's formats: relative (`[t](../Concepts/Latency%20vs%20Throughput.md)`),
vault-absolute (`[t](Concepts/Latency.md)`) and shortest-path (`[t](Latency.md)`). Links resolve
the way Obsidian does: relative path, then vault path, then file name anywhere in the vault (same
folder first, then the shortest path). Like Obsidian, a bare `[[Alias]]` stays unresolved; pass
`resolveAliases: true` to resolve it through frontmatter `aliases`. Links inside code blocks and
comments are ignored, and `[text](#heading)` anchors are not tags. Names with dots (`[[Next.js]]`)
are notes; images, audio, video, PDFs and canvases are skipped unless `attachments: true`. The group
is the top-level folder, else the first `#tag` (`groupBy: "tag"` flips that, or pass a function).
Each node keeps its file path in `meta.path`.

For a CSV/TSV edge list (`source,target[,weight]`, optional header row), use `fromEdgeList(text)`.

### 3. Your own backend endpoint

Return `GraphData` from an API route and load it on the client:

```tsx
"use client";
import { useEffect, useState } from "react";
import { GraphView } from "@/components/graph/graph-view";
import { fetchGraph } from "@/lib/graph/adapters";
import type { GraphData } from "@/lib/graph/types";

export function MyGraph({ token }: { token?: string }) {
  const [data, setData] = useState<GraphData | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchGraph("/api/graph", token, { signal: controller.signal }).then(setData, console.error);
    return () => controller.abort();
  }, [token]);
  return data ? <GraphView data={data} /> : null;
}
```

`fetchGraph(url, token?, init?)` sends `Authorization: Bearer <token>` when given, validates the
response with `parseGraphData`, and throws an `Error` that names the first problem. Use
`parseGraphData(json)` on its own for data you got some other way.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `data` | `GraphData` | Required. Memoise it: a new object is re-normalised (the layout only restarts if notes or links changed). |
| `onOpenNote` | `(id: string) => void` | Shows "Open note" in the note panel. |
| `initialSelectedId` | `string` | Note to select on first render. |
| `initialSettings` | `PartialSettings` | Overrides for `DEFAULT_SETTINGS` (filters, groups, display, forces); "Reset" returns here. |
| `showSidebar` | `boolean` | Note list and insights on the left (default `true`, hidden below 768px). |
| `title` | `string` | Sidebar heading. |
| `className` | `string` | Sizing: the view fills its container. |

On `/graph`, "Open note" opens `meta.url` when nodes have one (only `http:`/`https:` URLs; anything
else, such as `javascript:`, is ignored), or an `obsidian://open` link when `NEXT_PUBLIC_OBSIDIAN_VAULT`
is set to your vault's name. For an unresolved note the button reads "Create note" and uses
`obsidian://new`. Otherwise the button stays hidden.

Graph settings start open on screens 1440px and wider, closed below that, so the first view keeps
room for labels.

### Lower-level pieces

- `GraphCanvas` (`components/graph/graph-canvas.tsx`) is just the canvas, with a ref handle:
  `flyTo`, `fitToView`, `zoomBy`, `centerOn`, `reheat`, `focus`. `GraphMinimap` takes that ref.
  With `onSelect`, selection is controlled: a click or Esc proposes a change, and `selectedId`
  decides (the view uses this to keep the local graph's note selected).
- `normalizeGraph`, `findLikelyDuplicates`, `connectedComponents` and `localSubgraph`
  (`normalize.ts`) and `computeInsights` (`insights.ts`) work without React.
- `ForceSimulation` (`simulation.ts`) is a dependency-free d3-style layout on typed arrays
  (Barnes–Hut above 400 nodes).

## Keyboard

Ctrl/⌘ K searches; Esc in an empty search returns to the graph. With the graph focused: arrow
keys pan, `+`/`-` zoom, `0` fits, Esc deselects. Esc also closes the note and settings panels, and
focus goes back to the graph or the settings button. After the canvas, a screen-reader listbox of
notes (one tab stop) takes arrow keys, Page Up/Down, Home/End and type-ahead; the active note is
highlighted in the graph, and Enter selects it.

The name filter matches note labels (not ids). With Orphans off, notes that have no links at all
are hidden; a search match stays visible even when its neighbours are filtered out.
