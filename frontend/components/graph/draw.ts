import type { Camera } from "@/lib/graph/camera";
import { THEME } from "@/lib/graph/theme";

/** Everything the renderer needs for one frame, as flat per-node / per-edge arrays. */
export interface Scene {
  n: number;
  /** Interleaved world x, y. */
  pos: Float32Array;
  /** World radius, node-size setting applied. */
  radius: Float32Array;
  /** Palette index per node. */
  color: Uint16Array;
  palette: readonly string[];
  /** Unresolved notes draw as dashed rings. */
  hollow: Uint8Array;
  label: readonly string[];
  /** Hubs keep their label at any zoom. */
  always: Uint8Array;
  /** 1 = full strength, 0 = faded behind the focus. Animated. */
  emphasis: Float32Array;
  /** 1 inside the focus neighbourhood (labels forced on). Animated. */
  boost: Float32Array;
  edgeSource: Uint32Array;
  edgeTarget: Uint32Array;
  edgeDir: Uint8Array;
  /** 1 when the edge touches the focus. Animated. */
  edgeHighlight: Float32Array;
  /** How strongly a focus is applied overall, 0–1. */
  dim: number;
  focus: number;
  /** The selected note keeps its label at any zoom. */
  selected: number;
  rings: readonly { index: number; alpha: number }[];
}

export interface Viewport {
  cam: Camera;
  width: number;
  height: number;
  dpr: number;
}

export interface DrawStyle {
  arrows: boolean;
  textFadeThreshold: number;
  linkThickness: number;
  fontFamily: string;
}

const TAU = Math.PI * 2;
const NODE_LEVELS = 8;
const EDGE_LEVELS = 4;
const DIM_ALPHA = 0.15;
const FILL_ALPHA = 0.9;
const LABEL_DIM_ALPHA = 0.15;
const MIN_SCREEN_RADIUS = 1.25;
const LABEL_BAND = 0.3;
const LINK_ALPHA = 0.16;
const LINK_DIM_ALPHA = 0.09;
const ACCENT_RGB = [157, 140, 255] as const;
// Above this many visible edges, the faded bulk is drawn as 1-device-pixel hairlines (Skia's fast path).
const HAIRLINE_EDGES = 1500;
// Wider strokes are flushed in short paths; one huge self-intersecting path rasterizes very slowly.
const STROKE_CHUNK = 64;

/** Reusable per-frame scratch arrays, grown on demand. */
export class DrawBuffers {
  sx = new Float32Array(0);
  sy = new Float32Array(0);
  sr = new Float32Array(0);
  visible = new Uint8Array(0);
  nodeKey = new Int32Array(0);
  nodeOrder = new Int32Array(0);
  edgeLevel = new Uint8Array(0);
  edgeOrder = new Int32Array(0);
  counts = new Int32Array(0);
  boosted = new Int32Array(0);
  boostedAlpha = new Float32Array(0);
  private strokes = new Map<number, string>();
  private fonts = { family: "", regular: "", focus: "" };

  ensure(n: number, m: number, keys: number): void {
    if (this.sx.length < n) {
      this.sx = new Float32Array(n);
      this.sy = new Float32Array(n);
      this.sr = new Float32Array(n);
      this.visible = new Uint8Array(n);
      this.nodeKey = new Int32Array(n);
      this.nodeOrder = new Int32Array(n);
      this.boosted = new Int32Array(n);
      this.boostedAlpha = new Float32Array(n);
    }
    if (this.edgeLevel.length < m) {
      this.edgeLevel = new Uint8Array(m);
      this.edgeOrder = new Int32Array(m);
    }
    if (this.counts.length < keys + 1) this.counts = new Int32Array(keys + 1);
  }

  /** Edge stroke colours, cached per (level, quantised dim, boost). */
  stroke(level: number, dim: number, boost: number): string {
    const key = (level * 65 + Math.round(dim * 64)) * 1024 + Math.min(1023, Math.round(boost * 64));
    let value = this.strokes.get(key);
    if (value === undefined) {
      if (this.strokes.size > 512) this.strokes.clear();
      value = edgeStroke(level, Math.round(dim * 64) / 64, Math.round(boost * 64) / 64);
      this.strokes.set(key, value);
    }
    return value;
  }

