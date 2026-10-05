/**
 * Live vehicle module.
 *
 * Keeps the state of physically connected vehicles (ESP32 edge devices) that
 * publish telemetry onto the telemetry bus. Fully independent of the built-in
 * simulator: nothing here invents GPS movement. If packets stop arriving the
 * vehicle simply goes stale at its last known position.
 *
 * Breadcrumb trail points store lat, lon, timestamp, speed, heading, accuracy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  connectHttpPolling,
  telemetryBus,
  type ConnectionStatus,
  type FixType,
  type VehicleTelemetry,
} from "./telemetry";

export type TrailPoint = {
  latitude: number;
  longitude: number;
  timestamp: number;
  speed: number;
  heading: number;
  accuracy: number;
};

export type LiveVehicle = {
  vehicleId: string;
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  heading: number;
  gpsAccuracy: number;
  fixType: FixType;
  satellites: number;
  reportedStatus: ConnectionStatus;
  imu: VehicleTelemetry["imu"];
  encoderDistance: number;
  distanceTravelled: number;
  lastUpdate: number;
  source: VehicleTelemetry["source"];
  trail: TrailPoint[];
  maxSpeed: number;
  avgSpeed: number;
  packets: number;
};

const TRAIL_MAX = 3000;
/** No packet for this long ⇒ CONNECTION LOST (position frozen, never faked). */
export const STALE_MS = 5000;

function metresBetween(a: TrailPoint, lat: number, lon: number) {
  const dy = (lat - a.latitude) * 111320;
  const dx = (lon - a.longitude) * 111320 * Math.cos((lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

export type FleetMode = "SIMULATION" | "LIVE";

export function useLiveFleet(enabled: boolean) {
  const [vehicles, setVehicles] = useState<Record<string, LiveVehicle>>({});
  const [now, setNow] = useState(() => Date.now());
  const speedSum = useRef<Record<string, { sum: number; n: number }>>({});

  useEffect(() => {
    if (!enabled) return;
    const off = telemetryBus.subscribe((p) => {
      setVehicles((prev) => {
        const old = prev[p.vehicleId];
        const point: TrailPoint = {
          latitude: p.latitude,
          longitude: p.longitude,
          timestamp: p.timestamp || Date.now(),
          speed: p.speed,
          heading: p.heading,
          accuracy: p.gpsAccuracy,
        };
        const trail = old ? [...old.trail, point].slice(-TRAIL_MAX) : [point];
        const acc = (speedSum.current[p.vehicleId] ??= { sum: 0, n: 0 });
        acc.sum += p.speed;
        acc.n += 1;
        const last = old?.trail[old.trail.length - 1];
        const travelled = p.distanceTravelled
          ? p.distanceTravelled
          : (old?.distanceTravelled ?? 0) + (last ? metresBetween(last, p.latitude, p.longitude) : 0);
        return {
          ...prev,
          [p.vehicleId]: {
            vehicleId: p.vehicleId,
            latitude: p.latitude,
            longitude: p.longitude,
            altitude: p.altitude,
            speed: p.speed,
            heading: p.heading,
            gpsAccuracy: p.gpsAccuracy,
            fixType: p.fixType,
            satellites: p.satellites,
            reportedStatus: p.connectionStatus,
            imu: p.imu,
            encoderDistance: p.encoderDistance,
            distanceTravelled: travelled,
            lastUpdate: Date.now(),
            source: p.source,
            trail,
            maxSpeed: Math.max(old?.maxSpeed ?? 0, p.speed),
            avgSpeed: acc.sum / acc.n,
            packets: (old?.packets ?? 0) + 1,
          },
        };
      });
    });
    return off;
  }, [enabled]);

  // HTTP transport (ESP32 → POST /api/public/vehicle/telemetry → poll).
  useEffect(() => {
    if (!enabled) return;
    return connectHttpPolling(1000);
  }, [enabled]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const list = useMemo(
    () => Object.values(vehicles).sort((a, b) => a.vehicleId.localeCompare(b.vehicleId)),
    [vehicles],
  );

  const statusOf = useCallback(
    (v: LiveVehicle): ConnectionStatus | "LOST" => {
      const age = now - v.lastUpdate;
      if (age > STALE_MS) return "LOST";
      return v.reportedStatus;
    },
    [now],
  );

  const secondsSince = useCallback((v: LiveVehicle) => Math.max(0, (now - v.lastUpdate) / 1000), [now]);

  const clearTrail = useCallback((id: string) => {
    setVehicles((prev) => {
      const v = prev[id];
      if (!v) return prev;
      return { ...prev, [id]: { ...v, trail: v.trail.slice(-1) } };
    });
  }, []);

  const clearAll = useCallback(() => {
    speedSum.current = {};
    setVehicles({});
  }, []);

  return { vehicles: list, byId: vehicles, statusOf, secondsSince, clearTrail, clearAll, now };
}

/* ---------------------------------------------------------- exporting */

export function trailToCsv(v: LiveVehicle) {
  const head = "vehicleId,timestamp,iso,latitude,longitude,speed_kmh,heading_deg,accuracy_m";
  const rows = v.trail.map(
    (p) =>
      `${v.vehicleId},${p.timestamp},${new Date(p.timestamp).toISOString()},${p.latitude.toFixed(7)},${p.longitude.toFixed(7)},${p.speed.toFixed(2)},${p.heading.toFixed(1)},${p.accuracy}`,
  );
  return [head, ...rows].join("\n");
}

export function downloadText(filename: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------- demo telemetry src */

/**
 * SIH demo generator — replays a realistic route as *labelled demo* telemetry
 * through exactly the same bus the ESP32 will use. Only runs when the operator
 * presses START DEMO; it is never started automatically.
 */
export function createDemoTransmitter(path: [number, number][], vehicleId: string, opts?: { offset?: number; reverse?: boolean }) {
  let i = opts?.offset ?? 0;
  let travelled = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const step = opts?.reverse ? -1 : 1;

  const emit = () => {
    const n = path.length;
    const a = path[((i % n) + n) % n]!;
    const b = path[(((i + step) % n) + n) % n]!;
    const dy = (b[0] - a[0]) * 111320;
    const dx = (b[1] - a[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180);
    const segment = Math.hypot(dx, dy);
    travelled += segment;
    const heading = (Math.atan2(dx, dy) * 180) / Math.PI;
    const speed = 18 + 8 * Math.sin(i / 7);
    telemetryBus.publish({
      vehicleId,
      latitude: a[0],
      longitude: a[1],
      altitude: 1020,
      elevation: 1020,
      speed,
      heading: (heading + 360) % 360,
      distanceTravelled: travelled,
      timestamp: Date.now(),
      gpsAccuracy: 0.02 + Math.random() * 0.01,
      fixType: "RTK_FIXED",
      satellites: 19 + Math.round(Math.random() * 4),
      connectionStatus: "ONLINE",
      imu: { ax: 0.1, ay: 0.05, az: 9.81, gx: 0.01, gy: 0.02, gz: 0.4 },
      encoderDistance: travelled,
      gps: true,
      radar: true,
      v2v: true,
      source: "DEMO",
    });
    i += step;
  };

  return {
    start(intervalMs = 500) {
      if (timer) return;
      emit();
      timer = setInterval(emit, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    reset() {
      this.stop();
      i = opts?.offset ?? 0;
      travelled = 0;
    },
    get running() {
      return timer !== null;
    },
  };
}
