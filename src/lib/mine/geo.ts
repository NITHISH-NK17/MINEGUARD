/**
 * Geometry + geodesy helpers for the MINEGUARD mine simulation.
 *
 * The mine is authored in a local planar "map unit" space (viewBox 1000 x 760).
 * 1 map unit = UNIT_METERS metres on the ground. Planar coordinates are
 * converted to fictional WGS84 coordinates around an anchor point so the app
 * can later be fed real GPS fixes (e.g. from an ESP32 module) without
 * changing any rendering code.
 */

export type Pt = [number, number];

export const UNIT_METERS = 2;

/** Fictional anchor near the Bailadila range, Dantewada, Chhattisgarh. */
export const ANCHOR = { lat: 18.68, lon: 81.22 };

export const CENTER: Pt = [500, 370];

export function toLatLon(p: Pt) {
  const dxM = (p[0] - CENTER[0]) * UNIT_METERS;
  const dyM = (p[1] - CENTER[1]) * UNIT_METERS;
  const lat = ANCHOR.lat - dyM / 111320;
  const lon = ANCHOR.lon + dxM / (111320 * Math.cos((ANCHOR.lat * Math.PI) / 180));
  return { lat, lon };
}

export function fromLatLon(lat: number, lon: number): Pt {
  const dyM = (ANCHOR.lat - lat) * 111320;
  const dxM = (lon - ANCHOR.lon) * 111320 * Math.cos((ANCHOR.lat * Math.PI) / 180);
  return [CENTER[0] + dxM / UNIT_METERS, CENTER[1] + dyM / UNIT_METERS];
}

export function dist(a: Pt, b: Pt) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Straight-line ground distance in metres between two planar points. */
export function distMeters(a: Pt, b: Pt) {
  return dist(a, b) * UNIT_METERS;
}

const RAD = Math.PI / 180;

/** Points around an ellipse. Angles in degrees, 0 = east, increasing clockwise on screen. */
export function arcPoints(
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  steps: number,
  center: Pt = CENTER,
): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (a0 + ((a1 - a0) * i) / steps) * RAD;
    out.push([center[0] + rx * Math.cos(a), center[1] + ry * Math.sin(a)]);
  }
  return out;
}

/** Spiral ramp descending from one ellipse size to another. */
export function spiralPoints(
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  a0: number,
  a1: number,
  steps: number,
): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const a = (a0 + (a1 - a0) * k) * RAD;
    const rx = rx0 + (rx1 - rx0) * k;
    const ry = ry0 + (ry1 - ry0) * k;
    out.push([CENTER[0] + rx * Math.cos(a), CENTER[1] + ry * Math.sin(a)]);
  }
  return out;
}

/** Deterministic radius jitter so bench outlines read as blasted rock, not perfect ellipses. */
const JITTER = [
  1.0, 0.965, 1.04, 0.985, 1.055, 0.955, 1.025, 1.005, 0.975, 1.045, 0.968, 1.012, 1.035, 0.982,
  1.0, 1.052, 0.958, 1.022, 0.992, 1.042, 0.972, 1.008, 1.028, 0.978,
];

export function benchPolygon(rx: number, ry: number, phase = 0): Pt[] {
  const n = JITTER.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i / n) * 360) * RAD;
    const j = JITTER[(i + phase) % n]!;
    out.push([CENTER[0] + rx * j * Math.cos(a), CENTER[1] + ry * j * Math.sin(a)]);
  }
  return out;
}

export function toPathD(pts: Pt[], close = false) {
  if (!pts.length) return "";
  return (
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ") +
    (close ? " Z" : "")
  );
}

/** Smooth polyline into a cubic path (Catmull-Rom -> Bezier) for natural haul-road curves. */
export function toSmoothD(pts: Pt[], close = false) {
  if (pts.length < 3) return toPathD(pts, close);
  const p = pts;
  const n = p.length;
  let d = `M${p[0]![0].toFixed(1)} ${p[0]![1].toFixed(1)}`;
  const idx = (i: number): Pt => (close ? p[(i + n) % n]! : p[Math.max(0, Math.min(n - 1, i))]!);
  const last = close ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = idx(i - 1);
    const p1 = idx(i);
    const p2 = idx(i + 1);
    const p3 = idx(i + 2);
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  if (close) d += " Z";
  return d;
}

export function pathLength(pts: Pt[]) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1]!, pts[i]!);
  return total;
}

/** Position + heading (degrees, 0 = north, clockwise) at arc-length s along a polyline. */
export function pointAt(pts: Pt[], s: number): { pos: Pt; heading: number } {
  const total = pathLength(pts);
  let d = Math.max(0, Math.min(total, s));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = dist(a, b);
    if (d <= seg || i === pts.length - 1) {
      const t = seg === 0 ? 0 : d / seg;
      const pos: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const heading = (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI;
      return { pos, heading: (heading + 360) % 360 };
    }
    d -= seg;
  }
  return { pos: pts[0]!, heading: 0 };
}

export function headingLabel(h: number) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(h / 45) % 8]!;
}

