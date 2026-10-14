import type { ForceSettings } from "./types";

/** Physical parameters; `toForceParams` maps the UI sliders onto them. */
export interface ForceParams {
  /** Pull toward the origin, 0–1. */
  center: number;
  /** Many-body repulsion, 0–20. */
  repel: number;
  /** Link spring stiffness, 0–1 (scaled per link by 1 / min(degree), like d3). */
  link: number;
  /** Rest length of a link between two dots, in world px. */
  linkDistance: number;
  collide: boolean;
  /** Multiplies node radii for collision and link rest length. */
  radiusScale: number;
}

export interface SimulationInput {
  n: number;
  source: Uint32Array;
  target: Uint32Array;
  weight?: Float32Array;
  /** Base node radius in world px. */
  radius: Float32Array;
  /** Interleaved x, y per node; see `seedPositions`. */
  positions: Float32Array;
  forces: ForceParams;
  alpha?: number;
}

export function toForceParams(forces: ForceSettings, nodeSize = 1): ForceParams {
  return {
    center: forces.centerForce,
    repel: forces.repelForce,
    link: forces.linkForce,
    linkDistance: forces.linkDistance,
    collide: forces.collision,
    radiusScale: nodeSize,
  };
}

const THETA2 = 0.9 * 0.9;
const DISTANCE_MIN2 = 1;
const EXACT_LIMIT = 400;
const MAX_DEPTH = 32;
const REPEL_SCALE = 14;
const GRAVITY_SCALE = 0.12;
const COLLIDE_STRENGTH = 0.7;
const COLLIDE_PADDING = 2;
// Notes above this percentile of collision radius skip the grid (see updateCollision).
const LARGE_PERCENTILE = 0.98;

// Tiny deterministic offsets that separate coincident points.
function jiggle(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * 1e-6;
}

/**
 * Deterministic starting positions. Nodes with a prior position keep it; new nodes next to a placed
 * neighbour start beside it; the rest are laid on a phyllotaxis spiral in BFS order from the hubs,
 * so related notes start close and the layout settles quickly.
 */
export function seedPositions(n: number, source: Uint32Array, target: Uint32Array, prior?: Float32Array): Float32Array {
  const out = new Float32Array(2 * n);
  const placed = new Uint8Array(n);
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < source.length; e++) {
    adjacency[source[e]].push(target[e]);
    adjacency[target[e]].push(source[e]);
  }
  let placedCount = 0;
  for (let i = 0; i < n; i++) {
    const x = prior?.[2 * i], y = prior?.[2 * i + 1];
    if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
      out[2 * i] = x;
      out[2 * i + 1] = y;
      placed[i] = 1;
      placedCount++;
    }
  }

  const golden = Math.PI * (3 - Math.sqrt(5));
  if (placedCount > 0) {
    // Grow outward from what is already placed.
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < n; i++) {
        if (placed[i]) continue;
        const anchor = adjacency[i].find((j) => placed[j]);
        if (anchor === undefined) continue;
        const angle = i * golden;
        out[2 * i] = out[2 * anchor] + Math.cos(angle) * 18;
        out[2 * i + 1] = out[2 * anchor + 1] + Math.sin(angle) * 18;
        placed[i] = 1;
        progress = true;
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => adjacency[b].length - adjacency[a].length);
  const visited = new Uint8Array(n);
  let k = 0;
  for (const root of order) {
    if (visited[root]) continue;
    const queue = [root];
    visited[root] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      if (!placed[i]) {
        const r = 10 * Math.sqrt(0.5 + k), angle = k * golden;
        out[2 * i] = r * Math.cos(angle);
        out[2 * i + 1] = r * Math.sin(angle);
        placed[i] = 1;
        k++;
      }
      for (const j of adjacency[i]) if (!visited[j]) { visited[j] = 1; queue.push(j); }
    }
  }
  return out;
}

/** d3-force semantics on typed arrays: many-body (Barnes–Hut above 400 nodes), links, gravity, collision. */
export class ForceSimulation {
  readonly n: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly fixed: Uint8Array;
  alpha: number;
  alphaMin = 0.001;
  alphaDecay = 1 - Math.pow(0.001, 1 / 300);
  alphaTarget = 0;
  velocityDecay = 0.4;

