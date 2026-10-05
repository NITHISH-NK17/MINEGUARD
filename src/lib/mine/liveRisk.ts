/**
 * Risk engine bridge for LIVE vehicles.
 *
 * Takes real GNSS positions (WGS84) plus the active mine map (also WGS84 after
 * import/reprojection) and produces the same class of warnings the simulator
 * produces: blind curve ahead, restricted / risk zone, highwall or steep ramp
 * proximity, overspeed, and vehicle-to-vehicle collision risk.
 */

import type { LiveVehicle } from "./liveFleet";
import type { GeoFeature, MineMapDoc } from "./mapStore";
import type { RiskLevel } from "./data";

export type LiveWarning = {
  key: string;
  vehicleId: string;
  level: RiskLevel;
  title: string;
  body: string;
  distance?: number;
};

const D2R = Math.PI / 180;

export function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dy = (bLat - aLat) * 111320;
  const dx = (bLon - aLon) * 111320 * Math.cos(((aLat + bLat) / 2) * D2R);
  return Math.hypot(dx, dy);
}

export function bearing(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dy = (bLat - aLat) * 111320;
  const dx = (bLon - aLon) * 111320 * Math.cos(((aLat + bLat) / 2) * D2R);
  return (((Math.atan2(dx, dy) * 180) / Math.PI) + 360) % 360;
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

type Hazard = {
  kind: "BLIND_CURVE" | "RISK_ZONE" | "RESTRICTED" | "HIGHWALL" | "DUMP" | "LOADING" | "CHECKPOINT" | "RSU";
  id: string;
  name: string;
  lat: number;
  lon: number;
  props: Record<string, unknown>;
};

function firstPoint(f: GeoFeature): [number, number] | null {
  const walk = (c: unknown): [number, number] | null => {
    if (!Array.isArray(c)) return null;
    if (typeof c[0] === "number" && typeof c[1] === "number") return [c[1] as number, c[0] as number];
    for (const x of c) {
      const r = walk(x);
      if (r) return r;
    }
    return null;
  };
  return f.geometry ? walk(f.geometry.coordinates) : null;
}

/** Centroid-ish representative point of any geometry (lat, lon). */
function centroid(f: GeoFeature): [number, number] | null {
  let lat = 0;
  let lon = 0;
  let n = 0;
  const walk = (c: unknown) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      lon += c[0] as number;
      lat += c[1] as number;
      n++;
      return;
    }
    for (const x of c) walk(x);
  };
  if (!f.geometry) return null;
  walk(f.geometry.coordinates);
  if (!n) return firstPoint(f);
  return [lat / n, lon / n];
}

const KIND_MAP: Record<string, Hazard["kind"] | undefined> = {
  BLIND_CURVES: "BLIND_CURVE",
  RISK_ZONES: "RISK_ZONE",
  RESTRICTED_ZONES: "RESTRICTED",
  HIGHWALLS: "HIGHWALL",
  DUMPING_AREAS: "DUMP",
  LOADING_AREAS: "LOADING",
  CHECKPOINTS: "CHECKPOINT",
  RSUS: "RSU",
};

/** Flatten the active map into point hazards the risk engine can measure against. */
export function hazardsFromMap(doc: MineMapDoc | null): Hazard[] {
  if (!doc) return [];
  const out: Hazard[] = [];
  for (const layer of doc.layers) {
    const kind = KIND_MAP[layer.kind];
    if (!kind) continue;
    layer.fc.features.forEach((f, i) => {
      const c = centroid(f);
      if (!c) return;
      const p = f.properties ?? {};
      const id =
        (p["curveId"] as string) ??
        (p["zoneId"] as string) ??
        (p["rsuId"] as string) ??
        (p["cpId"] as string) ??
        (p["id"] as string) ??
        `${layer.kind}-${i + 1}`;
      out.push({
        kind,
        id: String(id),
        name: String(p["curveName"] ?? p["name"] ?? p["zoneType"] ?? id),
        lat: c[0],
        lon: c[1],
        props: p,
      });
    });
  }
  return out;
}

/** Default speed limits per hazard kind when the map has no attribute. */
const DEFAULT_SPEED: Record<Hazard["kind"], number> = {
  BLIND_CURVE: 20,
  RISK_ZONE: 25,
  RESTRICTED: 10,
  HIGHWALL: 20,
  DUMP: 15,
  LOADING: 15,
  CHECKPOINT: 20,
  RSU: 40,
};

const ALERT_RADIUS: Record<Hazard["kind"], number> = {
  BLIND_CURVE: 120,
  RISK_ZONE: 120,
  RESTRICTED: 150,
  HIGHWALL: 90,
  DUMP: 100,
  LOADING: 100,
  CHECKPOINT: 80,
  RSU: 0,
};

