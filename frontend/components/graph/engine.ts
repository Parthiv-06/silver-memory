import {
  cameraPath,
  centeredOn,
  clampZoom,
  easeInOutCubic,
  easeOutCubic,
  fitCamera,
  isFiniteCamera,
  MIN_ZOOM,
  NO_INSETS,
  usableInsets,
  type Bounds,
  type Camera,
  type Insets,
} from "@/lib/graph/camera";
import { isDifferentGraph, type NormalizedGraph } from "@/lib/graph/normalize";
import { seedPositions, toForceParams, type SimFrame } from "@/lib/graph/simulation";
import { SimulationHost } from "@/lib/graph/simulation-host";
import { SpatialGrid } from "@/lib/graph/spatial-grid";
import { THEME } from "@/lib/graph/theme";
import type { DisplaySettings, ForceSettings } from "@/lib/graph/types";
import { DrawBuffers, GridLayer, drawScene, type Scene } from "./draw";

export interface EngineOptions {
  display: DisplaySettings;
  forces: ForceSettings;
  colorGroups: boolean;
  groupColors: Record<string, string>;
  insets: Insets;
  /** Degree used for node size and hub detection; defaults to the degree in the drawn graph. */
  degrees?: ReadonlyMap<string, number>;
}

export interface EngineStats {
  /** Frames drawn per second over the last busy stretch (kept while the render loop sleeps); 0 before any. */
  fps: number;
  simulating: boolean;
  sleeping: boolean;
  worker: boolean;
}

export interface EngineEvents {
  onHover(id: string | null): void;
  onSelect(id: string | null): void;
  onStats(stats: EngineStats): void;
}

export interface MinimapSnapshot {
  n: number;
  pos: Float32Array;
  color: Uint16Array;
  hollow: Uint8Array;
  palette: readonly string[];
  cam: Camera;
  width: number;
  height: number;
  /** The panels' insets that fit and fly-to honour, so the minimap can outline the uncovered area. */
  insets: Insets;
  /** Changes whenever positions, colours, camera or viewport change; equal versions draw the same. */
  version: string;
}

interface Tween {
  at(t: number): Camera;
  start: number;
  duration: number;
  ease(t: number): number;
  kind: "zoom" | "pan" | "move";
  end: Camera;
}

const TRANSITION_MS = 150;
const ALWAYS_LABELLED_MAX = 40;
const HIT_SLOP = 4;
const LABEL_MAX = 48;
const MAX_PALETTE = 65535;
// A fly-to that lands within this long before a panel opens or closes is re-aimed at the new free area.
const REAIM_MS = 300;

