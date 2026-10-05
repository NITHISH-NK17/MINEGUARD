/**
 * MINEGUARD roadside unit (RSU) live layer.
 *
 * RSU geometry comes from the ACTIVE mine map (sample layout or imported QGIS
 * export). Physical RSUs report their own status and detections to
 * POST /api/public/rsu/telemetry:
 *
 *   { "rsuId":"RSU-01", "latitude":18.67, "longitude":81.22, "online":true,
 *     "rangeMetres":350, "timestamp":1736412345678,
 *     "vehiclesDetected":[{"vehicleId":"V01","distance":120,"speed":22}] }
 *
 * When an RSU does not report detections itself, MINEGUARD derives them from live
 * vehicle GNSS positions inside the RSU range — such rows are marked DERIVED so
 * an operator can tell reported data from inferred data.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { metresBetween } from "./liveRisk";
import type { LiveVehicle } from "./liveFleet";
import type { LiveWarning } from "./liveRisk";
import { hazardsFromMap } from "./liveRisk";
import type { MineMapDoc } from "./mapStore";
import type { RiskLevel } from "./data";

export type RsuDetection = {
  vehicleId: string;
  distance: number;
  speed: number | null;
  rssi: number | null;
  origin: "REPORTED" | "DERIVED";
};

export type RsuReport = {
  rsuId: string;
  latitude: number | null;
  longitude: number | null;
  online: boolean;
  rangeMetres: number | null;
  detections: RsuDetection[];
  detectedCount: number | null;
  message: string | null;
  timestamp: number;
  receivedAt: number;
};

/** No report for this long ⇒ the RSU is treated as OFFLINE (never faked). */
export const RSU_STALE_MS = 15_000;
/** Range assumed when neither the map nor the device reports one. */
export const RSU_DEFAULT_RANGE = 300;

type RsuListener = (r: RsuReport) => void;
const listeners = new Set<RsuListener>();

export const rsuBus = {
  subscribe(fn: RsuListener) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  publish(r: RsuReport) {
    for (const fn of listeners) fn(r);
  },
};

export function parseRsuReport(raw: unknown): RsuReport | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["rsuId"] !== "string" || !o["rsuId"]) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const vd = o["vehiclesDetected"];
  const detections: RsuDetection[] = Array.isArray(vd)
    ? vd.flatMap((d) => {
        if (!d || typeof d !== "object") return [];
        const x = d as Record<string, unknown>;
        if (typeof x["vehicleId"] !== "string") return [];
        return [
          {
            vehicleId: x["vehicleId"],
            distance: num(x["distance"]) ?? 0,
            speed: num(x["speed"]),
            rssi: num(x["rssi"]),
            origin: "REPORTED" as const,
          },
        ];
      })
    : [];

  return {
    rsuId: o["rsuId"],
    latitude: num(o["latitude"]),
    longitude: num(o["longitude"]),
    online: o["online"] !== false,
    rangeMetres: num(o["rangeMetres"]),
    detections,
    detectedCount: typeof vd === "number" ? vd : detections.length ? detections.length : null,
    message: typeof o["message"] === "string" ? o["message"] : null,
    timestamp: num(o["timestamp"]) ?? Date.now(),
    receivedAt: Date.now(),
  };
}

