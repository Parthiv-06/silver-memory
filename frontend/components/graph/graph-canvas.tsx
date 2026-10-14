"use client";

import {
  memo,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import { NO_INSETS, type Insets } from "@/lib/graph/camera";
import { normalizeGraph, type NormalizedGraph } from "@/lib/graph/normalize";
import { groupColors as paletteFor } from "@/lib/graph/theme";
import { DEFAULT_SETTINGS, type DisplaySettings, type ForceSettings, type GraphData, type GraphNode } from "@/lib/graph/types";
import { GraphEngine, type EngineStats, type MinimapSnapshot } from "./engine";

export type { EngineStats as GraphStats } from "./engine";

/** Imperative camera controls, e.g. for search results, zoom buttons and the minimap. */
export interface GraphCanvasHandle {
  flyTo(id: string, zoom?: number): void;
  /** Frames all notes (or `ids`). With `follow`, keeps framing while the layout settles. */
  fitToView(options?: { ids?: readonly string[]; animate?: boolean; follow?: boolean }): void;
  zoomBy(factor: number): void;
  centerOn(x: number, y: number, animate?: boolean): void;
  reheat(): void;
  /** Moves keyboard focus to the canvas. */
  focus(): void;
  subscribe(listener: () => void): () => void;
  snapshot(): MinimapSnapshot | null;
}

export interface GraphCanvasProps {
  data: GraphData;
  selectedId?: string | null;
  /** Proposed selection from a click, Esc or the note list. When given, `selectedId` stays in charge. */
  onSelect?: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  onStats?: (stats: EngineStats) => void;
  /** Colour per group key; derived from `data.groups` and the default palette when omitted. */
  groupColors?: Record<string, string>;
  colorGroups?: boolean;
  display?: DisplaySettings;
  forces?: ForceSettings;
  /** Degree per note id for sizing, so filtered views keep the full graph's node sizes. */
  degrees?: ReadonlyMap<string, number>;
  /** Screen space hidden behind overlays; fit and fly-to centre on the rest. */
  insets?: Insets;
  className?: string;
  ref?: Ref<GraphCanvasHandle>;
}

function describe(graph: NormalizedGraph): string {
  const top = graph.nodes
    .map((node, i) => ({ label: node.label, degree: graph.degree[i] }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 3)
    .filter((hub) => hub.degree > 0)
    .map((hub) => `${hub.label} (${hub.degree})`);
  const links = graph.links.length;
  return `Knowledge graph: ${graph.nodes.length} notes and ${links} ${links === 1 ? "link" : "links"}.${top.length ? ` Most connected: ${top.join(", ")}.` : ""}`;
}

interface ListedNote {
  node: GraphNode;
  degree: number;
}

// Options rendered either side of the active one; aria-setsize/posinset give the full count.
const LIST_WINDOW = 15;
const PAGE_STEP = 10;

/**
 * The notes as one listbox tab stop for keyboard and screen-reader users. Only a window around the
 * active option is in the DOM, so a 5,000-note vault doesn't cost 5,000 buttons on every render.
 */
const NoteList = memo(function NoteList({
  notes,
  selectedId,
  engine,
  onSelect,
}: {
  notes: readonly ListedNote[];
  selectedId: string | null;
  engine: RefObject<GraphEngine | null>;
  onSelect?: (id: string | null) => void;
}) {
  const id = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const indexOf = useMemo(() => new Map(notes.map((note, i) => [note.node.id, i])), [notes]);
  const current = notes.length === 0 ? -1 : (activeId != null ? indexOf.get(activeId) : undefined) ?? 0;

  const activate = (index: number) => {
    const note = notes[index];
    if (!note) return;
    setActiveId(note.node.id);
    engine.current?.setKeyboardFocus(note.node.id);
  };

  const choose = (index: number) => {
    const note = notes[index];
    if (!note) return;
    engine.current?.setSelected(note.node.id);
    engine.current?.flyTo(note.node.id);
    onSelect?.(note.node.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (current < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const last = notes.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: current + 1, ArrowRight: current + 1, ArrowUp: current - 1, ArrowLeft: current - 1,
      PageDown: current + PAGE_STEP, PageUp: current - PAGE_STEP, Home: 0, End: last,
    };
    if (event.key in moves) {
      event.preventDefault();
      activate(Math.min(last, Math.max(0, moves[event.key])));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(current);
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Type-ahead: jump to the next note starting with what was typed.
      const now = event.timeStamp, state = typeahead.current;
      state.text = now - state.at < 700 ? state.text + event.key.toLowerCase() : event.key.toLowerCase();
      state.at = now;
      const from = state.text.length === 1 ? current + 1 : current;
      for (let o = 0; o < notes.length; o++) {
        const i = (from + o) % notes.length;
        if (notes[i].node.label.toLowerCase().startsWith(state.text)) {
          activate(i);
          break;
        }
      }
    }
  };

  const start = Math.max(0, current - LIST_WINDOW), end = Math.min(notes.length, current + LIST_WINDOW + 1);
  return (
    <div
      role="listbox"
      tabIndex={notes.length > 0 ? 0 : -1}
      aria-label={`Notes in the graph, ${notes.length}`}
      aria-activedescendant={current >= 0 ? `${id}-${current}` : undefined}
      className="sr-only"
      onKeyDown={onKeyDown}
      onFocus={() => current >= 0 && engine.current?.setKeyboardFocus(notes[current].node.id)}
      onBlur={() => engine.current?.setKeyboardFocus(null)}
    >
      {notes.slice(start, end).map(({ node, degree }, o) => {
        const i = start + o;
        return (
          <div
            key={node.id}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === current}
            aria-posinset={i + 1}
            aria-setsize={notes.length}
            aria-current={node.id === selectedId ? "true" : undefined}
            onClick={() => choose(i)}
          >
            {node.label}, {degree} {degree === 1 ? "link" : "links"}
            {node.unresolved ? ", no note yet" : ""}
            {node.id === selectedId ? ", selected" : ""}
          </div>
        );
      })}
    </div>
  );
});

/** Canvas 2D graph renderer with a worker-driven force layout. */
export function GraphCanvas({
  data,
  selectedId = null,
  onSelect,
  onHover,
  onStats,
  groupColors,
  colorGroups = true,
  display = DEFAULT_SETTINGS.display,
  forces = DEFAULT_SETTINGS.forces,
  degrees,
  insets = NO_INSETS,
  className,
  ref,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const helpId = useId();
  const graph = useMemo(() => normalizeGraph(data), [data]);
  const colors = useMemo(() => groupColors ?? paletteFor(graph.groups, data.groups), [groupColors, graph, data.groups]);
  // Bumped after the engine proposes a selection, so a proposal the parent ignores is undone.
  const [selectionRev, resyncSelection] = useReducer((x: number) => x + 1, 0);

  const emitSelect = useEffectEvent((id: string | null) => {
    if (!onSelect) return; // uncontrolled: the engine's own selection stands
    onSelect(id);
    resyncSelection();
  });
  const emitHover = useEffectEvent((id: string | null) => onHover?.(id));
  const emitStats = useEffectEvent((stats: EngineStats) => onStats?.(stats));

  useEffect(() => {
    const canvas = canvasRef.current!;
    const engine = new GraphEngine(
      canvas,
      { onSelect: (id) => emitSelect(id), onHover: (id) => emitHover(id), onStats: (stats) => emitStats(stats) },
      { display: DEFAULT_SETTINGS.display, forces: DEFAULT_SETTINGS.forces, colorGroups: true, groupColors: {}, insets: NO_INSETS },
    );
    engineRef.current = engine;

    const measure = (width: number, height: number, deviceWidth?: number, deviceHeight?: number) =>
      engine.resize(width, height, window.devicePixelRatio || 1, deviceWidth, deviceHeight);
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentBoxSize?.[0], device = entry.devicePixelContentBoxSize?.[0];
      measure(box?.inlineSize ?? entry.contentRect.width, box?.blockSize ?? entry.contentRect.height, device?.inlineSize, device?.blockSize);
    });
    try {
      observer.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(canvas);
    }

    // Browsers without device-pixel boxes don't report DPR changes (moving to another monitor).
    let media: MediaQueryList | null = null;
    const onDpr = () => {
      measure(canvas.clientWidth, canvas.clientHeight);
      watchDpr();
    };
    const watchDpr = () => {
      media?.removeEventListener("change", onDpr);
      media = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      media.addEventListener("change", onDpr);
    };
    watchDpr();

    return () => {
      observer.disconnect();
      media?.removeEventListener("change", onDpr);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setOptions({ display, forces, colorGroups, groupColors: colors, insets, degrees });
  }, [display, forces, colorGroups, colors, insets, degrees]);

  useEffect(() => {
    engineRef.current?.setGraph(graph);
  }, [graph]);

  useEffect(() => {
    engineRef.current?.setSelected(selectedId);
  }, [selectedId, graph, selectionRev]);

  useImperativeHandle(ref, () => ({
    flyTo: (id, zoom) => engineRef.current?.flyTo(id, zoom),
    fitToView: (options) => engineRef.current?.fitToView(options),
    zoomBy: (factor) => engineRef.current?.zoomBy(factor),
    centerOn: (x, y, animate) => engineRef.current?.centerOn(x, y, animate),
    reheat: () => engineRef.current?.reheat(),
    focus: () => canvasRef.current?.focus(),
    subscribe: (listener) => engineRef.current?.subscribe(listener) ?? (() => {}),
    snapshot: () => engineRef.current?.snapshot() ?? null,
  }), []);

  const summary = useMemo(() => describe(graph), [graph]);
  const notes = useMemo(
    () => graph.nodes.map((node, i) => ({ node, degree: graph.degree[i] })).sort((a, b) => a.node.label.localeCompare(b.node.label)),
    [graph],
  );

  return (
    <div className={className ?? "relative h-full w-full"}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={summary}
        aria-describedby={helpId}
        tabIndex={0}
        className="block h-full w-full touch-none select-none outline-none focus-visible:shadow-[inset_0_0_0_2px_#9d8cff]"
        style={{ cursor: "grab" }}
      />
      <p id={helpId} className="sr-only">
        Drag to pan, scroll to zoom. With the graph focused, arrow keys pan, plus and minus zoom and 0 fits every note.
        The list of notes that follows takes arrow keys, Home, End and type-ahead; Enter selects a note.
      </p>
      <NoteList notes={notes} selectedId={selectedId} engine={engineRef} onSelect={onSelect} />
    </div>
  );
}