function approach(value: number, target: number, step: number): number {
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

function sameInsets(a: Insets, b: Insets): boolean {
  return a === b || (a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left);
}

const colorValidity = new Map<string, boolean>();
/** Whether the canvas will accept `color`; an invalid one would silently reuse the previous fill. */
function isValidColor(color: string): boolean {
  let valid = colorValidity.get(color);
  if (valid === undefined) {
    valid = typeof CSS === "undefined" || typeof CSS.supports !== "function" || CSS.supports("color", color);
    colorValidity.set(color, valid);
  }
  return valid;
}

/** Canvas renderer, camera and input for a graph; the React wrapper only feeds it props. */
export class GraphEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly host: SimulationHost;
  private readonly grid = new GridLayer();
  private readonly buffers = new DrawBuffers();
  private readonly hits = new SpatialGrid();
  private readonly listeners = new Set<() => void>();
  private readonly cleanup: (() => void)[] = [];
  private readonly reducedMotion: MediaQueryList | null;
  private destroyed = false;

  private graph: NormalizedGraph | null = null;
  private options: EngineOptions;
  private fontFamily = "ui-sans-serif, system-ui, sans-serif";
  private scene: Scene = {
    n: 0, pos: new Float32Array(0), radius: new Float32Array(0), color: new Uint16Array(0), palette: [THEME.neutralNode],
    hollow: new Uint8Array(0), label: [], always: new Uint8Array(0), emphasis: new Float32Array(0), boost: new Float32Array(0),
    edgeSource: new Uint32Array(0), edgeTarget: new Uint32Array(0), edgeDir: new Uint8Array(0), edgeHighlight: new Float32Array(0),
    dim: 0, focus: -1, selected: -1, rings: [],
  };
  private baseRadius = new Float32Array(0);
  private focusMask = new Uint8Array(0);
  private transitioning = false;
  private attrVersion = 0;
  /** Last known position of every note seen, so filtered-out notes come back where they were. */
  private posCache = new Map<string, [number, number]>();

  private frame: SimFrame | null = null;
  private pending: SimFrame | null = null;
  private posVersion = 0;
  private hitVersion = -1;
  private simActive = false;

  private cam: Camera = { x: 0, y: 0, k: 1 };
  private width = 0;
  private height = 0;
  private dpr = 1;
  private tween: Tween | null = null;
  private wheel: { k: number; sx: number; sy: number; wx: number; wy: number } | null = null;
  private inertia: { vx: number; vy: number } | null = null;
  private follow = true;
  /** The note the last fly-to aimed at, until shortly after it lands. */
  private flight: { id: string; k: number; until: number } | null = null;
  /** Zoom floor: MIN_ZOOM, or lower when the whole graph needs it to fit. */
  private minZoom = MIN_ZOOM;

  private hovered = -1;
  private selected = -1;
  private keyFocus = -1;
  private dragging = -1;
  private dragPoint: { x: number; y: number } | null = null;
  private focus = -1;
  private rings: { index: number; alpha: number }[] = [];
  private pointers = new Map<number, { x: number; y: number }>();
  private press: { id: number; x: number; y: number; node: number; moved: boolean; dx: number; dy: number } | null = null;
  private pinch: { a: number; b: number; dist: number; k: number; wx: number; wy: number } | null = null;
  private samples: { t: number; x: number; y: number }[] = [];
  private pointer: { x: number; y: number } | null = null;
  private hoverCam: Camera | null = null;
  private cursor = "";

  private raf = 0;
  private lastTime = 0;
  private frames = 0;
  private fpsStart = 0;
  private fps = 0;
  private statsKey = "";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: EngineEvents,
    options: EngineOptions,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
    this.options = options;
    this.host = new SimulationHost((frame) => this.receiveFrame(frame));
    this.reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (event: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      canvas.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => canvas.removeEventListener(type, fn as EventListener, opts));
    };
    on("pointerdown", this.onPointerDown);
    on("pointermove", this.onPointerMove);
    on("pointerup", this.onPointerUp);
    on("pointercancel", this.onPointerUp);
    on("pointerleave", this.onPointerLeave);
    on("dblclick", this.onDoubleClick);
    on("keydown", this.onKeyDown);
    // Non-passive so the page doesn't scroll while zooming.
    on("wheel", this.onWheel, { passive: false });

    this.readFont();
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (fonts) {
      const refresh = () => {
        if (this.destroyed) return;
        this.readFont();
        this.requestRender();
      };
      fonts.addEventListener("loadingdone", refresh);
      void fonts.ready.then(refresh);
      this.cleanup.push(() => fonts.removeEventListener("loadingdone", refresh));
    }
  }

  // ---- inputs from React -------------------------------------------------------------------

  resize(width: number, height: number, dpr: number, deviceWidth?: number, deviceHeight?: number): void {
    if (this.destroyed) return;
    const first = this.width === 0;
    const dw = Math.max(1, deviceWidth ?? Math.round(width * dpr)), dh = Math.max(1, deviceHeight ?? Math.round(height * dpr));
    // Assigning width/height clears the canvas, even to the same value.
    const cleared = this.canvas.width !== dw || this.canvas.height !== dh;
    if (cleared) {
      this.canvas.width = dw;
      this.canvas.height = dh;
    }
    const changed = cleared || width !== this.width || height !== this.height;
    this.width = width;
    this.height = height;
    this.dpr = dw / Math.max(1, width);
    if (first && this.scene.n > 0) this.cam = this.fitTarget();
    if (!changed) return;
    // Redraw now, inside the resize callback, so the cleared canvas is never shown for a frame.
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.render(performance.now());
  }

  setGraph(graph: NormalizedGraph): void {
    if (this.destroyed) return;
    const previous = this.graph;
    const prevIds = previous?.nodes.map((node) => node.id) ?? [];
    const keep = (index: number) => (index >= 0 ? graph.indexOf.get(prevIds[index]) ?? -1 : -1);
    const hovered = keep(this.hovered), selected = keep(this.selected), keyFocus = keep(this.keyFocus);
    this.graph = graph;
    const n = graph.nodes.length, m = graph.edgeSource.length;

    if (!previous || !sameStructure(previous, graph)) {
      let restoring = false;
      if (previous) {
        // Coming back from a much smaller view (local graph, a narrow search): put the bigger layout
        // back exactly as it was, rather than mixing in where the small view moved its few notes.
        let known = 0;
        if (previous.nodes.length * 2 <= n) for (const node of graph.nodes) if (this.posCache.has(node.id)) known++;
        restoring = previous.nodes.length * 2 <= n && known >= 0.9 * n;
        this.rememberPositions(previous, restoring);
      }
      // Carry positions over by id so filtering or switching to a local graph doesn't scramble the layout.
      const prior = new Float32Array(2 * n).fill(NaN);
      let carried = 0;
      for (let i = 0; i < n; i++) {
        const known = this.posCache.get(graph.nodes[i].id);
        if (!known) continue;
        prior[2 * i] = known[0];
        prior[2 * i + 1] = known[1];
        carried++;
      }
      const seeds = seedPositions(n, graph.edgeSource, graph.edgeTarget, prior);
      if (this.dragging >= 0) this.dragging = -1;
      this.press = null;
      this.frame = this.pending = null;
      this.scene = {
        ...this.scene,
        n,
        pos: seeds,
        radius: new Float32Array(n),
        color: new Uint16Array(n),
        hollow: new Uint8Array(n),
        always: new Uint8Array(n),
        emphasis: new Float32Array(n).fill(1),
        boost: new Float32Array(n),
        edgeSource: graph.edgeSource,
        edgeTarget: graph.edgeTarget,
        edgeDir: graph.edgeDir,
        edgeHighlight: new Float32Array(m),
        rings: [],
      };
      this.baseRadius = new Float32Array(n);
      this.focusMask = new Uint8Array(n);
      this.rings = [];
      this.focus = -1;
      this.refreshAttributes();
      this.posVersion++;
      this.simActive = n > 0;
      if (n > 0) {
        this.host.init({
          n,
          source: graph.edgeSource,
          target: graph.edgeTarget,
          weight: graph.edgeWeight,
          radius: this.baseRadius,
          positions: seeds,
          forces: toForceParams(this.options.forces, this.options.display.nodeSize),
          // A restored layout was already settled and only needs a nudge; a partial one needs more.
          alpha: restoring ? 0.12 : carried > n / 2 ? 0.35 : 1,
        });
      } else {
        // Nothing to lay out: stop the old layout so its frames don't keep arriving.
        this.host.stop();
      }
      if (!previous && this.width > 0) this.cam = this.fitTarget();
      else if (previous && isDifferentGraph(previous, graph)) {
        // Another vault was loaded: drop the old camera move and glide to frame the new layout.
        this.stopMotion();
        this.follow = true;
      }
    } else {
      this.refreshAttributes();
    }

    this.hovered = hovered;
    this.selected = selected;
    this.keyFocus = keyFocus;
    this.updateFocus(true);
    this.requestRender();
  }

  setOptions(options: EngineOptions): void {
    if (this.destroyed) return;
    const prev = this.options;
    this.options = options;
    const forcesChanged = prev.forces !== options.forces || prev.display.nodeSize !== options.display.nodeSize;
    if (forcesChanged && this.scene.n > 0) {
      this.host.setForces(toForceParams(options.forces, options.display.nodeSize), 0.3);
      this.simActive = true;
    }
    if (
      prev.colorGroups !== options.colorGroups ||
      prev.groupColors !== options.groupColors ||
      prev.degrees !== options.degrees ||
      prev.display.nodeSize !== options.display.nodeSize
    ) {
      this.refreshAttributes();
      this.hitVersion = -1;
    }
    // A panel opened or closed right as a fly-to started (e.g. double-click opens the note panel):
    // aim again at the area that is now free.
    const flight = this.flight;
    if (flight && !sameInsets(prev.insets, options.insets) && performance.now() < flight.until) {
      // By id: a filter change in the same render may have renumbered the notes.
      const index = this.graph?.indexOf.get(flight.id);
      if (index !== undefined) this.flyToIndex(index, flight.k);
    }
    this.requestRender();
  }

  setSelected(id: string | null): void {
    const index = id == null ? -1 : this.graph?.indexOf.get(id) ?? -1;
    if (index === this.selected) return;
    this.selected = index;
    this.updateFocus();
  }

  /** Keyboard focus from the accessible note list: highlight, and bring it into view if needed. */
  setKeyboardFocus(id: string | null): void {
    const index = id == null ? -1 : this.graph?.indexOf.get(id) ?? -1;
    if (index === this.keyFocus) return;
    this.keyFocus = index;
    this.updateFocus();
    if (index < 0) return;
    const { x, y } = this.toScreen(this.scene.pos[2 * index], this.scene.pos[2 * index + 1]);
    const insets = usableInsets(this.width, this.height, this.options.insets);
    if (x < insets.left + 24 || x > this.width - insets.right - 24 || y < insets.top + 24 || y > this.height - insets.bottom - 24) {
      this.flyToIndex(index, this.cam.k);
    }
  }

  // ---- camera commands -----------------------------------------------------------------------

  flyTo(id: string, zoom?: number): void {
    const index = this.graph?.indexOf.get(id);
    if (index !== undefined) this.flyToIndex(index, zoom);
  }

  fitToView({ ids, animate = true, follow = true }: { ids?: readonly string[]; animate?: boolean; follow?: boolean } = {}): void {
    const indices = ids?.map((id) => this.graph?.indexOf.get(id)).filter((i): i is number => i !== undefined);
    if (ids && !indices?.length) return;
    const target = this.fitTarget(indices, ids ? 2 : 1.6);
    this.stopMotion();
    this.follow = follow && !ids;
    this.animateTo(target, true, animate);
  }

  zoomBy(factor: number): void {
    const insets = usableInsets(this.width, this.height, this.options.insets);
    const ax = (insets.left + this.width - insets.right) / 2, ay = (insets.top + this.height - insets.bottom) / 2;
    // Repeated presses build on where the running zoom is heading, so key-repeat doesn't undershoot.
    const heading = this.tween?.kind === "zoom" ? this.tween.end.k : this.wheel?.k ?? this.cam.k;
    const anchor = this.toWorld(ax, ay);
    const from = { ...this.cam }, k1 = clampZoom(heading * factor, this.minZoom);
    this.stopMotion();
    const hw = this.width / 2, hh = this.height / 2;
    const at = (t: number): Camera => {
      const k = Math.exp(Math.log(from.k) + (Math.log(k1) - Math.log(from.k)) * t);
      return { k, x: anchor.x - (ax - hw) / k, y: anchor.y - (ay - hh) / k };
    };
    this.startTween(at, 220, easeOutCubic, "zoom", at(1));
  }

  panBy(dx: number, dy: number): void {
    const base = this.tween?.kind === "pan" ? this.tween.end : this.cam;
    const from = { ...this.cam }, to = { k: from.k, x: base.x + dx / from.k, y: base.y + dy / from.k };
    this.stopMotion();
    this.startTween((t) => ({ k: from.k, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }), 200, easeOutCubic, "pan", to);
  }

  centerOn(x: number, y: number, animate = true): void {
    this.stopMotion();
    this.animateTo(centeredOn(x, y, this.cam.k, this.width, this.height, this.options.insets), false, animate);
  }

  reheat(): void {
    if (this.scene.n === 0) return;
    this.host.reheat(1);
    this.simActive = true;
    this.requestRender();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): MinimapSnapshot {
    const { n, pos, color, hollow, palette } = this.scene;
    const { cam, width, height } = this;
    const insets = usableInsets(width, height, this.options.insets);
    const version = `${this.posVersion}|${this.attrVersion}|${cam.x}|${cam.y}|${cam.k}|${width}|${height}|${insets.top},${insets.right},${insets.bottom},${insets.left}`;
    return { n, pos, color, hollow, palette, cam, width, height, insets, version };
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const off of this.cleanup) off();
    this.listeners.clear();
    this.host.dispose();
  }

  // ---- internals -----------------------------------------------------------------------------

  private readFont(): void {
    const family = typeof getComputedStyle === "function" ? getComputedStyle(this.canvas).fontFamily : "";
    if (family) this.fontFamily = family;
  }

  /**
   * Saves the drawn layout by id; notes missing from it move with the rest of the layout. With
   * `restoring`, cached positions win and only notes the cache doesn't know are saved.
   */
  private rememberPositions(previous: NormalizedGraph, restoring: boolean): void {
    const { pos, n } = this.scene;
    if (n !== previous.nodes.length || pos.length < 2 * n) return;
    if (restoring) {
      for (let i = 0; i < n; i++) {
        const id = previous.nodes[i].id, x = pos[2 * i], y = pos[2 * i + 1];
        if (!this.posCache.has(id) && Number.isFinite(x) && Number.isFinite(y)) this.posCache.set(id, [x, y]);
      }
      return;
    }
    // How far the drawn notes drifted since they were cached (the layout re-centres as notes come
    // and go); notes that weren't drawn are shifted the same way so they stay beside their neighbours.
    let dx = 0, dy = 0, shared = 0;
    for (let i = 0; i < n; i++) {
      const known = this.posCache.get(previous.nodes[i].id);
      if (!known || !Number.isFinite(pos[2 * i]) || !Number.isFinite(pos[2 * i + 1])) continue;
      dx += pos[2 * i] - known[0];
      dy += pos[2 * i + 1] - known[1];
      shared++;
    }
    if (shared > 0 && (dx !== 0 || dy !== 0)) {
      dx /= shared;
      dy /= shared;
      for (const known of this.posCache.values()) {
        known[0] += dx;
        known[1] += dy;
      }
    }
    if (this.posCache.size > 200_000) this.posCache.clear();
    for (let i = 0; i < n; i++) {
      const x = pos[2 * i], y = pos[2 * i + 1];
      if (Number.isFinite(x) && Number.isFinite(y)) this.posCache.set(previous.nodes[i].id, [x, y]);
    }
  }

  private refreshAttributes(): void {
    const graph = this.graph;
    if (!graph) return;
    const { colorGroups, groupColors, degrees, display } = this.options;
    const palette: string[] = [];
    const slot = new Map<string, number>();
    const colorSlot = (wanted: string | undefined) => {
      const color = wanted && isValidColor(wanted) ? wanted : THEME.neutralNode;
      let i = slot.get(color);
      if (i === undefined) {
        if (palette.length >= MAX_PALETTE) return slot.get(THEME.neutralNode) ?? 0;
        i = palette.length;
        palette.push(color);
        slot.set(color, i);
      }
      return i;
    };
    // Always-labelled hubs: the "hub" group if the data has one, else the best-connected notes; capped either way.
    const hasHubGroup = graph.nodes.some((node) => node.group === "hub");
    const degreeOf = (i: number) => degrees?.get(graph.nodes[i].id) ?? graph.degree[i];
    const quota = Math.min(ALWAYS_LABELLED_MAX, Math.max(3, Math.round(graph.nodes.length * 0.02)));
    const hubs = new Set(
      graph.nodes
        .map((node, i) => ({ i, degree: degreeOf(i), eligible: hasHubGroup ? node.group === "hub" : degreeOf(i) >= 3 }))
        .filter((hub) => hub.eligible)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, quota)
        .map((hub) => hub.i),
    );
    const labels: string[] = [];
    graph.nodes.forEach((node, i) => {
      const degree = degreeOf(i);
      this.baseRadius[i] = 3 + 2.2 * Math.sqrt(degree);
      this.scene.radius[i] = this.baseRadius[i] * display.nodeSize;
      const group = node.group ?? "";
      const own = colorGroups && Object.prototype.hasOwnProperty.call(groupColors, group) ? groupColors[group] : undefined;
      this.scene.color[i] = colorSlot(typeof own === "string" ? own : undefined);
      this.scene.hollow[i] = node.unresolved ? 1 : 0;
      this.scene.always[i] = hubs.has(i) ? 1 : 0;
      labels.push(node.label.length > LABEL_MAX ? `${node.label.slice(0, LABEL_MAX - 1)}…` : node.label);
    });
    this.scene = { ...this.scene, palette: palette.length ? palette : [THEME.neutralNode], label: labels };
    this.attrVersion++;
  }

  private updateFocus(instant = false): void {
    const f = this.dragging >= 0 ? this.dragging : this.hovered >= 0 ? this.hovered : this.keyFocus >= 0 ? this.keyFocus : this.selected;
    this.scene.selected = this.selected;
    if (f !== this.focus || instant) {
      this.focus = f;
      this.scene.focus = f;
      this.focusMask.fill(0);
      if (f >= 0 && this.graph) {
        this.focusMask[f] = 1;
        for (const j of this.graph.neighbors[f]) this.focusMask[j] = 1;
      }
      this.transitioning = true;
      if (instant) this.stepTransitions(Infinity);
    }
    this.requestRender();
  }

  private addRing(index: number): void {
    if (index < 0) return;
    for (let r = 0; r < this.rings.length; r++) if (this.rings[r].index === index) return;
    this.rings.push({ index, alpha: 0 });
  }

  private wantsRing(index: number): boolean {
    return index >= 0 && (index === this.hovered || index === this.selected || index === this.keyFocus || index === this.dragging);
  }

  private stepTransitions(dt: number): boolean {
    const step = this.reducedMotion?.matches ? Infinity : dt / TRANSITION_MS;
    const f = this.focus, scene = this.scene;
    const dimTarget = f >= 0 ? 1 : 0;
    scene.dim = approach(scene.dim, dimTarget, step);
    let moving = scene.dim !== dimTarget;

    if (this.transitioning) {
      let changed = false;
      const { emphasis, boost, edgeHighlight, edgeSource, edgeTarget } = scene;
      const mask = this.focusMask;
      for (let i = 0; i < scene.n; i++) {
        const e = f < 0 || mask[i] ? 1 : 0, b = f >= 0 && mask[i] ? 1 : 0;
        if (emphasis[i] !== e) { emphasis[i] = approach(emphasis[i], e, step); changed = true; }
        if (boost[i] !== b) { boost[i] = approach(boost[i], b, step); changed = true; }
      }
      for (let e = 0; e < edgeSource.length; e++) {
        const h = f >= 0 && (edgeSource[e] === f || edgeTarget[e] === f) ? 1 : 0;
        if (edgeHighlight[e] !== h) { edgeHighlight[e] = approach(edgeHighlight[e], h, step); changed = true; }
      }
      this.transitioning = changed;
      moving ||= changed;
    }

    // Focus rings fade in and out; at most four are wanted at once.
    const rings = this.rings;
    this.addRing(this.hovered);
    this.addRing(this.selected);
    this.addRing(this.keyFocus);
    this.addRing(this.dragging);
    let kept = 0;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      const wanted = this.wantsRing(ring.index);
      const target = wanted ? 1 : 0;
      if (ring.alpha !== target) { ring.alpha = approach(ring.alpha, target, step); moving = true; }
      if (ring.alpha > 0 || wanted) rings[kept++] = ring;
    }
    rings.length = kept;
    scene.rings = rings;
    return moving;
  }

  private receiveFrame(frame: SimFrame): void {
    if (this.destroyed) return;
    if (this.pending) this.host.recycle(this.pending);
    this.pending = frame;
    this.requestRender();
  }

  private requestRender(): void {
    if (!this.raf && !this.destroyed) this.raf = requestAnimationFrame(this.render);
  }

  private render = (now: number): void => {
    this.raf = 0;
    if (this.destroyed) return;
    const dt = this.lastTime ? Math.min(64, Math.max(0, now - this.lastTime)) : 16;
    this.lastTime = now;

    if (this.pending) {
      if (this.frame) this.host.recycle(this.frame);
      this.frame = this.pending;
      this.pending = null;
      this.scene.pos = this.frame.positions;
      this.simActive = !this.frame.done;
      this.posVersion++;
    }
    const d = this.dragging;
    if (d >= 0 && this.dragPoint) {
      this.scene.pos[2 * d] = this.dragPoint.x;
      this.scene.pos[2 * d + 1] = this.dragPoint.y;
      this.posVersion++;
    }

    const cameraMoving = this.stepCamera(dt, now);
    // Notes slide under a still pointer while the layout runs or the camera moves: hit-test again.
    if (this.pointer && !this.press && !this.pinch && (this.simActive || this.cam !== this.hoverCam)) this.hover(this.pointer);
    const fading = this.stepTransitions(dt);
    if (this.width > 0) {
      drawScene(this.ctx, this.scene, { cam: this.cam, width: this.width, height: this.height, dpr: this.dpr }, {
        arrows: this.options.display.arrows,
        textFadeThreshold: this.options.display.textFadeThreshold,
        linkThickness: this.options.display.linkThickness,
        fontFamily: this.fontFamily,
      }, this.buffers, this.grid);
    }
    for (const listener of this.listeners) listener();

    this.frames++;
    if (!this.fpsStart) this.fpsStart = now;
    if (now - this.fpsStart >= 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsStart));
      this.frames = 0;
      this.fpsStart = now;
      this.reportStats(false);
    }

    if (cameraMoving || fading || this.pending || this.dragging >= 0) {
      this.requestRender();
    } else if (!this.simActive) {
      // Nothing is moving: sleep until the next input or layout frame.
      this.lastTime = 0;
      this.frames = 0;
      this.fpsStart = 0;
      this.reportStats(true);
    }
  };

  private reportStats(sleeping: boolean): void {
    const stats: EngineStats = {
      fps: this.fps,
      simulating: this.simActive,
      sleeping,
      worker: this.host.mode === "worker",
    };
    const key = `${stats.fps}|${stats.simulating}|${stats.sleeping}|${stats.worker}`;
    if (key === this.statsKey) return;
    this.statsKey = key;
    this.events.onStats(stats);
  }

  private stepCamera(dt: number, now: number): boolean {
    if (this.tween) {
      const { at, start, duration, ease } = this.tween;
      const t = duration > 0 ? Math.min(1, Math.max(0, (now - start) / duration)) : 1;
      const next = at(ease(t));
      if (isFiniteCamera(next)) this.cam = next;
      // `!(t < 1)` also ends a tween whose timing went NaN.
      if (!(t < 1) || !isFiniteCamera(next)) this.tween = null;
      return true;
    }
    if (this.wheel) {
      const { k: target, sx, sy, wx, wy } = this.wheel;
      const t = this.reducedMotion?.matches ? 1 : 1 - Math.exp(-dt / 70);
      let k = Math.exp(Math.log(this.cam.k) + (Math.log(target) - Math.log(this.cam.k)) * t);
      if (Math.abs(Math.log(target / k)) < 1e-3 || !Number.isFinite(k)) { k = target; this.wheel = null; }
      this.cam = { k, x: wx - (sx - this.width / 2) / k, y: wy - (sy - this.height / 2) / k };
      return true;
    }
    if (this.inertia) {
      const { vx, vy } = this.inertia;
      this.cam = { ...this.cam, x: this.cam.x - (vx * dt) / this.cam.k, y: this.cam.y - (vy * dt) / this.cam.k };
      const decay = Math.exp(-dt / 250);
      this.inertia = { vx: vx * decay, vy: vy * decay };
      if (Math.hypot(vx, vy) < 0.01) this.inertia = null;
      return true;
    }
    if (this.follow && this.scene.n > 0 && this.width > 0) {
      const target = this.fitTarget();
      if (!isFiniteCamera(target)) return false;
      const t = this.reducedMotion?.matches ? 1 : 1 - Math.exp(-dt / 160);
      const k = Math.exp(Math.log(this.cam.k) + Math.log(target.k / this.cam.k) * t);
      const settled = Math.abs(Math.log(target.k / k)) < 2e-3 && Math.hypot(target.x - this.cam.x, target.y - this.cam.y) * k < 0.5;
      // Once settled, stop assigning a new camera object so hover doesn't re-run every frame.
      if (!settled) this.cam = { k, x: this.cam.x + (target.x - this.cam.x) * t, y: this.cam.y + (target.y - this.cam.y) * t };
      return !settled;
    }
    return false;
  }

  private stopMotion(): void {
    this.tween = null;
    this.wheel = null;
    this.inertia = null;
    this.follow = false;
    this.flight = null;
  }

  private startTween(at: (t: number) => Camera, duration: number, ease: (t: number) => number, kind: Tween["kind"], end: Camera): void {
    const ms = this.reducedMotion?.matches || !Number.isFinite(duration) ? 0 : Math.max(0, duration);
    this.tween = { at, duration: ms, start: performance.now(), ease, kind, end };
    this.requestRender();
  }

  private animateTo(target: Camera, smoothZoom: boolean, animate: boolean): void {
    if (!isFiniteCamera(target)) return;
    if (!animate || this.width === 0 || !isFiniteCamera(this.cam)) {
      this.cam = target;
      this.requestRender();
      return;
    }
    if (smoothZoom) {
      const path = cameraPath(this.cam, target, this.width);
      const duration = Number.isFinite(path.duration) ? Math.min(1100, Math.max(350, path.duration * 0.9)) : 350;
      this.startTween(path.at, duration, easeInOutCubic, "move", target);
    } else {
      const from = { ...this.cam };
      this.startTween((t) => ({ k: from.k + (target.k - from.k) * t, x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t }), 260, easeOutCubic, "move", target);
    }
  }

  private flyToIndex(index: number, zoom?: number): void {
    const pos = this.scene.pos;
    const x = pos[2 * index], y = pos[2 * index + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const k = clampZoom(zoom ?? Math.max(this.cam.k, 1.5), this.minZoom);
    this.stopMotion();
    this.animateTo(centeredOn(x, y, k, this.width, this.height, this.options.insets), true, true);
    const duration = this.tween ? this.tween.duration : 0;
    const id = this.graph?.nodes[index]?.id;
    this.flight = id === undefined ? null : { id, k, until: performance.now() + duration + REAIM_MS };
  }

  private fitTarget(indices?: readonly number[], maxZoom = 1.6): Camera {
    const { pos, radius, n } = this.scene;
    const bounds: Bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const count = indices ? indices.length : n;
    for (let o = 0; o < count; o++) {
      const i = indices ? indices[o] : o;
      const x = pos[2 * i], y = pos[2 * i + 1], r = radius[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x - r < bounds.x0) bounds.x0 = x - r;
      if (x + r > bounds.x1) bounds.x1 = x + r;
      if (y - r < bounds.y0) bounds.y0 = y - r;
      if (y + r + 16 > bounds.y1) bounds.y1 = y + r + 16;
    }
    if (!Number.isFinite(bounds.x0) || this.width === 0) return { ...this.cam };
    const target = fitCamera(bounds, this.width, this.height, this.options.insets ?? NO_INSETS, 48, maxZoom);
    if (!indices) this.minZoom = Math.min(MIN_ZOOM, target.k * 0.8);
    return target;
  }

  private toWorld(sx: number, sy: number) {
    const { x, y, k } = this.cam;
    return { x: (sx - this.width / 2) / k + x, y: (sy - this.height / 2) / k + y };
  }

  private toScreen(wx: number, wy: number) {
    const { x, y, k } = this.cam;
    return { x: (wx - x) * k + this.width / 2, y: (wy - y) * k + this.height / 2 };
  }

  private local(event: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private hitTest(sx: number, sy: number): number {
    const n = this.scene.n;
    if (n === 0) return -1;
    if (this.hitVersion !== this.posVersion) {
      this.hits.build(this.scene.pos, this.scene.radius, n);
      this.hitVersion = this.posVersion;
    }
    const { x, y } = this.toWorld(sx, sy);
    return this.hits.hit(x, y, HIT_SLOP / this.cam.k, 1.25 / this.cam.k);
  }

  private setCursor(cursor: string): void {
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.canvas.style.cursor = cursor;
  }

  private hover(point: { x: number; y: number }): void {
    this.hoverCam = this.cam;
    const index = this.hitTest(point.x, point.y);
    this.setCursor(index >= 0 ? "pointer" : "grab");
    if (index === this.hovered) return;
    this.hovered = index;
    this.events.onHover(index >= 0 ? this.graph!.nodes[index].id : null);
    this.updateFocus();
  }

  /** Proposes a selection; React decides, and `setSelected` brings the engine in line. */
  private select(index: number): void {
    this.selected = index;
    this.updateFocus();
    this.events.onSelect(index >= 0 ? this.graph!.nodes[index].id : null);
  }

  private startPinch(a: number, b: number): void {
    const pa = this.pointers.get(a), pb = this.pointers.get(b);
    if (!pa || !pb) return;
    const mid = this.toWorld((pa.x + pb.x) / 2, (pa.y + pb.y) / 2);
    this.pinch = { a, b, dist: Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y)), k: this.cam.k, wx: mid.x, wy: mid.y };
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = this.local(event);
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, point);
    this.stopMotion();

    if (this.pointers.size >= 2) {
      // Second finger: switch from drag/pan to pinch. A third finger joins nothing.
      if (this.pinch) return;
      if (this.dragging >= 0) this.endDrag();
      this.press = null;
      const [a, b] = [...this.pointers.keys()];
      this.startPinch(a, b);
      return;
    }
    const node = this.hitTest(point.x, point.y);
    const world = this.toWorld(point.x, point.y);
    const pos = this.scene.pos;
    this.press = {
      id: event.pointerId,
      x: point.x,
      y: point.y,
      node,
      moved: false,
      dx: node >= 0 ? pos[2 * node] - world.x : 0,
      dy: node >= 0 ? pos[2 * node + 1] - world.y : 0,
    };
    this.samples = [{ t: event.timeStamp, ...point }];
  };

  private onPointerMove = (event: PointerEvent): void => {
    const point = this.local(event);
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, point);

    const pinch = this.pinch;
    if (pinch) {
      const a = this.pointers.get(pinch.a), b = this.pointers.get(pinch.b);
      if (!a || !b || (event.pointerId !== pinch.a && event.pointerId !== pinch.b)) return;
      const k = clampZoom(pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist), this.minZoom);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.cam = { k, x: pinch.wx - (mx - this.width / 2) / k, y: pinch.wy - (my - this.height / 2) / k };
      this.requestRender();
      return;
    }

    const press = this.press;
    if (press && press.id === event.pointerId) {
      if (!press.moved) {
        const slop = event.pointerType === "touch" ? 8 : 3;
        if (Math.hypot(point.x - press.x, point.y - press.y) < slop) return;
        press.moved = true;
        this.setCursor("grabbing");
        if (press.node >= 0) {
          this.dragging = press.node;
          this.updateFocus();
        }
      }
      if (this.dragging >= 0) {
        const world = this.toWorld(point.x, point.y);
        this.dragPoint = { x: world.x + press.dx, y: world.y + press.dy };
        this.host.pin(this.dragging, this.dragPoint.x, this.dragPoint.y);
        this.simActive = true;
      } else {
        const last = this.samples[this.samples.length - 1];
        this.cam = { ...this.cam, x: this.cam.x - (point.x - last.x) / this.cam.k, y: this.cam.y - (point.y - last.y) / this.cam.k };
        this.samples.push({ t: event.timeStamp, ...point });
        if (this.samples.length > 8) this.samples.shift();
      }
      this.requestRender();
      return;
    }

    if (event.pointerType !== "touch") {
      this.pointer = point;
      this.hover(point);
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    const pinch = this.pinch;
    if (pinch) {
      if (event.pointerId !== pinch.a && event.pointerId !== pinch.b) return;
      const rest = [...this.pointers.keys()];
      if (rest.length >= 2) {
        // A finger of the pinch lifted while two others are down: pinch with those, from here.
        this.startPinch(rest[0], rest[1]);
      } else {
        this.pinch = null;
        const remaining = rest.length === 1 ? this.pointers.get(rest[0]) : undefined;
        // The finger still down carries on panning (it was never a tap).
        this.press = remaining ? { id: rest[0], x: remaining.x, y: remaining.y, node: -1, moved: true, dx: 0, dy: 0 } : null;
        this.samples = remaining ? [{ t: event.timeStamp, ...remaining }] : [];
      }
      return;
    }
    const press = this.press;
    if (!press || press.id !== event.pointerId) return;
    this.press = null;
    const point = this.local(event);

    if (this.dragging >= 0) {
      this.endDrag();
    } else if (!press.moved) {
      if (event.type === "pointerup") this.select(press.node);
    } else {
      const recent = this.samples.filter((s) => event.timeStamp - s.t < 100);
      if (recent.length >= 2 && !this.reducedMotion?.matches) {
        const a = recent[0], b = recent[recent.length - 1], span = Math.max(1, b.t - a.t);
        const vx = (b.x - a.x) / span, vy = (b.y - a.y) / span;
        if (Math.hypot(vx, vy) > 0.25) this.inertia = { vx, vy };
      }
    }
    if (event.pointerType !== "touch") this.hover(point);
    this.requestRender();
  };

  private onPointerLeave = (): void => {
    this.pointer = null;
    if (this.press || this.hovered < 0) return;
    this.hovered = -1;
    this.events.onHover(null);
    this.updateFocus();
  };

  private endDrag(): void {
    this.host.unpin(this.dragging);
    this.dragging = -1;
    this.dragPoint = null;
    this.setCursor("grab");
    this.updateFocus();
  }

  private onDoubleClick = (event: MouseEvent): void => {
    const point = this.local(event);
    const index = this.hitTest(point.x, point.y);
    if (index < 0) return;
    if (index !== this.selected) this.select(index);
    this.flyToIndex(index, Math.max(this.cam.k, 1.8));
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1;
    this.tween = null;
    this.inertia = null;
    this.follow = false;
    this.flight = null;
    if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      this.wheel = null;
      this.cam = { ...this.cam, x: this.cam.x + (event.deltaX * unit) / this.cam.k };
      this.requestRender();
      return;
    }
    const point = this.local(event);
    const anchor = this.toWorld(point.x, point.y);
    const factor = Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.0015));
    if (!this.wheel) this.fitTarget();
    this.wheel = { k: clampZoom((this.wheel?.k ?? this.cam.k) * factor, this.minZoom), sx: point.x, sy: point.y, wx: anchor.x, wy: anchor.y };
    this.requestRender();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const step = 80;
    switch (event.key) {
      case "ArrowLeft": this.panBy(-step, 0); break;
      case "ArrowRight": this.panBy(step, 0); break;
      case "ArrowUp": this.panBy(0, -step); break;
      case "ArrowDown": this.panBy(0, step); break;
      case "+":
      case "=": this.zoomBy(1.25); break;
      case "-":
      case "_": this.zoomBy(0.8); break;
      case "0": this.fitToView(); break;
      case "Escape":
        if (this.selected < 0) return;
        this.select(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };
}

function sameStructure(a: NormalizedGraph, b: NormalizedGraph): boolean {
  if (a.nodes.length !== b.nodes.length || a.edgeSource.length !== b.edgeSource.length) return false;
  for (let i = 0; i < a.nodes.length; i++) if (a.nodes[i].id !== b.nodes[i].id) return false;
  for (let e = 0; e < a.edgeSource.length; e++) {
    if (a.edgeSource[e] !== b.edgeSource[e] || a.edgeTarget[e] !== b.edgeTarget[e] || a.edgeDir[e] !== b.edgeDir[e]) return false;
  }
  return true;
}
