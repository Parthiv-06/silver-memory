# Connect your knowledge graph

`<GraphView>` draws any set of notes and links as an Obsidian-style graph: force layout in a Web
Worker, Canvas 2D rendering, command search (Ctrl/⌘ K), filters, groups, a local graph, insights
(likely duplicates, unresolved links, islands, hubs) and a minimap. It only needs plain data.

```tsx
import { GraphView } from "@/components/graph/graph-view";

<GraphView data={graph} onOpenNote={(id) => router.push(`/notes/${id}`)} />
```

`/graph` (`app/graph`) shows, in this order: the last graph imported in this browser when it was
never saved and is newer than the account's copy (or there is no account copy); with a code-word
session, the graph saved to the account; else the JSON at `NEXT_PUBLIC_GRAPH_URL` when that is set;
else the System Design sample vault (`sample-data.ts`). An import that is hidden behind a newer
account copy gets a notice with **Show the import**. A chip at the top of the sidebar says which
("Sample vault", "Obsidian vault · imported locally", "Obsidian vault · saved to account"), and the
top bar has **Import…**, **Save to account** and a menu with Reset to sample, Remove from account and
Back to shelf. `GET /graph` gets 10 seconds; past that (or on a network error) the page shows the
browser copy or the sample with a **Retry** notice, and Save asks before replacing what the account
might hold.

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
are notes; images, audio, video, PDFs and canvases are skipped unless `attachments: true` (pass the
vault's attachment paths as `attachmentPaths` and `![[diagram.png]]` resolves to `Assets/diagram.png`
wherever it lives, so two spellings of one file make one node). The group
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

## Import in the browser

No code: on `/graph`, **Import…** opens "Connect your knowledge graph", a three-step dialog.

1. **Source.** An Obsidian or Markdown vault folder (recommended), Markdown files, a JSON file
   (`GraphData`), a CSV/TSV edge list, or a JSON URL. Drop a folder or files anywhere on the dialog,
   or use the button; the kind is detected from what arrives.
2. **Options.** Group by folder or tag, create nodes for unresolved links, include attachments,
   resolve aliases. These are `fromMarkdownNotes` options (unresolved links off drops those links).
3. **Preview.** Notes, links, unresolved links, likely duplicates (skipped above 3,000 notes; the
   sidebar lists them after import), disconnected clusters and file warnings, built once the step
   opens, with a progress bar while files are read. The preview is the graph as it will be kept and
   saved: fields over the account's limits are shortened (titles to 512 characters, tags to 32 of
   120, group names to 120; `meta` over 4 KB keeps only `path`/`url`) and the preview says how many.
   **Import N notes** swaps the graph in (the camera glides to the new layout; selection and filters
   reset).

Everything is read locally by `lib/graph/vault-reader.ts`, which you can use on its own:

```ts
import { buildGraph, DEFAULT_IMPORT_OPTIONS, filesFromDrop, filesFromList, readSelection } from "@/lib/graph/vault-reader";

// <input type="file" webkitdirectory multiple> or loose files:
const payload = await readSelection(filesFromList(input.files!), { signal, onProgress: ({ done, total }) => {} });
// In a drop handler (call filesFromDrop synchronously, before any await):
const dropped = await readSelection(await filesFromDrop(event.dataTransfer, signal), { signal });
const graph = buildGraph(payload, { ...DEFAULT_IMPORT_OPTIONS, groupBy: "tag" });
```

- Dropped folders are walked with `webkitGetAsEntry`, reading each directory in batches until it is
  empty, at most 32 folders deep and 100,000 entries in all (a folder linked into itself can't
  loop). `.obsidian`, `.git`, `.trash` (any dot-folder) and `node_modules` are skipped without being
  read; an `.obsidian` folder makes the source "Obsidian vault: *name*".
- The picked folder is stripped from paths, so ids are vault-relative (`Infra/Caching`) and the
  folder's name is the vault's name.
- Notes (`.md`, as in Obsidian) are read 16 at a time, abortable, with progress. Notes over 2 MB are
  skipped; bytes that aren't UTF-8 are replaced (U+FFFD) instead of failing. Each case becomes a
  per-file warning in `payload.warnings`. Attachments are not read, only their paths are kept.
- A single `.json` file is checked with `parseGraphData` and a `.csv`/`.tsv` file goes through
  `fromEdgeList`; `readGraphUrl(url)` uses `fetchGraph`. Problems throw an `Error` that names the
  file and the fault (`Invalid graph in vault.json: links[3].target must be a node id`).

