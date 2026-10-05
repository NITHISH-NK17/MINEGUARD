/**
 * MINEGUARD 3D world helpers.
 *
 * Converts the existing planar mine model (map units, 1 unit = 2 m) into a
 * metric three.js world so the 3D perception view and the 2D maps always show
 * the same simulated mine.
 *
 * SIMULATION: Bailadila-inspired fictional open-cast layout, not an official
 * NMDC survey.
 */

import * as THREE from "three";
import { benches, elevationAt, type Road } from "@/lib/mine/data";
import { CENTER, pathLength, pointAt, UNIT_METERS, type Pt } from "@/lib/mine/geo";

/** Datum of the 3D world (m AMSL). y = elevation - BASE_RL. */
export const BASE_RL = 900;

/** Planar map point -> world metres. */
export function wx(p: Pt) {
  return (p[0] - CENTER[0]) * UNIT_METERS;
}
export function wz(p: Pt) {
  return (p[1] - CENTER[1]) * UNIT_METERS;
}
export function wy(p: Pt, lift = 0) {
  return elevationAt(p) - BASE_RL + lift;
}
export function worldPos(p: Pt, lift = 0): [number, number, number] {
  return [wx(p), wy(p, lift), wz(p)];
}

/** Map heading (deg, 0 = north) -> three.js Y rotation. */
export function headingToYaw(heading: number) {
  return -(heading * Math.PI) / 180;
}

/* ------------------------------------------------------------- terrain */

function shapeFrom(points: Pt[]) {
  const s = new THREE.Shape();
  points.forEach((p, i) => {
    const x = wx(p);
    const z = wz(p);
    if (i === 0) s.moveTo(x, z);
    else s.lineTo(x, z);
  });
  s.closePath();
  return s;
}

function pathFrom(points: Pt[]) {
  const s = new THREE.Path();
  points.forEach((p, i) => {
    const x = wx(p);
    const z = wz(p);
    if (i === 0) s.moveTo(x, z);
    else s.lineTo(x, z);
  });
  s.closePath();
  return s;
}

/** Flat terrace between one bench outline and the next (inner) one. */
export function terraceGeometry(outer: Pt[], inner: Pt[] | null) {
  const shape = shapeFrom(outer);
  if (inner) shape.holes.push(pathFrom(inner));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

/** Vertical highwall / batter face between two closed outlines at two levels. */
export function wallGeometry(top: Pt[], topY: number, bottom: Pt[], bottomY: number) {
  const n = Math.min(top.length, bottom.length);
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = top[i]!;
    const b = top[(i + 1) % n]!;
    const c = bottom[i]!;
    const d = bottom[(i + 1) % n]!;
    const A: [number, number, number] = [wx(a), topY, wz(a)];
    const B: [number, number, number] = [wx(b), topY, wz(b)];
    const C: [number, number, number] = [wx(c), bottomY, wz(c)];
    const D: [number, number, number] = [wx(d), bottomY, wz(d)];
    pos.push(...A, ...C, ...B, ...B, ...C, ...D);
    const u0 = i / n;
    const u1 = (i + 1) / n;
    uv.push(u0, 1, u0, 0, u1, 1, u1, 1, u0, 0, u1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Rim outline (undisturbed hill crest) around the topmost bench. */
export function rimOutline(scale = 1.22): Pt[] {
  return benches[0]!.polygon.map(
    (p) => [CENTER[0] + (p[0] - CENTER[0]) * scale, CENTER[1] + (p[1] - CENTER[1]) * scale] as Pt,
  );
}

/* --------------------------------------------------------------- roads */

/** Resample a road centreline at a fixed spacing, with headings. */
export function sampleRoad(road: Road, spacing = 8) {
  const total = pathLength(road.points);
  const steps = Math.max(8, Math.round(total / spacing));
  const out: { pos: Pt; heading: number }[] = [];
  for (let i = 0; i <= steps; i++) out.push(pointAt(road.points, (total * i) / steps));
  return out;
}

/** Flat ribbon of a given width (metres) laid along a road centreline. */
export function ribbonGeometry(road: Road, widthM: number, lift = 0.35, spacing = 8) {
  const samples = sampleRoad(road, spacing);
  const pos: number[] = [];
  const uv: number[] = [];
  const half = widthM / 2 / UNIT_METERS; // in map units
  const side = (s: { pos: Pt; heading: number }, sign: number): Pt => {
    const rad = (s.heading * Math.PI) / 180;
    return [s.pos[0] + Math.cos(rad) * half * sign, s.pos[1] + Math.sin(rad) * half * sign];
  };
  for (let i = 0; i < samples.length - 1; i++) {
    const s0 = samples[i]!;
    const s1 = samples[i + 1]!;
    const l0 = side(s0, -1);
    const r0 = side(s0, 1);
    const l1 = side(s1, -1);
    const r1 = side(s1, 1);
    const P = (p: Pt) => [wx(p), wy(p, lift), wz(p)] as const;
    pos.push(...P(l0), ...P(r0), ...P(l1), ...P(l1), ...P(r0), ...P(r1));
    const v0 = i;
    const v1 = i + 1;
    uv.push(0, v0, 1, v0, 0, v1, 0, v1, 1, v0, 1, v1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Dashed lane divider: short ribbon segments down the centre of a road. */
export function dashGeometry(road: Road, widthM = 0.9, lift = 0.5) {
  const samples = sampleRoad(road, 6);
  const pos: number[] = [];
  const half = widthM / 2 / UNIT_METERS;
  const side = (s: { pos: Pt; heading: number }, sign: number): Pt => {
    const rad = (s.heading * Math.PI) / 180;
    return [s.pos[0] + Math.cos(rad) * half * sign, s.pos[1] + Math.sin(rad) * half * sign];
  };
  for (let i = 0; i < samples.length - 1; i += 2) {
    const s0 = samples[i]!;
    const s1 = samples[i + 1]!;
    const l0 = side(s0, -1);
    const r0 = side(s0, 1);
    const l1 = side(s1, -1);
    const r1 = side(s1, 1);
    const P = (p: Pt) => [wx(p), wy(p, lift), wz(p)] as const;
    pos.push(...P(l0), ...P(r0), ...P(l1), ...P(l1), ...P(r0), ...P(r1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Safety berm blocks along both road edges (windrows). */
export function bermPlacements(road: Road, offsetM: number, spacing = 26) {
  const samples = sampleRoad(road, spacing);
  const out: { pos: [number, number, number]; yaw: number }[] = [];
  const off = offsetM / UNIT_METERS;
  for (const s of samples) {
    for (const sign of [-1, 1]) {
      const rad = (s.heading * Math.PI) / 180;
      const p: Pt = [s.pos[0] + Math.cos(rad) * off * sign, s.pos[1] + Math.sin(rad) * off * sign];
      out.push({ pos: [wx(p), wy(p, 0.9), wz(p)], yaw: headingToYaw(s.heading) });
    }
  }
  return out;
}

/* ------------------------------------------------------------ textures */

/** Deterministic procedural rock / gravel texture (no network, no assets). */
export function rockTexture(base: string, speck: string, size = 256, density = 2600) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  let seed = 20260910;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < density; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 0.6 + rnd() * 2.4;
    ctx.globalAlpha = 0.08 + rnd() * 0.28;
    ctx.fillStyle = rnd() > 0.5 ? speck : "#000000";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