/** Poll the MINEGUARD RSU endpoint that physical roadside units POST to. */
export function connectRsuPolling(intervalMs = 2000, opts: { url?: string; deviceKey?: string } = {}) {
  const url = opts.url || "/api/public/rsu/telemetry";
  let stopped = false;
  const tick = async () => {
    try {
      const res = await fetch(url, {
        cache: "no-store",
        ...(opts.deviceKey ? { headers: { "x-mineguard-key": opts.deviceKey } } : {}),
      });
      if (res.ok) {
        const body = (await res.json()) as { rsus?: unknown[] };
        for (const raw of body.rsus ?? []) {
          const r = parseRsuReport(raw);
          if (r) rsuBus.publish(r);
        }
      }
    } catch {
      /* mine network unavailable — staleness handling lives in the hook */
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/* ------------------------------------------------------------- map RSUs */

export type MapRsu = {
  rsuId: string;
  name: string;
  latitude: number;
  longitude: number;
  rangeMetres: number;
};

/** RSU masts defined by the active (imported or sample) mine map. */
export function rsusFromMap(doc: MineMapDoc | null): MapRsu[] {
  return hazardsFromMap(doc)
    .filter((h) => h.kind === "RSU")
    .map((h) => {
      const r = h.props["rangeMetres"] ?? h.props["range"];
      return {
        rsuId: String(h.props["rsuId"] ?? h.id),
        name: h.name,
        latitude: h.lat,
        longitude: h.lon,
        rangeMetres: typeof r === "number" && r > 0 ? r : RSU_DEFAULT_RANGE,
      };
    });
}

/* --------------------------------------------------------------- hook */

export function useLiveRsus(enabled: boolean) {
  const [reports, setReports] = useState<Record<string, RsuReport>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    return rsuBus.subscribe((r) => setReports((prev) => ({ ...prev, [r.rsuId]: r })));
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    return connectRsuPolling(2000);
  }, [enabled]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const clear = useCallback(() => setReports({}), []);

  return useMemo(() => ({ reports, now, clear }), [reports, now, clear]);
}

/* ------------------------------------------------- merge + risk output */

export type RsuView = MapRsu & {
  status: "ONLINE" | "OFFLINE" | "NO_SIGNAL";
  live: boolean;
  lastComms: number | null;
  secondsSince: number | null;
  detections: RsuDetection[];
  message: string | null;
};

/**
 * Combine map geometry, real RSU reports and live vehicle positions into the
 * view the map and the RSU panel both use.
 */
export function mergeRsus(
  mapRsus: MapRsu[],
  reports: Record<string, RsuReport>,
  vehicles: LiveVehicle[],
  now: number,
): RsuView[] {
  const known = new Map<string, MapRsu>();
  for (const r of mapRsus) known.set(r.rsuId, r);

  // RSUs that report a position but are not on the map are still shown.
  for (const rep of Object.values(reports)) {
    if (known.has(rep.rsuId) || rep.latitude === null || rep.longitude === null) continue;
    known.set(rep.rsuId, {
      rsuId: rep.rsuId,
      name: rep.rsuId,
      latitude: rep.latitude,
      longitude: rep.longitude,
      rangeMetres: rep.rangeMetres ?? RSU_DEFAULT_RANGE,
    });
  }

  return Array.from(known.values()).map((base) => {
    const rep = reports[base.rsuId];
    const age = rep ? now - rep.receivedAt : null;
    const fresh = age !== null && age < RSU_STALE_MS;
    const lat = rep?.latitude ?? base.latitude;
    const lon = rep?.longitude ?? base.longitude;
    const range = rep?.rangeMetres ?? base.rangeMetres;

    const derived: RsuDetection[] = vehicles.flatMap((v) => {
      const d = metresBetween(lat, lon, v.latitude, v.longitude);
      return d <= range
        ? [{ vehicleId: v.vehicleId, distance: d, speed: v.speed, rssi: null, origin: "DERIVED" as const }]
        : [];
    });

    const reported = fresh ? (rep?.detections ?? []) : [];
    const merged = [...reported];
    for (const d of derived) if (!merged.some((m) => m.vehicleId === d.vehicleId)) merged.push(d);
    merged.sort((a, b) => a.distance - b.distance);

    const status: RsuView["status"] = !rep ? "NO_SIGNAL" : !fresh || !rep.online ? "OFFLINE" : "ONLINE";

    return {
      ...base,
      latitude: lat,
      longitude: lon,
      rangeMetres: range,
      status,
      live: !!rep,
      lastComms: rep?.receivedAt ?? null,
      secondsSince: age === null ? null : age / 1000,
      detections: merged,
      message: fresh ? (rep?.message ?? null) : null,
    };
  });
}

/**
 * RSU-driven warnings: an RSU that has gone silent, and the classic roadside
 * advisory — two vehicles inside the same RSU zone closing on each other.
 */
export function rsuWarnings(rsus: RsuView[], vehicles: LiveVehicle[]): LiveWarning[] {
  const out: LiveWarning[] = [];
  const byId = new Map(vehicles.map((v) => [v.vehicleId, v]));

  for (const r of rsus) {
    if (r.live && r.status === "OFFLINE") {
      out.push({
        key: `rsu-off-${r.rsuId}`,
        vehicleId: "—",
        level: "MEDIUM" as RiskLevel,
        title: "RSU OFFLINE",
        body: `${r.name} stopped reporting${r.secondsSince !== null ? ` ${r.secondsSince.toFixed(0)} s ago` : ""} — no roadside coverage in this zone.`,
      });
      continue;
    }
    if (r.status !== "ONLINE") continue;

    if (r.message) {
      out.push({
        key: `rsu-msg-${r.rsuId}`,
        vehicleId: "—",
        level: "CAUTION",
        title: `RSU ADVISORY · ${r.name}`,
        body: r.message,
      });
    }

    for (const d of r.detections) {
      const v = byId.get(d.vehicleId);
      if (!v) continue;
      out.push({
        key: `rsu-in-${r.rsuId}-${d.vehicleId}`,
        vehicleId: d.vehicleId,
        level: "SAFE",
        title: "RSU CONTACT",
        body: `${d.vehicleId} inside ${r.name} coverage · ${Math.round(d.distance)} m · ${d.origin === "REPORTED" ? "reported by RSU" : "derived from GNSS"}`,
        distance: d.distance,
      });
    }

    // Roadside collision advisory: two vehicles under the same RSU, closing.
    for (let i = 0; i < r.detections.length; i++) {
      for (let j = i + 1; j < r.detections.length; j++) {
        const a = byId.get(r.detections[i]!.vehicleId);
        const b = byId.get(r.detections[j]!.vehicleId);
        if (!a || !b) continue;
        const gap = metresBetween(a.latitude, a.longitude, b.latitude, b.longitude);
        if (gap > 250) continue;
        const level: RiskLevel = gap < 60 ? "HIGH" : gap < 140 ? "MEDIUM" : "CAUTION";
        out.push({
          key: `rsu-pair-${r.rsuId}-${a.vehicleId}-${b.vehicleId}`,
          vehicleId: a.vehicleId,
          level,
          title: "RSU TRAFFIC ALERT",
          body: `${r.name}: ${a.vehicleId} and ${b.vehicleId} in the same zone · ${Math.round(gap)} m apart · reduce speed`,
          distance: gap,
        });
      }
    }
  }
  return out;
}

/* ----------------------------------------------------- demo RSU source */

/**
 * SIH demo: makes the mapped RSUs behave like real reporting hardware, using
 * the live vehicle positions that are actually being received. Operator-driven
 * only — it never runs on its own, and it never invents vehicle positions.
 */
export function createRsuDemo(getRsus: () => MapRsu[], getVehicles: () => LiveVehicle[]) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const emit = () => {
    const vehicles = getVehicles();
    for (const r of getRsus()) {
      const detections = vehicles
        .map((v) => ({ v, d: metresBetween(r.latitude, r.longitude, v.latitude, v.longitude) }))
        .filter((x) => x.d <= r.rangeMetres)
        .map(({ v, d }) => ({
          vehicleId: v.vehicleId,
          distance: d,
          speed: v.speed,
          rssi: Math.round(-45 - (d / r.rangeMetres) * 45),
          origin: "REPORTED" as const,
        }));
      rsuBus.publish({
        rsuId: r.rsuId,
        latitude: r.latitude,
        longitude: r.longitude,
        online: true,
        rangeMetres: r.rangeMetres,
        detections,
        detectedCount: detections.length,
        message: detections.length > 1 ? "Multiple vehicles in zone — maintain safe separation" : null,
        timestamp: Date.now(),
        receivedAt: Date.now(),
      });
    }
  };
  return {
    start(intervalMs = 1000) {
      if (timer) return;
      emit();
      timer = setInterval(emit, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