  font(family: string): { regular: string; focus: string } {
    if (this.fonts.family !== family) this.fonts = { family, regular: `400 11px ${family}`, focus: `500 12px ${family}` };
    return this.fonts;
  }
}

/**
 * The dot grid: one dot per tile, repeated with a pattern. The tile only changes when the pitch
 * changes by a device pixel, so zooming doesn't redraw thousands of dots or resize a large canvas.
 */
export class GridLayer {
  private tiles = new Map<number, CanvasPattern | null>();
  private dpr = 0;

  draw(ctx: CanvasRenderingContext2D, { cam, width, height, dpr }: Viewport): void {
    let pitch = 24 * cam.k;
    while (pitch < 14) pitch *= 2;
    if (!Number.isFinite(pitch)) return;
    if (dpr !== this.dpr) { this.tiles.clear(); this.dpr = dpr; }
    const size = Math.max(2, Math.round(pitch * dpr));
    let pattern = this.tiles.get(size);
    if (pattern === undefined) {
      if (this.tiles.size >= 64) this.tiles.clear();
      pattern = makeDotTile(ctx, size, dpr);
      this.tiles.set(size, pattern);
    }
    if (!pattern) return;
    // Dots sit on world multiples of the pitch; the tile's dot is at its centre.
    const mod = (v: number) => ((v % pitch) + pitch) % pitch;
    const ox = mod(-cam.x * cam.k + width / 2), oy = mod(-cam.y * cam.k + height / 2);
    pattern.setTransform(new DOMMatrix([1, 0, 0, 1, Math.round(ox * dpr - size / 2), Math.round(oy * dpr - size / 2)]));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, Math.ceil(width * dpr), Math.ceil(height * dpr));
    ctx.restore();
  }
}

function makeDotTile(ctx: CanvasRenderingContext2D, size: number, dpr: number): CanvasPattern | null {
  const tile = document.createElement("canvas");
  tile.width = tile.height = size;
  const g = tile.getContext("2d");
  if (!g) return null;
  const dot = 1.2 * dpr;
  g.fillStyle = THEME.grid;
  g.fillRect(size / 2 - dot / 2, size / 2 - dot / 2, dot, dot);
  return ctx.createPattern(tile, "repeat");
}

function edgeStroke(level: number, dim: number, boost: number): string {
  const t = level / EDGE_LEVELS;
  const base = LINK_ALPHA + (LINK_DIM_ALPHA - LINK_ALPHA) * dim;
  const r = Math.round(255 + (ACCENT_RGB[0] - 255) * t);
  const g = Math.round(255 + (ACCENT_RGB[1] - 255) * t);
  const a = Math.min(1, (base + (0.85 - base) * t) * boost);
  return `rgba(${r},${g},255,${a.toFixed(3)})`;
}

function chevron(ctx: CanvasRenderingContext2D, fromX: number, fromY: number, toX: number, toY: number, inset: number, size: number) {
  const dx = toX - fromX, dy = toY - fromY;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < inset + size * 2) return;
  const ux = dx / len, uy = dy / len;
  const tipX = toX - ux * inset, tipY = toY - uy * inset;
  const backX = tipX - ux * size, backY = tipY - uy * size;
  const wing = size * 0.62;
  ctx.moveTo(backX - uy * wing, backY + ux * wing);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(backX + uy * wing, backY - ux * wing);
}