  private readonly source: Uint32Array;
  private readonly target: Uint32Array;
  private readonly weight: Float32Array | undefined;
  private readonly radius: Float32Array;
  private readonly count: Uint32Array;
  private readonly linkStrength: Float32Array;
  private readonly linkBias: Float32Array;
  private readonly linkLength: Float32Array;
  private readonly fx: Float32Array;
  private readonly fy: Float32Array;
  private pinned = 0;
  private forces: ForceParams;

  // Quadtree, rebuilt every tick. child: -1 empty, >= 0 cell index, <= -2 point -(i + 2).
  private child = new Int32Array(0);
  private cellSize = new Float32Array(0);
  private cellMass = new Float32Array(0);
  private cellX = new Float32Array(0);
  private cellY = new Float32Array(0);
  private cells = 0;
  private readonly next: Int32Array;
  private readonly stack: Int32Array;

  // Collision radii and grid scratch space.
  private collideR = new Float32Array(0);
  private large = new Int32Array(0);
  private smallMax = 0;
  private gridStart = new Int32Array(0);
  private gridFill = new Int32Array(0);
  private readonly gridItems: Int32Array;
  private readonly gridCell: Int32Array;

  constructor(input: SimulationInput) {
    const { n } = input;
    this.n = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = input.positions[2 * i];
      this.y[i] = input.positions[2 * i + 1];
    }
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.fixed = new Uint8Array(n);
    this.fx = new Float32Array(n);
    this.fy = new Float32Array(n);
    this.source = input.source;
    this.target = input.target;
    this.weight = input.weight;
    this.radius = input.radius;
    this.alpha = input.alpha ?? 1;
    this.forces = input.forces;
    this.next = new Int32Array(n);
    this.stack = new Int32Array(MAX_DEPTH * 4 + 8);
    this.gridItems = new Int32Array(n);
    this.gridCell = new Int32Array(n);

