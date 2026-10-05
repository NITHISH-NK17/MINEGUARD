/**
 * MINEGUARD simulation engine.
 *
 * Produces simulated GPS fixes, V2V message exchange, blind-curve proximity
 * warnings and a collision-risk assessment for every vehicle.
 *
 * REPLACING THE SIMULATOR WITH REAL HARDWARE
 * ------------------------------------------
 * Every vehicle snapshot is derived from a `GpsFix` (lat/lon/speed/heading/
 * altitude/timestamp). To use a real ESP32 GNSS module, feed fixes into
 * `ingestExternalFix()` instead of letting `stepVehicle()` advance the
 * simulated position — nothing downstream (risk engine, map, panels) changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  blindCurves,
  elevationAt,
  roadById,
  roads,
  riskZones,
  rsus,
  siteAreas,
  vehicleSpecs,
  type RiskLevel,
} from "./data";
import { dist, distMeters, fromLatLon, headingLabel, pointAt, toLatLon, UNIT_METERS, type Pt } from "./geo";
import { telemetryBus, type VehicleTelemetry } from "./telemetry";

export type GpsFix = {
  vehicleId: string;
  lat: number;
  lon: number;
  speed: number; // km/h
  heading: number; // degrees
  altitude: number; // m AMSL
  timestamp: number;
};

export type CurveWarning = {
  curveId: string;
  curveName: string;
  distance: number; // metres
  recommendedSpeed: number;
  riskLevel: RiskLevel;
};

export type V2VLink = {
  a: string;
  b: string;
  distance: number; // metres
  relativeSpeed: number; // km/h (positive = closing)
  approach: "HEAD-ON" | "CONVERGING" | "FOLLOWING" | "DIVERGING";
  risk: RiskLevel;
};

/** Movement state machine for realistic haul-truck behaviour. */
export type DriveState =
  | "NORMAL_DRIVING"
  | "APPROACHING_VEHICLE"
  | "COLLISION_WARNING"
  | "DECELERATING"
  | "LANE_CHANGE"
  | "PASSING"
  | "RETURNING_TO_LANE"
  | "ROAD_CLEAR";

export type Threat = {
  id: string;
  distance: number; // metres
  relativeSpeed: number; // km/h, positive = closing
  ttc: number; // seconds (Infinity when not closing)
  oncoming: boolean;
};

export type VehicleSnapshot = {
  vehicleId: string;
  label: string;
  payload: string;
  pos: Pt;
  heading: number;
  headingText: string;
  speed: number;
  elevation: number;
  roadId: string;
  roadName: string;
  speedLimit: number;
  gps: GpsFix;
  risk: RiskLevel;
  v2v: boolean;
  peers: number;
  curveWarning: CurveWarning | null;
  collision: V2VLink | null;
  areaStatus: string | null;
  zone: string | null;
  radar: RadarContact[];
  radarAlert: boolean;
  trail: Pt[];
  /** Lateral offset from the road centreline, map units (+ = right of travel). */
  lane: number;
  driveState: DriveState;
  threat: Threat | null;
};

export type RadarContact = {
  id: string;
  kind: "VEHICLE" | "OBSTACLE" | "UNKNOWN";
  distance: number; // metres
  bearing: number; // degrees relative to vehicle heading (0 = straight ahead)
};

/** mmWave radar effective range (metres). */
export const RADAR_RANGE = 60;

/** Two-lane haul road geometry, in map units (1 unit = UNIT_METERS metres). */
export const LANE_HALF = 2.2; // normal lane centre offset from centreline (~4.4 m)
const PASS_EXTRA = 2.6; // additional shift toward the shoulder while passing (~5 m)
const LANE_RATE = 1.15; // lateral speed, units/s -> ~2-4 s per manoeuvre
/** Hard safety envelope: markers may never come closer than this (metres). */
export const MIN_SEPARATION = 14;

/** Static site obstacles the radar can pick up (berms, boulders, parked plant). */
const OBSTACLES: { id: string; kind: "OBSTACLE" | "UNKNOWN"; pos: Pt }[] = [
  { id: "OB1", kind: "OBSTACLE", pos: [330, 606] },
  { id: "OB2", kind: "OBSTACLE", pos: [130, 372] },
  { id: "OB3", kind: "UNKNOWN", pos: [702, 214] },
  { id: "OB4", kind: "OBSTACLE", pos: [452, 470] },
  { id: "OB5", kind: "OBSTACLE", pos: [900, 150] },
  { id: "OB6", kind: "UNKNOWN", pos: [214, 690] },
];

