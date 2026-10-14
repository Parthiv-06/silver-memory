"use client";

import { useEffect, useRef, type PointerEvent, type RefObject } from "react";
import { THEME } from "@/lib/graph/theme";
import type { GraphCanvasHandle } from "./graph-canvas";

interface Mapping {
  scale: number;
  ox: number;
  oy: number;
}

/** Overview of the whole graph with the visible area outlined; click or drag to move the camera. */
export function GraphMinimap({
  graph,
  width = 176,
  height = 112,
  className,
}: {
  graph: RefObject<GraphCanvasHandle | null>;
  width?: number;
  height?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapping = useRef<Mapping>({ scale: 1, ox: 0, oy: 0 });
  // While dragging, the mapping stays put; otherwise moving the view would move the map under the pointer.
  const frozen = useRef(false);
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const handle = graph.current, canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!handle || !canvas || !ctx) return;
    let drawn = "";
    let starts = new Int32Array(0), cursor = new Int32Array(0), order = new Int32Array(0);

    const draw = (force = false) => {
      const snap = handle.snapshot();
      // Read every time: the window may have moved to a screen with another pixel ratio.
      const dpr = window.devicePixelRatio || 1;
      const key = snap ? `${snap.version}|${dpr}` : `none|${dpr}`;
      if (key === drawn && !force) return; // hover fades and the like change nothing here
      drawn = key;
      const dw = Math.round(width * dpr), dh = Math.round(height * dpr);
      if (canvas.width !== dw || canvas.height !== dh) {
        canvas.width = dw;
        canvas.height = dh;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!snap || snap.n === 0) return;
      const { n, pos, color, hollow, palette, cam, insets } = snap;

      // The part of the canvas no panel covers, in world space.
      const k = cam.k, hw = snap.width / 2, hh = snap.height / 2;
      const vx0 = cam.x + (insets.left - hw) / k, vx1 = cam.x + (snap.width - insets.right - hw) / k;
      const vy0 = cam.y + (insets.top - hh) / k, vy1 = cam.y + (snap.height - insets.bottom - hh) / k;

      if (!frozen.current) {
        // Map the notes and the view together, so the view box is always whole and in place.
        let x0 = vx0, y0 = vy0, x1 = vx1, y1 = vy1;
        for (let i = 0; i < n; i++) {
          const x = pos[2 * i], y = pos[2 * i + 1];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        if (!Number.isFinite(x0 + y0 + x1 + y1)) return;
        const pad = 8;
        const scale = Math.min((width - 2 * pad) / Math.max(1, x1 - x0), (height - 2 * pad) / Math.max(1, y1 - y0));
        mapping.current = {
          scale,
          ox: (width - (x1 - x0) * scale) / 2 - x0 * scale,
          oy: (height - (y1 - y0) * scale) / 2 - y0 * scale,
        };
      }
      const { scale, ox, oy } = mapping.current;

      // One pass to bucket notes by colour slot (the last slot is the hollow style), then one path per slot.
      const slots = palette.length + 1;
      if (starts.length < slots + 1) {
        starts = new Int32Array(slots + 1);
        cursor = new Int32Array(slots + 1);
      }
      if (order.length < n) order = new Int32Array(n);
      starts.fill(0, 0, slots + 1);
      for (let i = 0; i < n; i++) starts[(hollow[i] ? palette.length : color[i]) + 1]++;
      for (let s = 0; s < slots; s++) starts[s + 1] += starts[s];
      cursor.set(starts.subarray(0, slots));
      for (let i = 0; i < n; i++) order[cursor[hollow[i] ? palette.length : color[i]]++] = i;
      for (let slot = 0; slot < slots; slot++) {
        if (starts[slot] === starts[slot + 1]) continue;
        ctx.beginPath();
        for (let o = starts[slot]; o < starts[slot + 1]; o++) {
          const i = order[o];
          ctx.rect(pos[2 * i] * scale + ox - 1, pos[2 * i + 1] * scale + oy - 1, 2, 2);
        }
        const isHollow = slot === palette.length;
        ctx.globalAlpha = isHollow ? 0.6 : 0.9;
        ctx.fillStyle = isHollow ? THEME.unresolvedStroke : palette[slot];
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const left = Math.max(0.5, vx0 * scale + ox), top = Math.max(0.5, vy0 * scale + oy);
      const right = Math.min(width - 0.5, vx1 * scale + ox), bottom = Math.min(height - 0.5, vy1 * scale + oy);
      if (right > left && bottom > top) {
        ctx.fillStyle = "rgba(157,140,255,0.08)";
        ctx.fillRect(left, top, right - left, bottom - top);
        ctx.strokeStyle = THEME.accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(left, top, right - left, bottom - top);
      }
    };

    // The main canvas can draw at 60 fps; the overview doesn't need to.
    let last = 0, timer = 0;
    const schedule = () => {
      const now = performance.now();
      if (now - last >= 33) {
        last = now;
        draw();
      } else if (!timer) {
        timer = window.setTimeout(() => {
          timer = 0;
          last = performance.now();
          draw();
        }, 40);
      }
    };
    redraw.current = () => draw(true);
    const unsubscribe = handle.subscribe(schedule);
    draw(true);
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
      redraw.current = () => {};
    };
  }, [graph, width, height]);

  const moveTo = (event: PointerEvent<HTMLCanvasElement>, animate: boolean) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const { scale, ox, oy } = mapping.current;
    graph.current?.centerOn((event.clientX - rect.left - ox) / scale, (event.clientY - rect.top - oy) / scale, animate);
  };

  const release = () => {
    if (!frozen.current) return;
    frozen.current = false;
    redraw.current();
  };

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{ width, height, cursor: "crosshair", touchAction: "none" }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        frozen.current = true;
        moveTo(event, true);
      }}
      onPointerMove={(event) => {
        if (frozen.current && event.buttons & 1) moveTo(event, false);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    />
  );
}