    const m = input.source.length;
    this.count = new Uint32Array(n);
    for (let e = 0; e < m; e++) {
      this.count[input.source[e]]++;
      this.count[input.target[e]]++;
    }
    this.linkStrength = new Float32Array(m);
    this.linkBias = new Float32Array(m);
    this.linkLength = new Float32Array(m);
    this.updateLinks();
    this.updateCollision();
  }

  get active(): boolean {
    return this.alpha >= this.alphaMin || this.alphaTarget >= this.alphaMin;
  }

  setForces(forces: Partial<ForceParams>): void {
    this.forces = { ...this.forces, ...forces };
    this.updateLinks();
    this.updateCollision();
  }

  reheat(alpha = 1): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  pin(i: number, x: number, y: number): void {
    if (i < 0 || i >= this.n) return;
    if (!this.fixed[i]) this.pinned++;
    this.fixed[i] = 1;
    this.fx[i] = x;
    this.fy[i] = y;
  }

  unpin(i: number): void {
    if (i < 0 || i >= this.n || !this.fixed[i]) return;
    this.fixed[i] = 0;
    this.pinned--;
  }

  /** Advances the layout; returns the new alpha. */
  tick(iterations = 1): number {
    for (let k = 0; k < iterations; k++) {
      this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
      const alpha = this.alpha;
      this.applyLinks(alpha);
      if (this.n > EXACT_LIMIT) this.applyBarnesHut(alpha);
      else this.applyExact(alpha);
      this.applyGravity(alpha);
      if (this.forces.collide) this.applyCollision();
      this.integrate();
    }
    return this.alpha;
  }

  /** Writes interleaved x, y into `out` (length 2n). */
  writePositions(out: Float32Array): void {
    const { x, y, n } = this;
    for (let i = 0; i < n; i++) {
      out[2 * i] = x[i];
      out[2 * i + 1] = y[i];
    }
  }

  private updateLinks(): void {
    const { source, target, count, weight, radius } = this;
    const { link, linkDistance, radiusScale } = this.forces;
    for (let e = 0; e < source.length; e++) {
      const s = source[e], t = target[e];
      const w = weight ? Math.min(2, Math.sqrt(weight[e] || 1)) : 1;
      this.linkStrength[e] = Math.min(1, (link * w) / Math.max(1, Math.min(count[s], count[t])));
      this.linkBias[e] = count[s] / (count[s] + count[t]);
      this.linkLength[e] = linkDistance + (radius[s] + radius[t]) * radiusScale;
    }
  }

  private applyLinks(alpha: number): void {
    const { source, target, x, y, vx, vy, linkStrength, linkBias, linkLength } = this;
    for (let e = 0; e < source.length; e++) {
      const s = source[e], t = target[e];
      let dx = x[t] + vx[t] - x[s] - vx[s] || jiggle(e);
      let dy = y[t] + vy[t] - y[s] - vy[s] || jiggle(e + 1);
      const l = Math.sqrt(dx * dx + dy * dy);
      const f = ((l - linkLength[e]) / l) * alpha * linkStrength[e];
      dx *= f;
      dy *= f;
      const b = linkBias[e];
      vx[t] -= dx * b;
      vy[t] -= dy * b;
      vx[s] += dx * (1 - b);
      vy[s] += dy * (1 - b);
    }
  }

  private applyExact(alpha: number): void {
    const { n, x, y, vx, vy } = this;
    const strength = -this.forces.repel * REPEL_SCALE * alpha;
    if (strength === 0) return;
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i];
      let ax = 0, ay = 0;
      for (let j = i + 1; j < n; j++) {
        let dx = x[j] - xi, dy = y[j] - yi;
        if (dx === 0 && dy === 0) { dx = jiggle(i * n + j); dy = jiggle(j * n + i); }
        let l2 = dx * dx + dy * dy;
        if (l2 < DISTANCE_MIN2) l2 = Math.sqrt(DISTANCE_MIN2 * l2);
        const f = strength / l2;
        ax += dx * f;
        ay += dy * f;
        vx[j] -= dx * f;
        vy[j] -= dy * f;
      }
      vx[i] += ax;
      vy[i] += ay;
    }
  }

  private ensureCells(capacity: number): void {
    if (this.cellSize.length >= capacity) return;
    const size = Math.max(capacity, this.cellSize.length * 2);
    const child = new Int32Array(size * 4);
    child.set(this.child);
    this.child = child;
    const grow = (old: Float32Array) => { const a = new Float32Array(size); a.set(old); return a; };
    this.cellSize = grow(this.cellSize);
    this.cellMass = grow(this.cellMass);
    this.cellX = grow(this.cellX);
    this.cellY = grow(this.cellY);
  }

  private newCell(size: number): number {
    const c = this.cells++;
    this.ensureCells(this.cells);
    this.child.fill(-1, c * 4, c * 4 + 4);
    this.cellSize[c] = size;
    return c;
  }

  private buildQuadtree(): void {
    const { n, x, y, next } = this;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < x0) x0 = x[i];
      if (x[i] > x1) x1 = x[i];
      if (y[i] < y0) y0 = y[i];
      if (y[i] > y1) y1 = y[i];
    }
    const rootSize = Math.max(x1 - x0, y1 - y0, 1) * 1.0001;
    this.cells = 0;
    this.ensureCells(n * 2 + 16);
    this.newCell(rootSize);

    for (let i = 0; i < n; i++) {
      const px = x[i], py = y[i];
      let cell = 0, cx = x0, cy = y0, size = rootSize, depth = 0;
      for (;;) {
        const half = size / 2;
        const qx = px >= cx + half ? 1 : 0, qy = py >= cy + half ? 1 : 0;
        const slot = cell * 4 + qy * 2 + qx;
        const occupant = this.child[slot];
        if (occupant === -1) {
          this.child[slot] = -(i + 2);
          next[i] = -1;
          break;
        }
        cx += qx * half;
        cy += qy * half;
        if (occupant >= 0) {
          cell = occupant;
          size = half;
          depth++;
          continue;
        }
        const j = -occupant - 2;
        if ((x[j] === px && y[j] === py) || depth >= MAX_DEPTH) {
          // Coincident (or absurdly close) points share a leaf as a linked list.
          next[i] = j;
          this.child[slot] = -(i + 2);
          break;
        }
        const split = this.newCell(half);
        this.child[slot] = split;
        const quarter = half / 2;
        const qj = (y[j] >= cy + quarter ? 2 : 0) + (x[j] >= cx + quarter ? 1 : 0);
        this.child[split * 4 + qj] = occupant;
        cell = split;
        size = half;
        depth++;
      }
    }

    // Children are always created after their parent, so a reverse sweep is a post-order walk.
    for (let c = this.cells - 1; c >= 0; c--) {
      let mass = 0, sx = 0, sy = 0;
      for (let q = 0; q < 4; q++) {
        const ch = this.child[c * 4 + q];
        if (ch === -1) continue;
        if (ch >= 0) {
          const m = this.cellMass[ch];
          mass += m;
          sx += this.cellX[ch] * m;
          sy += this.cellY[ch] * m;
        } else {
          for (let p = -ch - 2; p !== -1; p = next[p]) {
            mass += 1;
            sx += x[p];
            sy += y[p];
          }
        }
      }
      this.cellMass[c] = mass;
      this.cellX[c] = mass ? sx / mass : 0;
      this.cellY[c] = mass ? sy / mass : 0;
    }
  }

  private applyBarnesHut(alpha: number): void {
    const strength = -this.forces.repel * REPEL_SCALE * alpha;
    if (strength === 0) return;
    this.buildQuadtree();
    const { n, x, y, vx, vy, next, stack, child, cellSize, cellMass, cellX, cellY } = this;
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i];
      let ax = 0, ay = 0, top = 0;
      stack[top++] = 0;
      while (top > 0) {
        const c = stack[--top];
        const dx = cellX[c] - xi, dy = cellY[c] - yi;
        let l2 = dx * dx + dy * dy;
        const w = cellSize[c];
        if ((w * w) / THETA2 < l2) {
          if (l2 < DISTANCE_MIN2) l2 = Math.sqrt(DISTANCE_MIN2 * l2);
          const f = (strength * cellMass[c]) / l2;
          ax += dx * f;
          ay += dy * f;
          continue;
        }
        for (let q = 0; q < 4; q++) {
          const ch = child[c * 4 + q];
          if (ch === -1) continue;
          if (ch >= 0) {
            stack[top++] = ch;
            continue;
          }
          for (let p = -ch - 2; p !== -1; p = next[p]) {
            if (p === i) continue;
            let px = x[p] - xi, py = y[p] - yi;
            if (px === 0 && py === 0) { px = jiggle(i * 31 + p); py = jiggle(p * 31 + i); }
            let d2 = px * px + py * py;
            if (d2 < DISTANCE_MIN2) d2 = Math.sqrt(DISTANCE_MIN2 * d2);
            const f = strength / d2;
            ax += px * f;
            ay += py * f;
          }
        }
      }
      vx[i] += ax;
      vy[i] += ay;
    }
  }

  private applyGravity(alpha: number): void {
    const { n, x, y, vx, vy } = this;
    const g = this.forces.center * GRAVITY_SCALE * alpha;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) {
      vx[i] -= x[i] * g;
      vy[i] -= y[i] * g;
      mx += x[i];
      my += y[i];
    }
    // Keep the centre of mass at the origin, softly, unless the user is holding a node.
    if (this.pinned > 0 || n === 0 || this.forces.center === 0) return;
    const shift = 0.1 * this.forces.center;
    mx = (mx / n) * shift;
    my = (my / n) * shift;
    for (let i = 0; i < n; i++) {
      x[i] -= mx;
      y[i] -= my;
    }
  }

  /** Collision radii, and which notes are too big for the collision grid's cells. */
  private updateCollision(): void {
    const { n, radius } = this;
    const scale = this.forces.radiusScale;
    if (this.collideR.length !== n) this.collideR = new Float32Array(n);
    const R = this.collideR;
    for (let i = 0; i < n; i++) R[i] = radius[i] * scale + COLLIDE_PADDING;
    // Cells are sized for ordinary notes. The few big hubs are checked separately; sizing cells for
    // them would put dozens of notes in every cell (a 5k-note star graph got 14x slower).
    const sorted = R.slice().sort();
    this.smallMax = n > 0 ? sorted[Math.floor(LARGE_PERCENTILE * (n - 1))] : 0;
    let count = 0;
    for (let i = 0; i < n; i++) if (R[i] > this.smallMax) count++;
    this.large = new Int32Array(count);
    count = 0;
    for (let i = 0; i < n; i++) if (R[i] > this.smallMax) this.large[count++] = i;
  }

  /** Pushes i and j apart if their discs overlap; (xi, yi) is i's predicted position. */
  private collidePair(i: number, j: number, xi: number, yi: number): void {
    const { x, y, vx, vy, collideR: R } = this;
    const ri = R[i], rj = R[j], r = ri + rj;
    let dx = xi - x[j] - vx[j], dy = yi - y[j] - vy[j];
    let l2 = dx * dx + dy * dy;
    if (l2 >= r * r) return;
    if (dx === 0) { dx = jiggle(i + j * 7); l2 += dx * dx; }
    if (dy === 0) { dy = jiggle(j + i * 7); l2 += dy * dy; }
    const l = Math.sqrt(l2);
    const f = ((r - l) / l) * COLLIDE_STRENGTH;
    dx *= f;
    dy *= f;
    const ri2 = ri * ri, rj2 = rj * rj, share = rj2 / (ri2 + rj2);
    vx[i] += dx * share;
    vy[i] += dy * share;
    vx[j] -= dx * (1 - share);
    vy[j] -= dy * (1 - share);
  }

  private applyCollision(): void {
    const { n, x, y, vx, vy, collideR: R, gridItems, gridCell, large, smallMax } = this;
    if (n < 2) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (R[i] > smallMax) continue;
      const px = x[i] + vx[i], py = y[i] + vy[i];
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
    let cell = 2 * smallMax;
    let cols = Math.max(1, Math.ceil((x1 - x0) / cell) + 1), rows = Math.max(1, Math.ceil((y1 - y0) / cell) + 1);
    while (cols * rows > 4 * n + 64) {
      cell *= 2;
      cols = Math.ceil((x1 - x0) / cell) + 1;
      rows = Math.ceil((y1 - y0) / cell) + 1;
    }
    const cellCount = cols * rows;
    if (this.gridStart.length < cellCount + 1) this.gridStart = new Int32Array(cellCount + 1);
    if (this.gridFill.length < cellCount + 1) this.gridFill = new Int32Array(cellCount + 1);
    const start = this.gridStart, fill = this.gridFill;
    start.fill(0, 0, cellCount + 1);
    for (let i = 0; i < n; i++) {
      if (R[i] > smallMax) { gridCell[i] = -1; continue; }
      const c = Math.floor((x[i] + vx[i] - x0) / cell) + Math.floor((y[i] + vy[i] - y0) / cell) * cols;
      gridCell[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < cellCount; c++) start[c + 1] += start[c];
    fill.set(start.subarray(0, cellCount));
    for (let i = 0; i < n; i++) if (gridCell[i] >= 0) gridItems[fill[gridCell[i]]++] = i;

    // Ordinary pairs: a cell is at least two radii wide, so the 3x3 block around a note suffices.
    for (let i = 0; i < n; i++) {
      if (gridCell[i] < 0) continue;
      const xi = x[i] + vx[i], yi = y[i] + vy[i];
      const ci = gridCell[i] % cols, cj = Math.floor(gridCell[i] / cols);
      for (let gy = Math.max(0, cj - 1); gy <= Math.min(rows - 1, cj + 1); gy++) {
        for (let gx = Math.max(0, ci - 1); gx <= Math.min(cols - 1, ci + 1); gx++) {
          const c = gx + gy * cols;
          for (let k = start[c]; k < start[c + 1]; k++) {
            const j = gridItems[k];
            if (j > i) this.collidePair(i, j, xi, yi);
          }
        }
      }
    }

    // Big notes against the ordinary notes within reach, then against each other.
    for (let a = 0; a < large.length; a++) {
      const i = large[a];
      const xi = x[i] + vx[i], yi = y[i] + vy[i], reach = R[i] + smallMax;
      const gx0 = Math.max(0, Math.floor((xi - reach - x0) / cell)), gx1 = Math.min(cols - 1, Math.floor((xi + reach - x0) / cell));
      const gy0 = Math.max(0, Math.floor((yi - reach - y0) / cell)), gy1 = Math.min(rows - 1, Math.floor((yi + reach - y0) / cell));
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const c = gx + gy * cols;
          for (let k = start[c]; k < start[c + 1]; k++) this.collidePair(i, gridItems[k], xi, yi);
        }
      }
      for (let b = a + 1; b < large.length; b++) this.collidePair(i, large[b], x[i] + vx[i], y[i] + vy[i]);
    }
  }

  private integrate(): void {
    const { n, x, y, vx, vy, fixed, fx, fy } = this;
    const decay = 1 - this.velocityDecay;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) {
        x[i] = fx[i];
        y[i] = fy[i];
        vx[i] = vy[i] = 0;
        continue;
      }
      x[i] += vx[i] *= decay;
      y[i] += vy[i] *= decay;
      if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
        x[i] = jiggle(i) * 1e6;
        y[i] = jiggle(i + 1) * 1e6;
        vx[i] = vy[i] = 0;
      }
    }
  }
}