export type RsuSnapshot = {
  rsuId: string;
  name: string;
  online: boolean;
  detected: string[];
  lastComm: number;
};

type Internal = {
  vehicleId: string;
  roadId: string;
  s: number;
  dir: 1 | -1;
  speed: number;
  lane: number;
  laneRate: number;
  driveState: DriveState;
  threat: Threat | null;
  clearUntil: number;
};

const RISK_ORDER: Record<RiskLevel, number> = { SAFE: 0, CAUTION: 1, MEDIUM: 2, HIGH: 3 };
export const maxRisk = (a: RiskLevel, b: RiskLevel) => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);

const TICK_MS = 120;

/** Lateral offset applied to a centreline point (right-hand side of travel). */
export function offsetPos(centre: Pt, heading: number, lane: number): Pt {
  const rad = (heading * Math.PI) / 180;
  return [centre[0] + Math.cos(rad) * lane, centre[1] + Math.sin(rad) * lane];
}

function initial(): Internal[] {
  return vehicleSpecs.map((v) => {
    const r = roadById(v.roadId);
    return {
      vehicleId: v.vehicleId,
      roadId: v.roadId,
      s: r.length * v.startT,
      dir: v.dir,
      speed: r.speedLimit,
      lane: LANE_HALF,
      laneRate: 0,
      driveState: "NORMAL_DRIVING" as DriveState,
      threat: null,
      clearUntil: 0,
    };
  });
}


