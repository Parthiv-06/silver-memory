/** A uniform grid over node positions for O(1)-ish hit testing, rebuilt in O(n) when nodes move. */
export class SpatialGrid {
  private cell = 1;
  private cols = 1;
  private rows = 1;
  private x0 = 0;
  private y0 = 0;
  private maxR = 0;
  private start = new Int32Array(2);
  private items = new Int32Array(0);
  private cellOf = new Int32Array(0);
  private fill = new Int32Array(0);
  private positions: Float32Array = new Float32Array(0);
  private radius: Float32Array = new Float32Array(0);

  /** `positions` is interleaved x, y; `radius` is the world radius of each node. */
  build(positions: Float32Array, radius: Float32Array, n: number): void {
    this.positions = positions;
    this.radius = radius;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, maxR = 0;
    for (let i = 0; i < n; i++) {
      const x = positions[2 * i], y = positions[2 * i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (radius[i] > maxR) maxR = radius[i];
    }
    if (n === 0) { x0 = y0 = x1 = y1 = 0; }
    let cell = Math.max(16, 2 * maxR);
    let cols = Math.ceil((x1 - x0) / cell) + 1, rows = Math.ceil((y1 - y0) / cell) + 1;
    while (cols * rows > 4 * n + 64) {
      cell *= 2;
      cols = Math.ceil((x1 - x0) / cell) + 1;
      rows = Math.ceil((y1 - y0) / cell) + 1;
    }
    this.cell = cell;
    this.cols = cols;
    this.rows = rows;
    this.x0 = x0;
    this.y0 = y0;
    this.maxR = maxR;

    const cells = cols * rows;
    if (this.start.length < cells + 1) this.start = new Int32Array(cells + 1);
    else this.start.fill(0, 0, cells + 1);
    if (this.fill.length < cells + 1) this.fill = new Int32Array(cells + 1);
    if (this.items.length < n) {
      this.items = new Int32Array(n);
      this.cellOf = new Int32Array(n);
    }
    const { start, items, cellOf, fill } = this;
    for (let i = 0; i < n; i++) {
      const c = Math.floor((positions[2 * i] - x0) / cell) + Math.floor((positions[2 * i + 1] - y0) / cell) * cols;
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    fill.set(start.subarray(0, cells));
    for (let i = 0; i < n; i++) items[fill[cellOf[i]]++] = i;
  }

  /** The nearest node whose disc, grown by `tolerance`, contains (x, y); -1 if none. */
  hit(x: number, y: number, tolerance: number, minRadius = 0): number {
    const { cell, cols, rows, x0, y0, start, items, positions, radius } = this;
    const reach = Math.max(this.maxR, minRadius) + tolerance;
    const cx0 = Math.max(0, Math.floor((x - reach - x0) / cell)), cx1 = Math.min(cols - 1, Math.floor((x + reach - x0) / cell));
    const cy0 = Math.max(0, Math.floor((y - reach - y0) / cell)), cy1 = Math.min(rows - 1, Math.floor((y + reach - y0) / cell));
    let best = -1, bestD = Infinity;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cx + cy * cols;
        for (let k = start[c]; k < start[c + 1]; k++) {
          const i = items[k];
          const dx = positions[2 * i] - x, dy = positions[2 * i + 1] - y;
          const d = Math.sqrt(dx * dx + dy * dy);
          const r = Math.max(radius[i], minRadius) + tolerance;
          // Relative distance, so a small node beside a hub stays reachable.
          if (d <= r && d / r < bestD) { best = i; bestD = d / r; }
        }
      }
    }
    return best;
  }
}