/** Messages to the simulation runtime (worker or main-thread fallback). */
export type SimRequest =
  | ({ type: "init"; version: number } & SimulationInput)
  | { type: "setForces"; forces: Partial<ForceParams>; reheat?: number }
  | { type: "pin"; index: number; x: number; y: number }
  | { type: "unpin"; index: number }
  | { type: "reheat"; alpha?: number }
  | { type: "recycle"; version: number; positions: Float32Array }
  | { type: "stop" };

export interface SimFrame {
  type: "frame";
  version: number;
  positions: Float32Array;
  alpha: number;
  done: boolean;
}

const POOL_SIZE = 3;
const MAX_TICKS_PER_FRAME = 3;

/**
 * The message loop around a ForceSimulation. Frames are posted into a small pool of buffers that the
 * receiver hands back with "recycle", so the producer never runs ahead of what is actually drawn.
 */
export function createSimulationRuntime(
  post: (frame: SimFrame, transfer: Transferable[]) => void,
  schedule: (step: () => void) => void,
  budgetMs = 8,
): (request: SimRequest) => void {
  let sim: ForceSimulation | null = null;
  let version = 0;
  let pool: Float32Array[] = [];
  let scheduled = false;
  let tickCost = 0;

  const emit = (): boolean => {
    const buffer = pool.pop();
    if (!sim || !buffer) return false;
    sim.writePositions(buffer);
    post({ type: "frame", version, positions: buffer, alpha: sim.alpha, done: !sim.active }, [buffer.buffer]);
    return true;
  };

  const step = () => {
    scheduled = false;
    if (!sim || !sim.active || pool.length === 0) return;
    const ticks = tickCost > 0 ? Math.max(1, Math.min(MAX_TICKS_PER_FRAME, Math.floor(budgetMs / tickCost))) : 1;
    const started = performance.now();
    sim.tick(ticks);
    const cost = (performance.now() - started) / ticks;
    tickCost = tickCost ? tickCost * 0.8 + cost * 0.2 : cost;
    emit();
    wake();
  };

  const wake = () => {
    if (scheduled || !sim || !sim.active || pool.length === 0) return;
    scheduled = true;
    schedule(step);
  };

  return (request) => {
    switch (request.type) {
      case "init": {
        sim = new ForceSimulation(request);
        version = request.version;
        pool = Array.from({ length: POOL_SIZE }, () => new Float32Array(2 * request.n));
        tickCost = 0;
        emit();
        break;
      }
      case "setForces":
        sim?.setForces(request.forces);
        if (request.reheat) sim?.reheat(request.reheat);
        break;
      case "pin":
        if (sim) {
          sim.pin(request.index, request.x, request.y);
          sim.alphaTarget = 0.3;
          sim.reheat(0.3);
        }
        break;
      case "unpin":
        sim?.unpin(request.index);
        if (sim) sim.alphaTarget = 0;
        break;
      case "reheat":
        sim?.reheat(request.alpha ?? 1);
        break;
      case "recycle":
        if (request.version === version && sim && request.positions.length === 2 * sim.n && pool.length < POOL_SIZE) {
          pool.push(request.positions);
        }
        break;
      case "stop":
        sim = null;
        pool = [];
        break;
    }
    wake();
  };
}