export function useMineSim() {
  const stateRef = useRef<Internal[]>(initial());
  const [running, setRunning] = useState(true);
  const [speedFactor, setSpeedFactor] = useState(2);
  const [tick, setTick] = useState(0);
  const [demoActive, setDemoActive] = useState(false);
  const [log, setLog] = useState<{ t: number; text: string; level: RiskLevel }[]>([]);
  const lastLogged = useRef<Record<string, string>>({});

  const runningRef = useRef(running);
  runningRef.current = running;
  const factorRef = useRef(speedFactor);
  factorRef.current = speedFactor;

  useEffect(() => {
    const id = setInterval(() => {
      if (runningRef.current) {
        const dt = (TICK_MS / 1000) * factorRef.current;
        stepAll(stateRef.current, dt);
      }
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  const trailsRef = useRef<Map<string, Pt[]>>(new Map());

  /**
   * Hardware hand-off: apply a real telemetry packet (ESP32 GNSS/IMU) to a
   * vehicle. The lat/lon is snapped back onto the haul-road network so every
   * downstream consumer (risk engine, maps, panels) is unchanged.
   */
  const ingestExternalFix = useCallback((packet: VehicleTelemetry) => {
    const v = stateRef.current.find((x) => x.vehicleId === packet.vehicleId);
    if (!v) return;
    const p = fromLatLon(packet.latitude, packet.longitude);
    let best: { roadId: string; s: number; d: number } | null = null;
    for (const r of roads) {
      const step = Math.max(1, r.length / 400);
      for (let s = 0; s <= r.length; s += step) {
        const d = dist(pointAt(r.points, s).pos, p);
        if (!best || d < best.d) best = { roadId: r.roadId, s, d };
      }
    }
    if (!best) return;
    v.roadId = best.roadId;
    v.s = best.s;
    v.speed = packet.speed;
  }, []);

  // Live telemetry (ESP32 over local network) takes priority over the simulator.
  useEffect(() => {
    const off = telemetryBus.subscribe(ingestExternalFix);
    return () => {
      off();
    };
  }, [ingestExternalFix]);

  const runDemo = useCallback(() => {
    const bc = blindCurves.find((c) => c.curveId === "BC01")!;
    const r = roadById(bc.roadId);
    const curveS = r.length * bc.t;
    const st = stateRef.current;
    const v1 = st.find((v) => v.vehicleId === "V01")!;
    const v2 = st.find((v) => v.vehicleId === "V02")!;
    v1.roadId = "R02";
    v1.dir = 1;
    v1.s = (curveS - 58 + r.length) % r.length; // ~116 m before the blind curve
    v1.speed = 26;
    v2.roadId = "R02";
    v2.dir = -1;
    v2.s = (curveS + 58) % r.length;
    v2.speed = 24;
    setDemoActive(true);
    setRunning(true);
    setLog((l) => [
      { t: Date.now(), text: "DEMO: V01 approaching BC01 — V02 inbound from opposite direction", level: "CAUTION" },
      ...l,
    ]);
  }, []);

  /**
   * Collision-avoidance demo: V01 and V02 meet head-on on the same haul road,
   * in opposite lanes, far enough apart to show detection -> warning ->
   * deceleration -> side pass -> road clear.
   */
  const runPassDemo = useCallback(() => {
    const r = roadById("R02");
    const st = stateRef.current;
    const v1 = st.find((v) => v.vehicleId === "V01")!;
    const v2 = st.find((v) => v.vehicleId === "V02")!;
    const mid = r.length * 0.42;
    const gap = 55; // map units => ~220 m apart
    Object.assign(v1, {
      roadId: "R02",
      dir: 1 as const,
      s: (mid - gap + r.length) % r.length,
      speed: 28,
      lane: LANE_HALF,
      laneRate: 0,
      driveState: "NORMAL_DRIVING" as DriveState,
      threat: null,
      clearUntil: 0,
    });
    Object.assign(v2, {
      roadId: "R02",
      dir: -1 as const,
      s: (mid + gap) % r.length,
      speed: 26,
      lane: LANE_HALF,
      laneRate: 0,
      driveState: "NORMAL_DRIVING" as DriveState,
      threat: null,
      clearUntil: 0,
    });
    // Keep the other units clear of the demo stretch.
    for (const v of st) {
      if (v.vehicleId === "V01" || v.vehicleId === "V02") continue;
      v.roadId = v.vehicleId === "V03" ? "R04" : "R05";
      const rr = roadById(v.roadId);
      v.s = rr.length * 0.3;
      v.lane = LANE_HALF;
    }
    setDemoActive(true);
    setRunning(true);
    setLog((l) => [
      {
        t: Date.now(),
        text: "DEMO: collision avoidance — V01 (Lane A) and V02 (Lane B) closing head-on on R02",
        level: "CAUTION",
      },
      ...l,
    ]);
  }, []);

  const reset = useCallback(() => {
    stateRef.current = initial();
    trailsRef.current = new Map();
    setDemoActive(false);
    setLog([]);
    lastLogged.current = {};
  }, []);

  const snapshot = useMemo(() => {
    const snap = buildSnapshot(stateRef.current);
    for (const v of snap.vehicles) {
      const t = trailsRef.current.get(v.vehicleId) ?? [];
      const last = t[t.length - 1];
      if (!last || dist(last, v.pos) > 3) {
        t.push(v.pos);
        if (t.length > 220) t.shift();
        trailsRef.current.set(v.vehicleId, t);
      }
      v.trail = t.slice();
    }
    return snap;
  }, [tick]);

  // Event log for the control room feed.
  useEffect(() => {
    const entries: { t: number; text: string; level: RiskLevel }[] = [];
    for (const v of snapshot.vehicles) {
      const key = `${v.vehicleId}`;
      let sig = "";
      if (v.collision && v.collision.risk === "HIGH")
        sig = `HIGH COLLISION RISK — ${v.vehicleId} / ${v.collision.a === v.vehicleId ? v.collision.b : v.collision.a} @ ${Math.round(v.collision.distance)} m`;
      else if (v.curveWarning)
        sig = `BLIND CURVE ${v.curveWarning.curveId} ahead of ${v.vehicleId} — ${Math.round(v.curveWarning.distance)} m`;
      const short = sig.replace(/\d+ m/, "");
      if (sig && lastLogged.current[key] !== short) {
        lastLogged.current[key] = short;
        entries.push({ t: Date.now(), text: sig, level: v.risk });
      }
      if (!sig) lastLogged.current[key] = "";
    }
    if (entries.length) setLog((l) => [...entries, ...l].slice(0, 40));
  }, [snapshot]);

  return {
    ...snapshot,
    running,
    setRunning,
    speedFactor,
    setSpeedFactor,
    runDemo,
    runPassDemo,
    reset,
    demoActive,
    log,
    ingestExternalFix,
  };
}

/* --------------------------------------------------------------- internals */

/**
 * Advance the whole fleet one tick.
 *
 * Heavy dumpers: slow acceleration, strong braking. Each vehicle keeps to the
 * right-hand lane of a two-lane haul road, watches the traffic ahead through
 * the fused GPS/V2V/radar picture and performs a smooth side-passing
 * manoeuvre instead of ever sharing the same piece of road surface.
 */
function stepAll(state: Internal[], dt: number) {
  const now = Date.now();
  const geo = state.map((v) => {
    const r = roadById(v.roadId);
    const { pos, heading: fwd } = pointAt(r.points, v.s);
    const heading = v.dir === 1 ? fwd : (fwd + 180) % 360;
    return { v, r, centre: pos, heading, pos: offsetPos(pos, heading, v.lane) };
  });

  for (const g of geo) {
    const { v, r } = g;
    let target = r.speedLimit;
    let laneTarget = LANE_HALF;
    let drive: DriveState = "NORMAL_DRIVING";

    // ---- blind curves and junction approaches ----
    for (const c of blindCurves) {
      if (c.roadId !== v.roadId) continue;
      const d = distMeters(g.centre, c.pos);
      if (d < c.warningDistance * 0.75) target = Math.min(target, c.recommendedSpeed + 4);
    }

    // ---- nearest relevant vehicle ahead (sensor fusion picture) ----
    const fwdVec: Pt = [Math.sin((g.heading * Math.PI) / 180), -Math.cos((g.heading * Math.PI) / 180)];
    let threat: Threat | null = null;
    let closest = Infinity;
    for (const o of geo) {
      if (o.v.vehicleId === v.vehicleId) continue;
      const d = distMeters(g.pos, o.pos);
      if (d > 260) continue;
      const to: Pt = [o.pos[0] - g.pos[0], o.pos[1] - g.pos[1]];
      const ahead = to[0] * fwdVec[0] + to[1] * fwdVec[1] > 0;
      if (!ahead) continue;
      const diff = Math.abs(((g.heading - o.heading + 540) % 360) - 180);
      const oncoming = diff > 120;
      const closingKph = oncoming ? v.speed + o.v.speed : Math.max(0, v.speed - o.v.speed);
      const closingMs = (closingKph * 1000) / 3600;
      const ttc = closingMs > 0.3 ? d / closingMs : Infinity;
      if (d < closest) {
        closest = d;
        threat = { id: o.v.vehicleId, distance: d, relativeSpeed: closingKph, ttc, oncoming };
      }
    }

    if (threat) {
      if (threat.oncoming) {
        if (threat.distance < 190 || threat.ttc < 16) {
          drive = "APPROACHING_VEHICLE";
          target = Math.min(target, 22);
        }
        if (threat.distance < 130 || threat.ttc < 10) {
          drive = "COLLISION_WARNING";
          target = Math.min(target, 16);
        }
        if (threat.distance < 100 || threat.ttc < 7) {
          drive = "LANE_CHANGE";
          laneTarget = LANE_HALF + PASS_EXTRA;
          target = Math.min(target, 12);
        }
        if (threat.distance < 45) {
          drive = "PASSING";
          laneTarget = LANE_HALF + PASS_EXTRA;
          target = Math.min(target, 9);
        }
      } else if (threat.distance < 70) {
        // Following distance behind a same-direction unit.
        drive = threat.distance < 40 ? "DECELERATING" : "APPROACHING_VEHICLE";
        target = Math.min(target, Math.max(6, threat.distance < 40 ? 8 : 16));
      }
      // Hard safety envelope — collision avoidance always outranks movement.
      if (threat.distance < MIN_SEPARATION + 8) {
        target = Math.min(target, threat.distance < MIN_SEPARATION ? 0 : 5);
        laneTarget = LANE_HALF + PASS_EXTRA;
      }
    }

    if (drive === "LANE_CHANGE" || drive === "PASSING") v.clearUntil = now + 4000;
    if (drive === "NORMAL_DRIVING") {
      if (Math.abs(v.lane - LANE_HALF) > 0.25) drive = "RETURNING_TO_LANE";
      else if (now < v.clearUntil) drive = "ROAD_CLEAR";
    }

    v.driveState = drive;
    v.threat = threat;

    // ---- longitudinal physics (heavy dumper) ----
    const accel = 3.2 * dt; // km/h per tick — slow to build speed
    const brake = 16 * dt; // strong service braking
    v.speed += Math.max(-brake, Math.min(accel, target - v.speed));
    v.speed = Math.max(0, v.speed);

    // ---- smooth lateral interpolation (never teleport) ----
    const delta = laneTarget - v.lane;
    const step = Math.max(-LANE_RATE * dt, Math.min(LANE_RATE * dt, delta));
    v.lane += step;
    v.laneRate = dt > 0 ? step / dt : 0;

    const unitsPerSec = (v.speed * (1000 / 3600)) / UNIT_METERS;
    v.s += unitsPerSec * dt * v.dir;

    if (r.loop) {
      if (v.s >= r.length) v.s -= r.length;
      if (v.s < 0) v.s += r.length;
    } else if (v.s >= r.length) {
      v.s = r.length;
      v.dir = -1;
    } else if (v.s <= 0) {
      v.s = 0;
      v.dir = 1;
    }
  }
}

function buildSnapshot(state: Internal[]) {
  const now = Date.now();

  const base = state.map((st) => {
    const spec = vehicleSpecs.find((v) => v.vehicleId === st.vehicleId)!;
    const r = roadById(st.roadId);
    const { pos: centre, heading: fwd } = pointAt(r.points, st.s);
    const centreHeading = st.dir === 1 ? fwd : (fwd + 180) % 360;
    const pos = offsetPos(centre, centreHeading, st.lane);
    // Yaw the icon slightly into the lane change so the path reads as a curve.
    const unitsPerSec = Math.max(0.5, (st.speed * (1000 / 3600)) / UNIT_METERS);
    const yaw = Math.max(-22, Math.min(22, (Math.atan2(st.laneRate, unitsPerSec) * 180) / Math.PI));
    const heading = (centreHeading + yaw + 360) % 360;
    const elevation = elevationAt(pos);
    const { lat, lon } = toLatLon(pos);
    return { st, spec, r, pos, heading, elevation, lat, lon };
  });


  // ---- V2V message exchange + risk engine ----
  const links: V2VLink[] = [];
  for (let i = 0; i < base.length; i++) {
    for (let j = i + 1; j < base.length; j++) {
      const a = base[i]!;
      const b = base[j]!;
      const d = distMeters(a.pos, b.pos);
      if (d > 600) continue;

      const va = velocity(a.heading, a.st.speed);
      const vb = velocity(b.heading, b.st.speed);
      const dx = b.pos[0] - a.pos[0];
      const dy = b.pos[1] - a.pos[1];
      const n = Math.hypot(dx, dy) || 1;
      // Closing rate along the line of sight (km/h, positive = closing).
      const relative = ((va[0] - vb[0]) * dx + (va[1] - vb[1]) * dy) / n;

      // 0deg heading difference = same direction (following), 180deg = head-on.
      const diff = Math.abs(((a.heading - b.heading + 540) % 360) - 180);
      const approach: V2VLink["approach"] =
        relative <= 0.5 ? "DIVERGING" : diff > 135 ? "HEAD-ON" : diff < 45 ? "FOLLOWING" : "CONVERGING";


      let risk: RiskLevel = "SAFE";
      if (relative > 0.5) {
        if (d < 60) risk = "HIGH";
        else if (d < 140) risk = "MEDIUM";
        else if (d < 260) risk = "CAUTION";
      } else if (d < 45) risk = "CAUTION";

      links.push({ a: a.st.vehicleId, b: b.st.vehicleId, distance: d, relativeSpeed: relative, approach, risk });
    }
  }

  const vehicles: VehicleSnapshot[] = base.map((v) => {
    // Blind-curve proximity (ahead of the vehicle only).
    let curveWarning: CurveWarning | null = null;
    for (const c of blindCurves) {
      if (c.roadId !== v.st.roadId) continue;
      const d = distMeters(v.pos, c.pos);
      if (d > c.warningDistance) continue;
      const toC: Pt = [c.pos[0] - v.pos[0], c.pos[1] - v.pos[1]];
      const fw = velocity(v.heading, 1);
      if (toC[0] * fw[0] + toC[1] * fw[1] <= 0) continue; // behind us
      if (!curveWarning || d < curveWarning.distance)
        curveWarning = {
          curveId: c.curveId,
          curveName: c.curveName,
          distance: d,
          recommendedSpeed: c.recommendedSpeed,
          riskLevel: c.riskLevel,
        };
    }

    const mine = links.filter((l) => l.a === v.st.vehicleId || l.b === v.st.vehicleId);
    const collision =
      mine.slice().sort((x, y) => RISK_ORDER[y.risk] - RISK_ORDER[x.risk] || x.distance - y.distance)[0] ?? null;

    let risk: RiskLevel = "SAFE";
    if (collision) risk = maxRisk(risk, collision.risk);
    if (curveWarning) {
      const proximity = curveWarning.distance < 60 ? "HIGH" : curveWarning.distance < 110 ? "MEDIUM" : "CAUTION";
      risk = maxRisk(risk, proximity as RiskLevel);
    }

    const area = siteAreas.find(
      (a) => Math.hypot((v.pos[0] - a.center[0]) / a.rx, (v.pos[1] - a.center[1]) / a.ry) <= 1,
    );
    const zone = riskZones.find(
      (z) => Math.hypot((v.pos[0] - z.center[0]) / z.rx, (v.pos[1] - z.center[1]) / z.ry) <= 1,
    );
    if (zone) risk = maxRisk(risk, zone.riskLevel === "HIGH" ? "CAUTION" : "SAFE");

    // ---- simulated mmWave radar sweep around this vehicle ----
    const radar: RadarContact[] = [];
    const relBearing = (p: Pt) => {
      const abs = (Math.atan2(p[0] - v.pos[0], -(p[1] - v.pos[1])) * 180) / Math.PI;
      return ((abs - v.heading + 540) % 360) - 180;
    };
    for (const o of base) {
      if (o.st.vehicleId === v.st.vehicleId) continue;
      const d = distMeters(v.pos, o.pos);
      if (d <= RADAR_RANGE)
        radar.push({ id: o.st.vehicleId, kind: "VEHICLE", distance: d, bearing: relBearing(o.pos) });
    }
    for (const o of OBSTACLES) {
      const d = distMeters(v.pos, o.pos);
      if (d <= RADAR_RANGE) radar.push({ id: o.id, kind: o.kind, distance: d, bearing: relBearing(o.pos) });
    }
    radar.sort((a, b) => a.distance - b.distance);
    const radarAlert = radar.some((c) => c.distance < 25 && Math.abs(c.bearing) < 70);
    if (radarAlert) risk = maxRisk(risk, "MEDIUM");

    return {
      radar,
      radarAlert,
      trail: [] as Pt[],
      lane: v.st.lane,
      driveState: v.st.driveState,
      threat: v.st.threat,
      vehicleId: v.st.vehicleId,
      label: v.spec.label,
      payload: v.spec.payload,
      pos: v.pos,
      heading: v.heading,
      headingText: headingLabel(v.heading),
      speed: v.st.speed,
      elevation: v.elevation,
      roadId: v.r.roadId,
      roadName: v.r.roadName,
      speedLimit: v.r.speedLimit,
      gps: {
        vehicleId: v.st.vehicleId,
        lat: v.lat,
        lon: v.lon,
        speed: v.st.speed,
        heading: v.heading,
        altitude: v.elevation,
        timestamp: now,
      },
      risk,
      v2v: true,
      peers: mine.length,
      curveWarning,
      collision: collision && collision.risk !== "SAFE" ? collision : null,
      areaStatus: area ? `${area.areaId} — ${area.status}` : null,
      zone: zone ? `${zone.zoneId} — ${zone.zoneType}` : null,
    };
  });

  const rsuSnapshots: RsuSnapshot[] = rsus.map((r) => {
    const detected = vehicles.filter((v) => dist(v.pos, r.pos) <= r.range).map((v) => v.vehicleId);
    return { rsuId: r.rsuId, name: r.name, online: true, detected, lastComm: now };
  });

  const overall = vehicles.reduce<RiskLevel>((acc, v) => maxRisk(acc, v.risk), "SAFE");
  const critical =
    vehicles.find((v) => v.collision?.risk === "HIGH") ??
    vehicles.find((v) => v.risk === "HIGH") ??
    null;

  return { vehicles, links, rsuSnapshots, overall, critical, now };
}

/** Velocity vector in map-space from heading (0 = north) and speed. */
function velocity(heading: number, speed: number): Pt {
  const rad = (heading * Math.PI) / 180;
  return [Math.sin(rad) * speed, -Math.cos(rad) * speed];
}