The last import is kept in IndexedDB (`loadLocalGraph`, `saveLocalGraph`, `clearLocalGraph` in
`lib/graph/graph-store.ts`) with its vault name and, once saved, the account copy's `updated_at`
(`markLocalGraphSynced`), so a reload shows it again unless the account holds it or something newer. Every call is wrapped: in a private window
or with storage blocked, imports still work and are simply gone after a reload (the page says so).

## Save to your account

With a session (the code word entered on the shelf), **Save to account** stores the graph on the
backend, replacing what was saved before, and the chip turns to "saved to account". On the next visit
the saved graph loads, on any device (in this browser, a newer import that wasn't saved comes first). The source menu's **Remove from account** deletes it
(the graph stays in this browser); **Reset to sample** only forgets the local import.

`lib/graph/graph-store.ts` wraps the backend's `/graph` routes, sending the JWT that `lib/api.ts`
stores (`readToken`):

| Call | Request | Result |
| --- | --- | --- |
| `getSavedGraph()` | `GET /graph` | `{ graph, source, updatedAt, nodes, links }`, or `null` on 404 |
| `saveGraph(graph, source)` | `PUT /graph` `{ graph, source }` | `{ source, updatedAt, nodes, links }` |
| `deleteSavedGraph()` | `DELETE /graph` | resolves on 204 |

Failures throw a `GraphStoreError` with a message ready to show: 401 clears the stored token and
reads "Your session expired. Enter the code word again."; 413 and 422 carry the backend's `detail`
(e.g. `nodes[12].label is longer than 512 characters`). The backend accepts up to 15 MB, 50,000
notes and 250,000 links; ids and labels up to 512 characters, groups and tags up to 120 (32 tags),
and `meta` up to 4 KB per note. `saveGraph` first normalises with `toStorableGraph`, so every link
end is a note (dangling targets become `unresolved: true` notes), duplicates are dropped and fields
are cut to those limits; `storableProblem` refuses, before uploading, what can't be cut (an id over
512 characters, more than 50,000 notes or 250,000 links).

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `data` | `GraphData` | Required. Memoise it: a new object is re-normalised (the layout only restarts if notes or links changed). A different graph altogether (fewer than half the notes shared) also clears the selection, local graph, name filter and hidden groups, and the camera glides to frame it. |
| `onOpenNote` | `(id: string) => void` | Shows "Open note" in the note panel. |
| `initialSelectedId` | `string` | Note to select on first render. |
| `initialSettings` | `PartialSettings` | Overrides for `DEFAULT_SETTINGS` (filters, groups, display, forces); "Reset" returns here. |
| `showSidebar` | `boolean` | Note list and insights on the left (default `true`, hidden below 768px). |
| `title` | `string` | Sidebar heading. |
| `sidebarHeader` | `ReactNode` | Shown above the title in the sidebar (on `/graph`: Back to shelf and the source chip). |
| `toolbar` | `ReactNode` | Extra top-bar controls before the settings button (on `/graph`: Import…, Save to account, source menu). |
| `className` | `string` | Sizing: the view fills its container. |

On `/graph`, "Open note" opens `meta.url` when nodes have one (only `http:`/`https:` URLs; anything
else, such as `javascript:`, is ignored), or an `obsidian://open` link when `NEXT_PUBLIC_OBSIDIAN_VAULT`
is set to your vault's name (an imported Obsidian vault supplies its own name). For an unresolved
note the button reads "Create note" and uses `obsidian://new`. Otherwise the button stays hidden.

Graph settings start open on screens 1440px and wider, closed below that, so the first view keeps
room for labels.

### Lower-level pieces

- `GraphCanvas` (`components/graph/graph-canvas.tsx`) is just the canvas, with a ref handle:
  `flyTo`, `fitToView`, `zoomBy`, `centerOn`, `reheat`, `focus`. `GraphMinimap` takes that ref.
  With `onSelect`, selection is controlled: a click or Esc proposes a change, and `selectedId`
  decides (the view uses this to keep the local graph's note selected).
- `normalizeGraph`, `findLikelyDuplicates`, `connectedComponents`, `localSubgraph` and
  `isDifferentGraph` (`normalize.ts`) and `computeInsights` (`insights.ts`) work without React.
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