export function evaluateLiveRisk(vehicles: LiveVehicle[], hazards: Hazard[], stale: (v: LiveVehicle) => boolean) {
  const warnings: LiveWarning[] = [];
  const riskById: Record<string, RiskLevel> = {};

  const bump = (id: string, level: RiskLevel) => {
    const order: RiskLevel[] = ["SAFE", "CAUTION", "MEDIUM", "HIGH"];
    const cur = riskById[id] ?? "SAFE";
    riskById[id] = order.indexOf(level) > order.indexOf(cur) ? level : cur;
  };

  for (const v of vehicles) {
    riskById[v.vehicleId] ??= "SAFE";
    if (stale(v)) {
      warnings.push({
        key: `lost-${v.vehicleId}`,
        vehicleId: v.vehicleId,
        level: "MEDIUM",
        title: "CONNECTION LOST",
        body: `${v.vehicleId} telemetry stopped — showing last known position.`,
      });
      continue;
    }

    for (const h of hazards) {
      const radius = ALERT_RADIUS[h.kind];
      if (!radius) continue;
      const d = metresBetween(v.latitude, v.longitude, h.lat, h.lon);
      if (d > radius) continue;
      // only warn about hazards roughly ahead of the vehicle when it is moving
      if (v.speed > 2 && angleDiff(bearing(v.latitude, v.longitude, h.lat, h.lon), v.heading) > 100) continue;

      const rec = Number(h.props["recommendedSpeed"] ?? h.props["speedLimit"] ?? DEFAULT_SPEED[h.kind]);
      const level: RiskLevel = d < radius * 0.35 ? "HIGH" : d < radius * 0.7 ? "MEDIUM" : "CAUTION";
      bump(v.vehicleId, level);
      const title =
        h.kind === "BLIND_CURVE"
          ? "BLIND CURVE AHEAD"
          : h.kind === "RESTRICTED"
            ? "RESTRICTED ZONE AHEAD"
            : h.kind === "HIGHWALL"
              ? "HIGHWALL EDGE AHEAD"
              : h.kind === "DUMP"
                ? "DUMPING ZONE AHEAD"
                : h.kind === "LOADING"
                  ? "LOADING ZONE AHEAD"
                  : h.kind === "CHECKPOINT"
                    ? "CHECKPOINT AHEAD"
                    : "RISK ZONE AHEAD";
      warnings.push({
        key: `${v.vehicleId}-${h.kind}-${h.id}`,
        vehicleId: v.vehicleId,
        level,
        title,
        body: `${h.name} · Distance: ${Math.round(d)} m · Recommended speed: ${rec} km/h`,
        distance: d,
      });

      if (v.speed > rec + 2) {
        bump(v.vehicleId, "HIGH");
        warnings.push({
          key: `${v.vehicleId}-over-${h.id}`,
          vehicleId: v.vehicleId,
          level: "HIGH",
          title: "OVERSPEED WARNING",
          body: `Current speed: ${v.speed.toFixed(0)} km/h · Recommended speed: ${rec} km/h (${h.name})`,
        });
      }
    }
  }

  /* --------------------------------------------- vehicle-to-vehicle V2V */
  const live = vehicles.filter((v) => !stale(v));
  const pairs: { a: string; b: string; distance: number; relativeSpeed: number; ttc: number | null; level: RiskLevel }[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      const d = metresBetween(a.latitude, a.longitude, b.latitude, b.longitude);
      if (d > 400) continue;
      const brg = bearing(a.latitude, a.longitude, b.latitude, b.longitude);
      const closing =
        (Math.cos(angleDiff(a.heading, brg) * D2R) * a.speed +
          Math.cos(angleDiff(b.heading, (brg + 180) % 360) * D2R) * b.speed);
      const ttc = closing > 1 ? d / ((closing * 1000) / 3600) : null;
      const level: RiskLevel =
        d < 40 || (ttc !== null && ttc < 6) ? "HIGH" : d < 90 || (ttc !== null && ttc < 12) ? "MEDIUM" : d < 180 ? "CAUTION" : "SAFE";
      pairs.push({ a: a.vehicleId, b: b.vehicleId, distance: d, relativeSpeed: Math.max(0, closing), ttc, level });
      if (level !== "SAFE") {
        bump(a.vehicleId, level);
        bump(b.vehicleId, level);
        warnings.push({
          key: `v2v-${a.vehicleId}-${b.vehicleId}`,
          vehicleId: a.vehicleId,
          level,
          title: level === "HIGH" ? "COLLISION RISK" : "VEHICLE PROXIMITY",
          body: `${a.vehicleId} ↔ ${b.vehicleId} · ${Math.round(d)} m · closing ${Math.max(0, closing).toFixed(1)} km/h${
            ttc !== null ? ` · TTC ${ttc.toFixed(1)} s` : ""
          }`,
          distance: d,
        });
      }
    }
  }

  const order: RiskLevel[] = ["SAFE", "CAUTION", "MEDIUM", "HIGH"];
  warnings.sort((x, y) => order.indexOf(y.level) - order.indexOf(x.level));
  return { warnings, riskById, pairs };
}
