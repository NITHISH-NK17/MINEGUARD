/**
 * MINEGUARD driver mode — 3D perception display for an open-cast mine haul truck.
 *
 * The 3D world dominates the screen; the HUD stays minimal and warnings appear
 * only when the fused GPS + IMU + mmWave radar + V2V picture calls for them.
 * The original 2D satellite driver map is still available via the MAP toggle.
 *
 * Prototype / simulation — no hardware is connected and this is not autonomous
 * vehicle control.
 */

import type { Map as LeafletMap } from "leaflet";
import { lazy, Suspense, useCallback, useState } from "react";
import { RADAR_RANGE, type DriveState, type VehicleSnapshot } from "@/lib/mine/useMineSim";
import type { CameraMode } from "./three/PerceptionView";

const PerceptionView = lazy(() => import("./three/PerceptionView"));
const DriverMap = lazy(() => import("./DriverMap"));

export type Scenario = "NORMAL" | "FOG" | "BLIND_CURVE" | "ONCOMING" | "COLLISION";

const BTN =
  "rounded-sm border border-panel-line bg-panel/80 px-2.5 py-1.5 font-display text-[11px] font-semibold uppercase tracking-widest backdrop-blur-sm transition-colors hover:border-primary";
const BTN_ON = "rounded-sm border border-primary bg-primary/15 px-2.5 py-1.5 font-display text-[11px] font-semibold uppercase tracking-widest text-primary backdrop-blur-sm";

/** Simulation drive states mapped to the driver-facing state machine. */
const STATE_LABEL: Record<DriveState, string> = {
  NORMAL_DRIVING: "NORMAL",
  APPROACHING_VEHICLE: "VEHICLE DETECTED",
  COLLISION_WARNING: "COLLISION RISK",
  DECELERATING: "SLOW DOWN",
  LANE_CHANGE: "SAFE SIDE SHIFT",
  PASSING: "PASSING",
  RETURNING_TO_LANE: "RETURN TO PATH",
  ROAD_CLEAR: "ROAD CLEAR",
};

function fmtTtc(t: number | undefined | null) {
  if (t === undefined || t === null || !Number.isFinite(t)) return "—";
  return `${t.toFixed(1)} s`;
}

