"use client";

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { cn } from "@/lib/utils";
import type { Insets } from "@/lib/graph/camera";
import { filterGraph } from "@/lib/graph/filter";
import { computeInsights, type GraphInsights } from "@/lib/graph/insights";
import { normalizeGraph, type NormalizedGraph } from "@/lib/graph/normalize";
import { THEME_VARS, UNGROUPED, UNRESOLVED_GROUP, groupColors, groupLabel } from "@/lib/graph/theme";
import { resolveSettings, type FilterSettings, type GraphData, type GraphSettings, type PartialSettings } from "@/lib/graph/types";
import { CommandSearch, type SearchItem } from "./command-search";
import { GraphCanvas, type GraphCanvasHandle, type GraphStats } from "./graph-canvas";
import { GraphMinimap } from "./graph-minimap";
import { GraphSidebar } from "./graph-sidebar";
import styles from "./graph-view.module.css";
import { NotePanel, type LinkedNote } from "./note-panel";
import { SettingsPanel, type GroupRow, type SettingsChange } from "./settings-panel";
import { IconButton, focusRing } from "./ui";

export interface GraphViewProps {
  data: GraphData;
  /** Called by the note panel's "Open note" button; the button is hidden without it. */
  onOpenNote?: (id: string) => void;
  initialSelectedId?: string;
  initialSettings?: PartialSettings;
  showSidebar?: boolean;
  /** Heading shown at the top of the sidebar. */
  title?: string;
  className?: string;
}

interface Store<T> {
  get: () => T;
  set: (value: T) => void;
  subscribe: (listener: () => void) => () => void;
}

// Perf numbers change twice a second; a tiny store keeps them from re-rendering the whole view.
function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function useMediaQuery(query: string, serverValue: boolean): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const media = matchMedia(query);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => serverValue);
}

const subscribeNever = () => () => {};
const subscribeResize = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};
const isMacPlatform = () => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** Hubs and topic groups first, catch-alls next, unresolved last; first-seen order within each. */
function orderGroups(groups: readonly string[]): string[] {
  const rank = (group: string) => (group === UNRESOLVED_GROUP ? 2 : group === "misc" || group === UNGROUPED ? 1 : 0);
  return [...groups].sort((a, b) => rank(a) - rank(b));
}

const NO_INSIGHTS: GraphInsights = { duplicates: [], unresolved: [], clusters: [], orphans: [], hubs: [] };
// Above this many notes, insights (duplicate detection is the slow part) wait for an idle moment
// instead of delaying the first frame of the graph.
const DEFER_INSIGHTS_ABOVE = 1500;

function whenIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(callback, { timeout: 1000 });
    return () => cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 50);
  return () => window.clearTimeout(handle);
}

function useInsights(graph: NormalizedGraph): GraphInsights {
  const defer = graph.nodes.length > DEFER_INSIGHTS_ABOVE;
  const now = useMemo(() => (defer ? null : computeInsights(graph)), [graph, defer]);
  const [later, setLater] = useState<{ graph: NormalizedGraph; insights: GraphInsights } | null>(null);
  useEffect(() => {
    if (!defer) return;
    return whenIdle(() => setLater({ graph, insights: computeInsights(graph) }));
  }, [graph, defer]);
  return now ?? (later?.graph === graph ? later.insights : NO_INSIGHTS);
}

function isShown(graph: NormalizedGraph, settings: GraphSettings, id: string): boolean {
  return filterGraph(graph, settings.filters, settings.groups.hidden).nodes.some((node) => node.id === id);
}

/** Settings with whatever hides note `index` switched off (search cleared, its group shown, …). */
function revealed(graph: NormalizedGraph, current: GraphSettings, index: number): GraphSettings {
  const node = graph.nodes[index];
  if (isShown(graph, current, node.id)) return current;
  const patched: GraphSettings = {
    ...current,
    filters: {
      ...current.filters,
      search: "",
      showUnresolved: current.filters.showUnresolved || !!node.unresolved,
      showOrphans: current.filters.showOrphans || graph.degree[index] === 0,
    },
    groups: { ...current.groups, hidden: current.groups.hidden.filter((group) => group !== node.group) },
  };
  if (isShown(graph, patched, node.id)) return patched;
  return { ...patched, filters: { ...patched.filters, showOrphans: true, showUnresolved: true } };
}