/** Draws one frame. Edges and nodes are batched into a handful of paths by style. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: Viewport,
  style: DrawStyle,
  buffers: DrawBuffers,
  grid: GridLayer,
): void {
  const { cam, width, height, dpr } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, width, height);
  grid.draw(ctx, view);

  const { n, pos, radius, palette } = scene;
  const m = scene.edgeSource.length;
  if (n === 0) return;
  const P = palette.length + 1;
  const keyCount = (NODE_LEVELS + 1) * P;
  buffers.ensure(n, m, Math.max(keyCount, EDGE_LEVELS + 1));
  const { sx, sy, sr, visible, nodeKey, nodeOrder, edgeLevel, edgeOrder, counts } = buffers;
  const k = cam.k, hw = width / 2, hh = height / 2;

  for (let i = 0; i < n; i++) {
    const x = (pos[2 * i] - cam.x) * k + hw;
    const y = (pos[2 * i + 1] - cam.y) * k + hh;
    const r = Math.max(radius[i] * k, MIN_SCREEN_RADIUS);
    sx[i] = x;
    sy[i] = y;
    sr[i] = r;
    visible[i] = x + r > 0 && x - r < width && y + r > 0 && y - r < height ? 1 : 0;
  }

  // Edges, bucketed by highlight level.
  const zoomWidth = Math.min(1.6, Math.max(0.8, Math.sqrt(k))) * style.linkThickness;
  const arrows = style.arrows && k >= 0.45;
  const arrowSize = 5 * Math.min(1.4, Math.max(0.8, Math.sqrt(k)));
  counts.fill(0, 0, EDGE_LEVELS + 2);
  for (let e = 0; e < m; e++) {
    const s = scene.edgeSource[e], t = scene.edgeTarget[e];
    const x0 = sx[s], x1 = sx[t], y0 = sy[s], y1 = sy[t];
    if ((x0 < 0 && x1 < 0) || (x0 > width && x1 > width) || (y0 < 0 && y1 < 0) || (y0 > height && y1 > height)) {
      edgeLevel[e] = 255;
      continue;
    }
    const level = Math.round(scene.edgeHighlight[e] * EDGE_LEVELS);
    edgeLevel[e] = level;
    counts[level + 1]++;
  }
  for (let l = 0; l <= EDGE_LEVELS; l++) counts[l + 1] += counts[l];
  for (let e = 0; e < m; e++) if (edgeLevel[e] !== 255) edgeOrder[counts[edgeLevel[e]]++] = e;
  let from = 0;
  const visibleEdges = counts[EDGE_LEVELS];
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  for (let level = 0; level <= EDGE_LEVELS; level++) {
    const to = counts[level];
    if (to === from) continue;
    let width = (1 + 0.4 * (level / EDGE_LEVELS)) * zoomWidth, boost = 1;
    if (level === 0 && visibleEdges > HAIRLINE_EDGES && width * dpr > 1) {
      // Same ink, one device pixel wide.
      boost = width * dpr;
      width = 1 / dpr;
    }
    ctx.strokeStyle = buffers.stroke(level, scene.dim, boost);
    ctx.lineWidth = width;
    const chunk = width * dpr > 1 ? STROKE_CHUNK : Infinity;
    let pending = 0;
    ctx.beginPath();
    for (let o = from; o < to; o++) {
      const e = edgeOrder[o], s = scene.edgeSource[e], t = scene.edgeTarget[e];
      ctx.moveTo(sx[s], sy[s]);
      ctx.lineTo(sx[t], sy[t]);
      if (arrows) {
        const dir = scene.edgeDir[e];
        if (dir & 1) chevron(ctx, sx[s], sy[s], sx[t], sy[t], sr[t] + 2, arrowSize);
        if (dir & 2) chevron(ctx, sx[t], sy[t], sx[s], sy[s], sr[s] + 2, arrowSize);
      }
      if (++pending === chunk) {
        ctx.stroke();
        ctx.beginPath();
        pending = 0;
      }
    }
    ctx.stroke();
    from = to;
  }

  // Nodes, bucketed by (emphasis level, colour); the hollow style takes the last colour slot.
  counts.fill(0, 0, keyCount + 1);
  for (let i = 0; i < n; i++) {
    if (!visible[i]) { nodeKey[i] = -1; continue; }
    const level = Math.round(scene.emphasis[i] * NODE_LEVELS);
    const key = level * P + (scene.hollow[i] ? P - 1 : scene.color[i]);
    nodeKey[i] = key;
    counts[key + 1]++;
  }
  for (let key = 0; key < keyCount; key++) counts[key + 1] += counts[key];
  for (let i = 0; i < n; i++) if (nodeKey[i] >= 0) nodeOrder[counts[nodeKey[i]]++] = i;
  from = 0;
  for (let key = 0; key < keyCount; key++) {
    const to = counts[key];
    if (to === from) continue;
    const level = Math.floor(key / P), slot = key % P, t = level / NODE_LEVELS;
    ctx.beginPath();
    for (let o = from; o < to; o++) {
      const i = nodeOrder[o], r = sr[i];
      if (r < 2) ctx.rect(sx[i] - r, sy[i] - r, 2 * r, 2 * r);
      else {
        ctx.moveTo(sx[i] + r, sy[i]);
        ctx.arc(sx[i], sy[i], r, 0, TAU);
      }
    }
    if (slot === P - 1) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = THEME.bg;
      ctx.fill();
      ctx.globalAlpha = DIM_ALPHA + (1 - DIM_ALPHA) * t;
      ctx.strokeStyle = THEME.unresolvedStroke;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2.5, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.globalAlpha = DIM_ALPHA + (FILL_ALPHA - DIM_ALPHA) * t;
      ctx.fillStyle = palette[slot];
      ctx.fill();
    }
    from = to;
  }

  // Focus rings with a soft accent glow.
  for (const { index: i, alpha } of scene.rings) {
    if (i < 0 || i >= n || !visible[i] || alpha <= 0.01) continue;
    const r = sr[i];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = "rgba(157,140,255,0.75)";
    ctx.shadowBlur = 12 * dpr;
    ctx.beginPath();
    ctx.arc(sx[i], sy[i], r, 0, TAU);
    ctx.fillStyle = scene.hollow[i] ? THEME.bg : palette[scene.color[i]];
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(sx[i], sy[i], r + 2, 0, TAU);
    ctx.strokeStyle = THEME.text;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  drawLabels(ctx, scene, view, style, buffers);
  ctx.globalAlpha = 1;
}

function drawLabels(ctx: CanvasRenderingContext2D, scene: Scene, view: Viewport, style: DrawStyle, buffers: DrawBuffers) {
  const { width, height, cam } = view;
  const { sx, sy, sr, boosted, boostedAlpha } = buffers;
  const fonts = buffers.font(style.fontFamily);
  const fade = Math.min(1, Math.max(0, (cam.k - style.textFadeThreshold) / LABEL_BAND));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.font = fonts.regular;
  let fill = "", boostedCount = 0;

  for (let i = 0; i < scene.n; i++) {
    if (i === scene.focus) continue;
    const x = sx[i], y = sy[i] + sr[i] + 4;
    if (x < -160 || x > width + 160 || y < -16 || y > height) continue;
    const reveal = Math.max(scene.always[i] || i === scene.selected ? 1 : fade, scene.boost[i]);
    const alpha = reveal * (LABEL_DIM_ALPHA + (1 - LABEL_DIM_ALPHA) * scene.emphasis[i]);
    if (alpha < 0.02) continue;
    // The focus neighbourhood, hubs and the selection get a halo, so dense edges can't swallow them.
    if (scene.boost[i] > 0.5 || scene.always[i] || i === scene.selected) {
      boostedAlpha[boostedCount] = alpha;
      boosted[boostedCount++] = i;
      continue;
    }
    const color = scene.hollow[i] ? THEME.unresolvedLabel : THEME.label;
    if (color !== fill) ctx.fillStyle = fill = color;
    ctx.globalAlpha = alpha;
    ctx.fillText(scene.label[i], x, y);
  }

  // These sit on top, with a halo so accent links and dense edges don't cut through them.
  ctx.strokeStyle = THEME.bg;
  ctx.lineWidth = 3;
  for (let b = 0; b < boostedCount; b++) {
    const i = boosted[b];
    const x = sx[i], y = sy[i] + sr[i] + 4;
    ctx.globalAlpha = boostedAlpha[b];
    ctx.strokeText(scene.label[i], x, y);
    ctx.fillStyle = scene.hollow[i] ? THEME.unresolvedLabel : THEME.label;
    ctx.fillText(scene.label[i], x, y);
  }

  const f = scene.focus;
  if (f >= 0 && f < scene.n) {
    const x = sx[f], y = sy[f] + sr[f] + 4;
    ctx.font = fonts.focus;
    ctx.globalAlpha = 1;
    ctx.strokeText(scene.label[f], x, y);
    ctx.fillStyle = scene.hollow[f] ? THEME.unresolvedLabel : THEME.text;
    ctx.fillText(scene.label[f], x, y);
  }
}