export default function DriverView({
  vehicles,
  selected,
  onSelect,
  onExit,
  onRunDemo,
  onReset,
  running,
  onToggleRunning,
}: {
  vehicles: VehicleSnapshot[];
  selected: string;
  onSelect: (id: string) => void;
  onExit: () => void;
  onRunDemo: () => void;
  onReset: () => void;
  running: boolean;
  onToggleRunning: () => void;
}) {
  const me = vehicles.find((v) => v.vehicleId === selected) ?? vehicles[0]!;
  const others = vehicles.filter((v) => v.vehicleId !== me.vehicleId);
  const [camera, setCamera] = useState<CameraMode>("FOLLOW");
  const [fog, setFog] = useState(false);
  const [scenario, setScenario] = useState<Scenario>("NORMAL");
  const [view3d, setView3d] = useState(true);
  const [, setMap] = useState<LeafletMap | null>(null);
  const grabMap = useCallback((m: LeafletMap) => setMap(m), []);

  const st = me.driveState;
  const threat = me.threat;
  const nearest = [...others]
    .map((o) => ({ o, d: Math.hypot(o.pos[0] - me.pos[0], o.pos[1] - me.pos[1]) * 2 }))
    .sort((a, b) => a.d - b.d)[0];

  const critical = st === "COLLISION_WARNING" || st === "LANE_CHANGE" || st === "PASSING" || me.risk === "HIGH";
  const caution =
    !critical && (st === "APPROACHING_VEHICLE" || st === "DECELERATING" || !!me.curveWarning || me.radarAlert);
  const safety: "SAFE" | "CAUTION" | "HIGH" = critical ? "HIGH" : caution ? "CAUTION" : "SAFE";
  const overspeed = me.speed > me.speedLimit + 1;

  /** Beyond-line-of-sight detection near a blind curve (radar + V2V only). */
  const curveThreat =
    me.curveWarning && threat && threat.oncoming && threat.distance > 45 ? me.curveWarning : null;

  const runScenario = (s: Scenario) => {
    setScenario(s);
    if (s === "FOG") {
      setFog(true);
      onRunDemo();
    } else if (s === "NORMAL") {
      setFog(false);
      onReset();
    } else {
      onRunDemo();
    }
  };

  return (
    <main className="relative h-screen w-full overflow-hidden bg-background text-foreground">
      <h1 className="sr-only">MINEGUARD driver perception display</h1>

      {/* ------------------------------- 3D world ------------------------------- */}
      <div className="absolute inset-0">
        <Suspense
          fallback={
            <div className="grid h-full place-items-center font-display text-sm tracking-[0.3em] text-primary">
              BUILDING MINE PERCEPTION MODEL…
            </div>
          }
        >
          {view3d ? (
            <PerceptionView me={me} others={others} cameraMode={camera} fog={fog} safety={safety} />
          ) : (
            <DriverMap me={me} others={others} headingUp satellite tilt zoom={18} onMap={grabMap} />
          )}
        </Suspense>
      </div>

      {/* -------------------------------- top bar -------------------------------- */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3">
        <div className="pointer-events-auto flex items-center gap-2 rounded-sm border border-panel-line bg-background/70 px-3 py-2 backdrop-blur-md">
          <span className="font-display text-lg font-bold tracking-[0.22em] text-primary">MINEGUARD</span>
          <span className="hidden font-mono text-[10px] tracking-widest text-muted-foreground sm:block">
            DRIVER PERCEPTION · SIMULATION
          </span>
          <span className="ml-2 flex gap-2 font-mono text-[10px]">
            <Chip ok label="GPS" />
            <Chip ok label="IMU" />
            <Chip ok label="RADAR" />
            <Chip ok={me.peers > 0} label="V2V" />
          </span>
        </div>

        <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-1.5">
          {vehicles.map((v) => (
            <button
              key={v.vehicleId}
              onClick={() => onSelect(v.vehicleId)}
              className={v.vehicleId === me.vehicleId ? BTN_ON : BTN}
            >
              TRUCK {v.vehicleId.slice(1)}
            </button>
          ))}
          <button className={view3d ? BTN : BTN_ON} onClick={() => setView3d((x) => !x)}>
            {view3d ? "2D Map" : "3D View"}
          </button>
          <button className={BTN} onClick={onExit}>
            Control Center
          </button>
        </div>
      </header>

      {/* ------------------------------- warnings -------------------------------- */}
      <div className="pointer-events-none absolute left-1/2 top-20 z-30 w-[min(640px,92%)] -translate-x-1/2 space-y-2">
        {critical && (
          <Banner tone="high">
            <p className="font-display text-3xl font-bold tracking-[0.14em] text-risk-high">🔴 COLLISION RISK</p>
            <p className="font-mono text-sm">
              {threat ? `${threat.id} · ${Math.round(threat.distance)} m · TTC ${fmtTtc(threat.ttc)} · ` : ""}
              REDUCE SPEED — {STATE_LABEL[st]}
            </p>
          </Banner>
        )}
        {!critical && curveThreat && (
          <Banner tone="caution">
            <p className="font-display text-2xl font-bold tracking-[0.12em] text-risk-caution">
              ⚠ VEHICLE DETECTED BEYOND CURVE
            </p>
            <p className="font-mono text-sm">
              {curveThreat.curveId} · DISTANCE {threat ? Math.round(threat.distance) : "—"} m · RADAR + V2V
            </p>
          </Banner>
        )}
        {!critical && !curveThreat && caution && (
          <Banner tone="caution">
            <p className="font-display text-2xl font-bold tracking-[0.12em] text-risk-caution">
              ⚠ {me.curveWarning ? `BLIND CURVE ${me.curveWarning.curveId} AHEAD` : "VEHICLE NEARBY"}
            </p>
            <p className="font-mono text-sm">
              {me.curveWarning
                ? `${Math.round(me.curveWarning.distance)} m · REC ${me.curveWarning.recommendedSpeed} km/h`
                : threat
                  ? `${threat.id} · ${Math.round(threat.distance)} m · TTC ${fmtTtc(threat.ttc)}`
                  : "RADAR CONTACT IN SAFETY ENVELOPE"}
            </p>
          </Banner>
        )}
        {fog && (
          <Banner tone="caution">
            <p className="font-display text-lg font-bold tracking-[0.12em] text-risk-caution">
              🌫 LOW VISIBILITY — RADAR + V2V PERCEPTION ACTIVE
            </p>
          </Banner>
        )}
        {overspeed && !critical && (
          <Banner tone="caution">
            <p className="font-display text-lg font-bold tracking-widest text-risk-medium">
              ⚠ OVERSPEED {me.speed.toFixed(0)} / {me.speedLimit} km/h
            </p>
          </Banner>
        )}
      </div>

      {/* ------------------------------ camera modes ----------------------------- */}
      <div className="absolute right-3 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1.5">
        {(["DRIVER", "FOLLOW", "TOP"] as CameraMode[]).map((m) => (
          <button key={m} className={camera === m ? BTN_ON : BTN} onClick={() => setCamera(m)}>
            {m === "TOP" ? "Bird's eye" : m === "DRIVER" ? "Driver view" : "Follow view"}
          </button>
        ))}
        <button className={fog ? BTN_ON : BTN} onClick={() => setFog((f) => !f)}>
          {fog ? "Fog: on" : "Fog: off"}
        </button>
      </div>

      {/* --------------------------------- HUD ----------------------------------- */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-end justify-between gap-3 p-3">
        <div className="pointer-events-auto flex items-end gap-4 rounded-sm border border-panel-line bg-background/70 px-4 py-2.5 backdrop-blur-md">
          <div>
            <span className="tech-label block">Speed</span>
            <span className="font-display text-4xl font-bold leading-none">{me.speed.toFixed(0)}</span>
            <span className="ml-1 font-mono text-xs text-muted-foreground">km/h · lim {me.speedLimit}</span>
          </div>
          <div className="border-l border-panel-line pl-4">
            <span className="tech-label block">Safety</span>
            <span
              className={`font-display text-lg font-bold tracking-widest ${
                safety === "HIGH" ? "text-risk-high" : safety === "CAUTION" ? "text-risk-caution" : "text-risk-safe"
              }`}
            >
              {safety === "HIGH" ? "🔴 RISK" : safety === "CAUTION" ? "🟡 CAUTION" : "🟢 SAFE"}
            </span>
          </div>
          <div className="border-l border-panel-line pl-4 font-mono text-xs">
            <span className="tech-label block">Visibility</span>
            {fog ? <span className="text-risk-caution">LOW</span> : "NORMAL"}
          </div>
          <div className="border-l border-panel-line pl-4 font-mono text-xs">
            <span className="tech-label block">Nearest vehicle</span>
            {nearest ? `${nearest.o.vehicleId} · ${Math.round(nearest.d)} m` : "—"}
          </div>
          <div className="border-l border-panel-line pl-4 font-mono text-xs">
            <span className="tech-label block">TTC</span>
            <span className={threat && threat.ttc < 8 ? "text-risk-high" : ""}>{fmtTtc(threat?.ttc)}</span>
          </div>
          <div className="hidden border-l border-panel-line pl-4 font-mono text-xs xl:block">
            <span className="tech-label block">State</span>
            {STATE_LABEL[st]}
          </div>
          <div className="hidden border-l border-panel-line pl-4 font-mono text-xs xl:block">
            <span className="tech-label block">Road</span>
            {me.roadId} · RL {me.elevation} m · {me.radar.length} radar contact
            {me.radar.length === 1 ? "" : "s"} · {RADAR_RANGE} m
          </div>
        </div>

        {/* ---------------------------- simulation ---------------------------- */}
        <div className="pointer-events-auto flex flex-col items-end gap-1.5 rounded-sm border border-panel-line bg-background/70 px-3 py-2 backdrop-blur-md">
          <span className="tech-label">Simulation</span>
          <div className="flex flex-wrap justify-end gap-1.5">
            <button className={BTN} onClick={onToggleRunning}>
              {running ? "⏸ Pause" : "▶ Start"}
            </button>
            <button
              className={BTN}
              onClick={() => {
                setScenario("NORMAL");
                setFog(false);
                onReset();
              }}
            >
              ↻ Reset
            </button>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {(
              [
                ["NORMAL", "Normal driving"],
                ["FOG", "Fog scenario"],
                ["BLIND_CURVE", "Blind curve"],
                ["ONCOMING", "Oncoming vehicle"],
                ["COLLISION", "Collision avoidance"],
              ] as [Scenario, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                className={scenario === id ? BTN_ON : BTN}
                onClick={() => runScenario(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="pointer-events-none absolute bottom-1 left-1/2 z-10 -translate-x-1/2 font-mono text-[9px] tracking-widest text-muted-foreground/70">
        SIMULATED BAILADILA-INSPIRED MINE · GPS + IMU + RADAR + V2V FUSION PROTOTYPE · NOT AN OFFICIAL NMDC MAP
      </p>
    </main>
  );
}

function Chip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className={ok ? "text-risk-safe" : "text-risk-medium"}>
      {label} {ok ? "✓" : "…"}
    </span>
  );
}

function Banner({ tone, children }: { tone: "high" | "caution"; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-sm border-2 px-4 py-2 text-center shadow-[0_10px_34px_rgba(0,0,0,0.6)] backdrop-blur-md ${
        tone === "high" ? "pulse-alarm border-risk-high bg-background/90" : "border-risk-caution bg-background/85"
      }`}
    >
      {children}
    </div>
  );
}