function PerfChip({ stats, notes, links, total }: { stats: Store<GraphStats | null>; notes: number; links: number; total: number }) {
  const value = useSyncExternalStore(stats.subscribe, stats.get, stats.get);
  // While drawing sleeps, the rate of the last movement stays up (dimmed dot) instead of "0 fps".
  const rate = !value ? "…" : value.fps > 0 ? `${value.fps} fps` : value.sleeping ? "idle" : "…";
  return (
    <div
      className={cn(styles.glass, styles.mono, "flex h-8 items-center gap-2 whitespace-nowrap rounded-[8px] px-3 text-[12px] text-(--g-text-2)")}
      title={`${value?.worker === false ? "Layout runs on the main thread" : "Layout runs in a Web Worker"}; drawing sleeps when nothing moves, and the rate shown is from the last movement`}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", value?.simulating ? cn("bg-(--g-accent)", styles.pulse) : "bg-(--g-text-3)")} />
      <span>
        {notes === total ? notes : `${notes}/${total}`} notes<span className="max-sm:hidden"> · {links} links</span> · {rate}
      </span>
    </div>
  );
}

const Canvas = memo(GraphCanvas);

/** Obsidian-style graph view: canvas, command search, settings, note details, insights and minimap. */
export function GraphView({
  data,
  onOpenNote,
  initialSelectedId,
  initialSettings,
  showSidebar = true,
  title = "Knowledge graph",
  className,
}: GraphViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<GraphCanvasHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsToggleRef = useRef<HTMLButtonElement>(null);
  // A camera move waiting for the render that opens the note panel (and maybe reveals the note),
  // so it aims at the space the panels leave free afterwards, not before.
  const pendingCamera = useRef<{ id: string } | { ids: string[] } | null>(null);
  const [cameraRequest, requestCamera] = useReducer((x: number) => x + 1, 0);

  const graph = useMemo(() => normalizeGraph(data), [data]);
  const insights = useInsights(graph);
  const colors = useMemo(() => groupColors(graph.groups, data.groups), [graph, data.groups]);
  const degrees = useMemo(() => new Map(graph.nodes.map((node, i) => [node.id, graph.degree[i]])), [graph]);
  const groups = useMemo<GroupRow[]>(() => {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) counts.set(node.group!, (counts.get(node.group!) ?? 0) + 1);
    return orderGroups(graph.groups).map((key) => ({
      key,
      label: groupLabel(key, data.groups),
      color: colors[key],
      count: counts.get(key) ?? 0,
      hollow: key === UNRESOLVED_GROUP,
    }));
  }, [graph, colors, data.groups]);
  const searchItems = useMemo<SearchItem[]>(
    () => graph.nodes.map((node, i) => ({
      id: node.id,
      label: node.label,
      group: groupLabel(node.group!, data.groups),
      color: colors[node.group!],
      hollow: !!node.unresolved,
      degree: graph.degree[i],
    })),
    [graph, colors, data.groups],
  );

  const [settings, setSettings] = useState(() => resolveSettings(initialSettings));
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [local, setLocal] = useState({ on: false, depth: 1 });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  const [stats] = useState(() => createStore<GraphStats | null>(null));
  // Same breakpoint as Tailwind's `md`, where the note panel turns into a bottom sheet.
  const desktop = useMediaQuery("(min-width: 768px)", true);
  // Settings start open only where the canvas keeps room for labels beside both panels.
  const roomy = useMediaQuery("(min-width: 1440px)", true);
  const isMac = useSyncExternalStore(subscribeNever, isMacPlatform, () => false);
  const viewportHeight = useSyncExternalStore(subscribeResize, () => window.innerHeight, () => 800);
  const showSettings = settingsOpen ?? roomy;

  const selectedIndex = selectedId == null ? undefined : graph.indexOf.get(selectedId);
  const selected = selectedIndex === undefined ? null : graph.nodes[selectedIndex];
  const { filters, groups: groupSettings, display, forces } = settings;
  // Typing in the name filter stays responsive on big vaults: the graph catches up a beat later.
  const search = useDeferredValue(filters.search);
  const appliedFilters = useMemo<FilterSettings>(
    () => ({ search, showOrphans: filters.showOrphans, showUnresolved: filters.showUnresolved }),
    [search, filters.showOrphans, filters.showUnresolved],
  );
  const localView = useMemo(
    () => (local.on && selected ? { focusId: selected.id, depth: local.depth } : null),
    [local.on, local.depth, selected],
  );
  const visible = useMemo(
    () => filterGraph(graph, appliedFilters, groupSettings.hidden, localView),
    [graph, appliedFilters, groupSettings.hidden, localView],
  );
  const visibleIds = useMemo(() => new Set(visible.nodes.map((node) => node.id)), [visible]);

  // Fit and fly-to aim at the part of the canvas no panel covers; below `md` the note panel is a bottom sheet.
  const insets = useMemo<Insets>(
    () => desktop
      ? { top: 60, bottom: 56, left: selected ? 320 : 0, right: showSettings ? 312 : 0 }
      : { top: 60, bottom: selected ? Math.round(viewportHeight * 0.45) + 64 : 56, left: 0, right: 0 },
    [desktop, selected, showSettings, viewportHeight],
  );

  const change = useCallback<SettingsChange>((section, patch) => {
    setSettings((current) => ({ ...current, [section]: { ...current[section], ...patch } }));
  }, []);

  /** Select a note and bring it into view, revealing it first if filters hide it. */
  const pick = useCallback((id: string) => {
    const index = graph.indexOf.get(id);
    if (index === undefined) return;
    setSelectedId(id);
    if (local.on) return; // the local graph re-centres on the new selection and refits itself
    pendingCamera.current = { id };
    requestCamera();
    setSettings((current) => revealed(graph, current, index));
  }, [graph, local.on]);

  const showCluster = useCallback((ids: string[]) => {
    setSelectedId(ids[0]);
    pendingCamera.current = { ids };
    requestCamera();
  }, []);

  const onCanvasSelect = useCallback((id: string | null) => {
    // In a local graph, clicking empty space shouldn't throw you back to the whole vault.
    if (id === null && local.on) return;
    setSelectedId(id);
  }, [local.on]);

  // Runs after GraphCanvas has applied this render's insets and visible notes (child effects run first).
  useEffect(() => {
    const request = pendingCamera.current;
    if (!request) return;
    if ("id" in request) {
      if (request.id !== selectedId) { pendingCamera.current = null; return; } // superseded
      if (!visibleIds.has(request.id)) return; // the reveal hasn't rendered yet
      pendingCamera.current = null;
      canvasRef.current?.flyTo(request.id);
    } else {
      pendingCamera.current = null;
      canvasRef.current?.fitToView({ ids: request.ids });
    }
  }, [cameraRequest, selectedId, insets, visibleIds]);

  // Entering, leaving or re-centring the local graph reframes the camera.
  const localKey = localView ? `${localView.focusId}:${localView.depth}` : "";
  const lastLocalKey = useRef(localKey);
  useEffect(() => {
    if (lastLocalKey.current === localKey) return;
    lastLocalKey.current = localKey;
    canvasRef.current?.fitToView({ follow: true });
  }, [localKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      const root = rootRef.current, active = document.activeElement;
      if (!root || (active && active !== document.body && !root.contains(active))) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const panel = useMemo(() => {
    if (selectedIndex === undefined) return null;
    const item = (i: number): LinkedNote => ({ node: graph.nodes[i], degree: graph.degree[i] });
    const order = (a: LinkedNote, b: LinkedNote) => b.degree - a.degree || a.node.label.localeCompare(b.node.label);
    const id = graph.nodes[selectedIndex].id;
    const pair = insights.duplicates.find((d) => d.a.id === id || d.b.id === id);
    return {
      outgoing: graph.outgoing[selectedIndex].map(item).sort(order),
      incoming: graph.incoming[selectedIndex].map(item).sort(order),
      duplicateOf: pair ? (pair.a.id === id ? pair.b : pair.a) : undefined,
    };
  }, [graph, selectedIndex, insights]);

  const resetFilters = () =>
    setSettings((current) => ({ ...current, filters: resolveSettings(initialSettings).filters, groups: { ...current.groups, hidden: [] } }));

  const closeSettings = () => {
    setSettingsOpen(false);
    settingsToggleRef.current?.focus();
  };

  const closeNote = () => {
    setSelectedId(null);
    setLocal((current) => ({ ...current, on: false }));
    canvasRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={cn(styles.root, "relative flex h-full w-full overflow-hidden", className)}
      style={THEME_VARS as CSSProperties}
    >
      {showSidebar && sidebarOpen && (
        <GraphSidebar
          title={title}
          graph={graph}
          insights={insights}
          groups={groups}
          colors={colors}
          selectedId={selected?.id ?? null}
          onPick={pick}
          onShowCluster={showCluster}
        />
      )}

      <div className="relative min-w-0 flex-1">
        <Canvas
          ref={canvasRef}
          data={visible}
          selectedId={selected?.id ?? null}
          onSelect={onCanvasSelect}
          onStats={stats.set}
          groupColors={colors}
          colorGroups={groupSettings.colorGroups}
          display={display}
          forces={forces}
          degrees={degrees}
          insets={insets}
          className="absolute inset-0"
        />

        <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-center gap-2">
          {showSidebar && (
            <div className={cn(styles.glass, "pointer-events-auto rounded-[8px] p-0.5 max-md:hidden")}>
              <IconButton icon="sidebar" label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} pressed={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)} />
            </div>
          )}
          <div className="pointer-events-auto mx-auto w-full max-w-[420px]">
            <CommandSearch
              items={searchItems}
              onPick={pick}
              onDismiss={() => canvasRef.current?.focus()}
              shortcut={isMac ? "⌘K" : "Ctrl K"}
              inputRef={searchRef}
            />
          </div>
          <div className={cn(styles.glass, "pointer-events-auto rounded-[8px] p-0.5")}>
            <IconButton
              ref={settingsToggleRef}
              icon="sliders"
              label={showSettings ? "Hide graph settings" : "Show graph settings"}
              pressed={showSettings}
              onClick={() => setSettingsOpen(!showSettings)}
            />
          </div>
        </div>

        {showSettings && (
          <SettingsPanel
            settings={settings}
            groups={groups}
            onChange={change}
            onReset={() => setSettings(resolveSettings(initialSettings))}
            onRerun={() => {
              canvasRef.current?.reheat();
              canvasRef.current?.fitToView({ follow: true });
            }}
            onClose={closeSettings}
            className="absolute right-3 top-[60px] z-10 max-h-[calc(100%-200px)] min-h-[220px]"
          />
        )}

        {selected && panel && (
          <NotePanel
            node={selected}
            groupLabel={groupLabel(selected.group!, data.groups)}
            colors={colors}
            degree={graph.degree[selectedIndex!]}
            outgoing={panel.outgoing}
            incoming={panel.incoming}
            duplicateOf={panel.duplicateOf}
            local={local.on}
            depth={local.depth}
            onLocalChange={(on) => setLocal((current) => ({ ...current, on }))}
            onDepthChange={(depth) => setLocal((current) => ({ ...current, depth }))}
            onPick={pick}
            onFly={() => canvasRef.current?.flyTo(selected.id)}
            onOpen={onOpenNote ? () => onOpenNote(selected.id) : undefined}
            onClose={closeNote}
            className="absolute left-3 top-[60px] z-10 max-h-[calc(100%-116px)] max-md:inset-x-3 max-md:bottom-14 max-md:top-auto max-md:max-h-[45%] max-md:w-auto max-md:max-w-none"
          />
        )}

        {visible.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-0 grid place-items-center">
            <div className={cn(styles.glass, "pointer-events-auto px-5 py-4 text-center")}>
              {graph.nodes.length === 0 ? (
                <p className="text-[13px] text-(--g-text)">This graph has no notes yet.</p>
              ) : (
                <>
                  <p className="text-[13px] text-(--g-text)">No notes match these filters.</p>
                  <button type="button" onClick={resetFilters} className={cn("mt-2 rounded-[6px] text-[13px] text-(--g-accent-text) hover:underline", focusRing)}>
                    Reset filters
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex items-end gap-2">
          <div className="pointer-events-auto">
            <PerfChip stats={stats} notes={visible.nodes.length} links={visible.links.length} total={graph.nodes.length} />
          </div>
          <div className="ml-auto flex items-end gap-2">
            {display.minimap && (
              // Below md the note panel is a full-width bottom sheet, which the minimap would cover.
              <div className={cn(styles.glass, "pointer-events-auto overflow-hidden max-md:hidden")}>
                <GraphMinimap graph={canvasRef} />
              </div>
            )}
            <div role="group" aria-label="Zoom" className={cn(styles.glass, "pointer-events-auto flex flex-col gap-0.5 p-1 max-md:flex-row")}>
              <IconButton icon="plus" label="Zoom in" shortcut="+" onClick={() => canvasRef.current?.zoomBy(1.4)} />
              <IconButton icon="minus" label="Zoom out" shortcut="−" onClick={() => canvasRef.current?.zoomBy(1 / 1.4)} />
              <IconButton icon="fit" label="Fit to view" shortcut="0" onClick={() => canvasRef.current?.fitToView({ follow: true })} />
            </div>
          </div>
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {selected ? `${selected.label} selected, ${graph.degree[selectedIndex!]} links.` : ""}
      </p>
    </div>
  );
}
