/** World point shown at the viewport centre, and zoom (screen px per world px). */
export interface Camera {
  x: number;
  y: number;
  k: number;
}

/** Screen space covered by floating panels; fitting and flying aim at what is left. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;
/** Hard floor, even for huge graphs on tiny screens. */
export const ABSOLUTE_MIN_ZOOM = 0.02;
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

// Below this much uncovered space on an axis, panels on that axis are ignored: they are overlays,
// and framing the graph into a sliver (or nothing) is worse than letting a panel cover part of it.
const MIN_FREE = 160;

/** `min` drops below MIN_ZOOM only when a very large graph needs it to fit on screen. */
export function clampZoom(k: number, min = MIN_ZOOM): number {
  return Math.min(MAX_ZOOM, Math.max(min, k));
}

export function isFiniteCamera(cam: Camera): boolean {
  return Number.isFinite(cam.x) && Number.isFinite(cam.y) && Number.isFinite(cam.k) && cam.k > 0;
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** The insets worth honouring in a `width` × `height` viewport (see MIN_FREE). */
export function usableInsets(width: number, height: number, insets: Insets): Insets {
  const keepX = width - insets.left - insets.right >= MIN_FREE;
  const keepY = height - insets.top - insets.bottom >= MIN_FREE;
  if (keepX && keepY) return insets;
  return {
    left: keepX ? insets.left : 0,
    right: keepX ? insets.right : 0,
    top: keepY ? insets.top : 0,
    bottom: keepY ? insets.bottom : 0,
  };
}

/** The camera that frames `bounds` inside the uncovered part of a `width` × `height` viewport. */
export function fitCamera(bounds: Bounds, width: number, height: number, insets: Insets, padding = 48, maxZoom = 1.6): Camera {
  const used = usableInsets(width, height, insets);
  const availW = Math.max(1, width - used.left - used.right), availH = Math.max(1, height - used.top - used.bottom);
  // Padding shrinks on small screens instead of eating the whole viewport.
  const padX = Math.min(padding, availW * 0.12), padY = Math.min(padding, availH * 0.12);
  const freeW = Math.max(1, availW - 2 * padX);
  const freeH = Math.max(1, availH - 2 * padY);
  const bw = Math.max(1, bounds.x1 - bounds.x0), bh = Math.max(1, bounds.y1 - bounds.y0);
  const fit = Math.max(ABSOLUTE_MIN_ZOOM, Math.min(maxZoom, freeW / bw, freeH / bh));
  const k = clampZoom(fit, Math.min(MIN_ZOOM, fit));
  return centeredOn((bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2, k, width, height, insets);
}

/** The camera that puts world point (x, y) at the centre of the uncovered area. */
export function centeredOn(x: number, y: number, k: number, width: number, height: number, insets: Insets): Camera {
  const used = usableInsets(width, height, insets);
  const offsetX = (used.left - used.right) / 2, offsetY = (used.top - used.bottom) / 2;
  return { x: x - offsetX / k, y: y - offsetY / k, k };
}

export interface CameraPath {
  /** Suggested duration in ms. */
  duration: number;
  at(t: number): Camera;
}

const RHO = Math.SQRT2;
const cosh = (x: number) => (Math.exp(x) + Math.exp(-x)) / 2;
const sinh = (x: number) => (Math.exp(x) - Math.exp(-x)) / 2;
const tanh = (x: number) => { const e = Math.exp(2 * x); return (e - 1) / (e + 1); };

/** Zoom in log space while panning linearly: the fallback when the hop is (numerically) tiny. */
function zoomPath(from: Camera, to: Camera): CameraPath {
  const lk0 = Math.log(from.k), lk1 = Math.log(to.k);
  return {
    duration: (Math.abs(lk1 - lk0) / RHO) * 1000,
    at: (t) => (t >= 1 ? { ...to } : { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, k: Math.exp(lk0 + (lk1 - lk0) * t) }),
  };
}

/**
 * Smooth zoom-and-pan between two cameras (van Wijk & Nuij, as in d3-interpolate's zoom):
 * long hops zoom out, travel, and zoom back in, so the destination never feels like a jump cut.
 */
export function cameraPath(from: Camera, to: Camera, width: number): CameraPath {
  const ux0 = from.x, uy0 = from.y, w0 = width / from.k;
  const ux1 = to.x, uy1 = to.y, w1 = width / to.k;
  const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy;
  if (d2 < 1e-6) return zoomPath(from, to);
  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + RHO ** 4 * d2) / (2 * w0 * RHO ** 2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - RHO ** 4 * d2) / (2 * w1 * RHO ** 2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / RHO;
  // Huge zoom changes over tiny pans cancel catastrophically above; the plain zoom is exact enough there.
  if (!Number.isFinite(S) || !Number.isFinite(r0) || S <= 0) return zoomPath(from, to);
  return {
    duration: S * 1000,
    at: (t) => {
      if (t >= 1) return { ...to };
      const s = t * S, coshr0 = cosh(r0);
      const u = (w0 / (RHO ** 2 * d1)) * (coshr0 * tanh(RHO * s + r0) - sinh(r0));
      const w = (w0 * coshr0) / cosh(RHO * s + r0);
      const cam = { x: ux0 + u * dx, y: uy0 + u * dy, k: width / w };
      return isFiniteCamera(cam) ? cam : { ...to };
    },
  };
}
