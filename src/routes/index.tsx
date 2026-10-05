import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import DriverView from "@/components/mine/DriverView";
import { EventLog, RISK_STYLE, Row } from "@/components/mine/Panels";
import type { CameraCmd, Layers, ViewMode } from "@/components/mine/three/CommandView";
import { visibilityCells } from "@/components/mine/three/CommandView";
import type { RiskLevel } from "@/lib/mine/data";
import { useMineSim, type VehicleSnapshot } from "@/lib/mine/useMineSim";
import type { FlyTarget } from "@/components/mine/ControlMap";

const ControlMap = lazy(() => import("@/components/mine/ControlMap"));
const CommandView = lazy(() => import("@/components/mine/three/CommandView"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MINEGUARD Mine Command Center — 3D Digital Twin & Fleet Safety" },
      {
        name: "description",
        content:
          "MINEGUARD mine command center: a 3D digital twin of a simulated Bailadila-inspired open-cast iron ore mine with live haul-truck tracking, collision-risk alerts, blind-curve detection and fog visibility mapping.",
      },
      { property: "og:title", content: "MINEGUARD Mine Command Center" },
      {
        property: "og:description",
        content:
          "3D mine digital twin, live mining fleet tracking, MINEGUARD safety intelligence and real-time incident monitoring.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: FognetApp,
});

type Scenario = "NORMAL" | "FOG" | "BLIND_CURVE" | "ONCOMING" | "COLLISION";

const SCENARIOS: [Scenario, string][] = [
  ["NORMAL", "Normal operation"],
  ["FOG", "Fog scenario"],
  ["BLIND_CURVE", "Blind curve"],
  ["ONCOMING", "Oncoming vehicle"],
  ["COLLISION", "Collision risk"],
];

const DEFAULT_LAYERS: Layers = {
  vehicles: true,
  roads: true,
  benches: true,
  zones: true,
  fog: true,
  rsus: true,
  loading: true,
  dump: true,
};

const LAYER_LABEL: Record<keyof Layers, string> = {
  vehicles: "Vehicles",
  roads: "Haul roads",
  benches: "Benches",
  zones: "Danger zones",
  fog: "Fog / visibility",
  rsus: "RSUs",
  loading: "Loading areas",
  dump: "Dump areas",
};

function FognetApp() {
  const sim = useMineSim();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [mode, setMode] = useState<"CONTROL" | "DRIVER">("CONTROL");
  const [selectedVehicle, setSelectedVehicle] = useState<string>("V01");
  const [detailOpen, setDetailOpen] = useState(false);
  const [flyTarget] = useState<FlyTarget>(null);

  const [surface, setSurface] = useState<"3D" | "SAT">("3D");
  const [view, setView] = useState<ViewMode>("3D");
  const [follow, setFollow] = useState(false);
  const [fog, setFog] = useState(false);
  const [scenario, setScenario] = useState<Scenario>("NORMAL");
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [cmd, setCmd] = useState<CameraCmd>(null);
  const [clock, setClock] = useState("--:--:--");

  useEffect(() => {
    const id = setInterval(() => setClock(new Date().toLocaleTimeString("en-GB")), 1000);
    setClock(new Date().toLocaleTimeString("en-GB"));
    return () => clearInterval(id);
  }, []);

  const camera = (type: "RESET" | "ZOOM_IN" | "ZOOM_OUT") => setCmd({ type, n: Date.now() });

  const runScenario = (s: Scenario) => {
    setScenario(s);
    if (s === "NORMAL") {
      setFog(false);
      sim.reset();
      sim.setRunning(true);
    } else if (s === "FOG") {
      setFog(true);
      sim.setRunning(true);
    } else if (s === "BLIND_CURVE") {
      sim.runDemo();
      setSelectedVehicle("V01");
    } else {
      sim.runPassDemo();
      setSelectedVehicle("V01");
      setFollow(true);
    }
  };

  /* ------------------------------------------------------------- alerts */
  const seen = useRef(new Map<string, number>());
  const alerts = useMemo(() => {
    const out: { key: string; level: RiskLevel; title: string; body: string; t: number }[] = [];
    const push = (key: string, level: RiskLevel, title: string, body: string) => {
      const t = seen.current.get(key) ?? Date.now();
      seen.current.set(key, t);
      out.push({ key, level, title, body, t });
    };
    for (const l of sim.links) {
      if (l.risk === "SAFE") continue;
      push(
        `c${l.a}${l.b}${l.risk}`,
        l.risk,
        l.risk === "HIGH" ? "COLLISION RISK" : l.risk === "MEDIUM" ? "PROXIMITY WARNING" : "CAUTION",
        `TRUCK ${l.a.slice(1)} ↔ TRUCK ${l.b.slice(1)} · ${Math.round(l.distance)} m · Δv ${l.relativeSpeed.toFixed(1)} km/h${
          l.relativeSpeed > 0.5 ? ` · TTC ${(l.distance / ((l.relativeSpeed * 1000) / 3600)).toFixed(1)} s` : ""
        }`,
      );
    }
    for (const v of sim.vehicles) {
      if (v.curveWarning)
        push(
          `b${v.vehicleId}${v.curveWarning.curveId}`,
          "CAUTION",
          "BLIND CURVE",
          `Vehicle detected beyond ${v.curveWarning.curveId} — TRUCK ${v.vehicleId.slice(1)} at ${Math.round(v.curveWarning.distance)} m · rec ${v.curveWarning.recommendedSpeed} km/h`,
        );
    }
    for (const c of visibilityCells(fog)) {
      if (c.level === "CRITICAL")
        push(`v${c.id}${fog}`, "MEDIUM", "LOW VISIBILITY", `${c.id} — visibility critical, radar/V2V assist active`);
    }
    // prune stale keys
    const live = new Set(out.map((o) => o.key));
    for (const k of Array.from(seen.current.keys())) if (!live.has(k)) seen.current.delete(k);
    return out.sort((a, b) => b.t - a.t).slice(0, 12);
  }, [sim.links, sim.vehicles, fog]);

  const counts = useMemo(() => {
    let safe = 0;
    let caution = 0;
    let critical = 0;
    for (const v of sim.vehicles) {
      if (v.risk === "HIGH") critical++;
      else if (v.risk === "SAFE") safe++;
      else caution++;
    }
    return { safe, caution, critical };
  }, [sim.vehicles]);

  const rsuOnline = sim.rsuSnapshots.filter((r) => r.online).length;
  const worstVis = visibilityCells(fog).some((c) => c.level === "CRITICAL")
    ? "LOW"
    : visibilityCells(fog).some((c) => c.level === "REDUCED")
      ? "MODERATE"
      : "GOOD";
  const selected = sim.vehicles.find((v) => v.vehicleId === selectedVehicle) ?? null;

  if (mounted && mode === "DRIVER") {
    return (
      <DriverView
        vehicles={sim.vehicles}
        selected={selectedVehicle}
        onSelect={setSelectedVehicle}
        onExit={() => setMode("CONTROL")}
        onRunDemo={() => {
          setSelectedVehicle("V01");
          sim.runPassDemo();
        }}
        onReset={sim.reset}
        running={sim.running}
        onToggleRunning={() => sim.setRunning(!sim.running)}
      />
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-background p-2 text-foreground">
      <h1 className="sr-only">MINEGUARD mine command center — 3D digital twin and fleet safety monitoring</h1>

      {/* -------------------------------------------------------- header */}
      <header className="panel-frame mb-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2">
        <div className="flex items-center gap-4">
          <div>
            <p className="font-display text-xl font-bold leading-none tracking-[0.22em] text-primary">MINEGUARD</p>
            <p className="tech-label">Mine command center</p>
          </div>
          <span className="flex items-center gap-1.5 font-mono text-xs text-risk-safe">
            <span className="pulse-alarm inline-block h-2 w-2 rounded-full bg-risk-safe" /> LIVE
          </span>
          <p className="hidden font-mono text-[11px] text-muted-foreground lg:block">
            Bailadila-inspired mine simulation · Dantewada, Chhattisgarh
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/live" className="rounded-sm border border-panel-line px-3 py-1 font-mono text-xs uppercase hover:text-primary">
            Live vehicle
          </Link>
          <Link to="/maps" className="rounded-sm border border-panel-line px-3 py-1 font-mono text-xs uppercase hover:text-primary">
            Maps
          </Link>
          <span className="font-mono text-sm tabular-nums text-foreground">{clock}</span>

          <button
            onClick={() => setFog((f) => !f)}
            className={`rounded-sm border px-3 py-1 font-mono text-xs uppercase ${
              fog ? "border-risk-caution bg-risk-caution/15 text-risk-caution" : "border-panel-line text-muted-foreground"
            }`}
          >
            Fog mode: {fog ? "on" : "off"}
          </button>
          <div className="flex overflow-hidden rounded-sm border border-panel-line">
            <button className="bg-primary px-3 py-1 font-display text-xs font-semibold uppercase tracking-widest text-primary-foreground">
              Command
            </button>
            <button
              onClick={() => setMode("DRIVER")}
              className="px-3 py-1 font-display text-xs font-semibold uppercase tracking-widest hover:text-primary"
            >
              Driver map
            </button>
          </div>
        </div>
      </header>

      {/* --------------------------------------------------------- stats */}
      <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Active vehicles" value={String(sim.vehicles.length).padStart(2, "0")} />
        <Stat label="Safe" value={String(counts.safe)} tone="text-risk-safe" />
        <Stat label="Caution" value={String(counts.caution)} tone="text-risk-caution" />
        <Stat label="Critical" value={String(counts.critical)} tone="text-risk-high" />
        <Stat label="Active alerts" value={String(alerts.length).padStart(2, "0")} tone="text-risk-medium" />
        <Stat
          label="Visibility"
          value={worstVis}
          tone={worstVis === "LOW" ? "text-risk-high" : worstVis === "MODERATE" ? "text-risk-caution" : "text-risk-safe"}
        />
      </div>

      {!mounted && (
        <div className="panel-frame px-4 py-10 text-center">
          <p className="font-display text-xl tracking-[0.2em] text-primary">INITIALISING MINE DIGITAL TWIN…</p>
          <p className="tech-label mt-2">Loading terrain · fleet · GPS · V2V · RSU mesh</p>
        </div>
      )}

      {mounted && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 xl:grid-cols-[250px_minmax(0,1fr)_310px]">
          {/* ------------------------------------------------------ fleet */}
          <aside className="panel-frame flex min-h-0 flex-col">
            <header className="border-b border-panel-line px-3 py-2">
              <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em]">Fleet</h2>
            </header>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
              {sim.vehicles.map((v) => {
                const s = RISK_STYLE[v.risk];
                const on = v.vehicleId === selectedVehicle;
                return (
                  <button
                    key={v.vehicleId}
                    onClick={() => {
                      setSelectedVehicle(v.vehicleId);
                      setDetailOpen(true);
                      setFollow(true);
                    }}
                    className={`w-full rounded-sm border px-2.5 py-2 text-left transition-colors ${
                      on ? "border-primary" : "border-panel-line hover:border-primary/60"
                    } ${s.bg}`}
                  >
                    <div className="flex items-center justify-between font-mono text-xs">
                      <span className="font-semibold tracking-wide">TRUCK {v.vehicleId.slice(1)}</span>
                      <span className={s.text}>{s.dot}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                      <span>{v.speed.toFixed(0)} km/h</span>
                      <span>{v.roadId}</span>
                    </div>
                  </button>
                );
              })}
              <div className="mt-2 border-t border-panel-line pt-2 font-mono text-[11px] text-muted-foreground">
                <Row k="Vehicles" v={sim.vehicles.length} />
                <Row k="Safe" v={counts.safe} accent="text-risk-safe" />
                <Row k="Caution" v={counts.caution} accent="text-risk-caution" />
                <Row k="Risk" v={counts.critical} accent="text-risk-high" />
              </div>

              <div className="mt-2 border-t border-panel-line pt-2">
                <p className="tech-label mb-1">Map layers</p>
                {(Object.keys(layers) as (keyof Layers)[]).map((k) => (
                  <label key={k} className="flex cursor-pointer items-center gap-2 py-[3px] font-mono text-[11px]">
                    <input
                      type="checkbox"
                      checked={layers[k]}
                      onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })}
                      className="accent-[var(--primary)]"
                    />
                    <span className="text-muted-foreground">{LAYER_LABEL[k]}</span>
                  </label>
                ))}
              </div>
            </div>
          </aside>

          {/* --------------------------------------------------- hero map */}
          <section className="panel-frame relative flex min-h-[62vh] flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-panel-line px-3 py-1.5">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em]">Mine digital twin</h2>
                <div className="flex overflow-hidden rounded-sm border border-panel-line font-mono text-[11px]">
                  {(["3D", "SAT"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSurface(s)}
                      className={`px-2 py-0.5 uppercase ${surface === s ? "bg-primary text-primary-foreground" : "hover:text-primary"}`}
                    >
                      {s === "3D" ? "3D twin" : "Satellite"}
                    </button>
                  ))}
                </div>
              </div>
              {surface === "3D" && (
                <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
                  {(["3D", "TOP"] as ViewMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => setView(m)}
                      className={`rounded-sm border px-2 py-0.5 uppercase ${
                        view === m ? "border-primary text-primary" : "border-panel-line text-muted-foreground"
                      }`}
                    >
                      {m === "TOP" ? "Top view" : "3D view"}
                    </button>
                  ))}
                  <button onClick={() => camera("ZOOM_IN")} className="rounded-sm border border-panel-line px-2 py-0.5">
                    Zoom +
                  </button>
                  <button onClick={() => camera("ZOOM_OUT")} className="rounded-sm border border-panel-line px-2 py-0.5">
                    Zoom −
                  </button>
                  <button onClick={() => camera("RESET")} className="rounded-sm border border-panel-line px-2 py-0.5 uppercase">
                    Reset view
                  </button>
                  <button
                    onClick={() => setFollow((f) => !f)}
                    className={`rounded-sm border px-2 py-0.5 uppercase ${
                      follow ? "border-primary text-primary" : "border-panel-line text-muted-foreground"
                    }`}
                  >
                    Follow {selectedVehicle}
                  </button>
                </div>
              )}
            </div>

            <div className="relative min-h-0 flex-1">
              <Suspense
                fallback={<div className="grid h-full place-items-center font-mono text-xs">LOADING MINE TWIN…</div>}
              >
                {surface === "3D" ? (
                  <CommandView
                    vehicles={sim.vehicles}
                    links={sim.links}
                    selectedId={selectedVehicle}
                    onSelect={(id) => {
                      setSelectedVehicle(id);
                      setDetailOpen(true);
                    }}
                    fog={fog}
                    follow={follow}
                    view={view}
                    layers={layers}
                    cmd={cmd}
                  />
                ) : (
                  <ControlMap
                    vehicles={sim.vehicles}
                    links={sim.links}
                    selectedVehicle={selectedVehicle}
                    onSelectVehicle={setSelectedVehicle}
                    selectedZone={null}
                    onSelectZone={() => {}}
                    flyTarget={flyTarget}
                  />
                )}
              </Suspense>

              {/* simulation controls */}
              <div className="pointer-events-none absolute bottom-2 left-2 right-2 flex flex-wrap items-center gap-2">
                <div className="pointer-events-auto flex items-center gap-1 rounded-sm border border-panel-line bg-background/85 px-2 py-1 backdrop-blur-sm">
                  <button
                    onClick={() => sim.setRunning(true)}
                    className="rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase hover:text-primary"
                  >
                    ▶ Start
                  </button>
                  <button
                    onClick={() => sim.setRunning(false)}
                    className="rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase hover:text-primary"
                  >
                    ⏸ Pause
                  </button>
                  <button
                    onClick={() => {
                      sim.reset();
                      setScenario("NORMAL");
                    }}
                    className="rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase hover:text-primary"
                  >
                    ↻ Reset
                  </button>
                  <span className="ml-1 font-mono text-[11px] text-muted-foreground">×{sim.speedFactor}</span>
                  <input
                    type="range"
                    min={1}
                    max={6}
                    step={1}
                    value={sim.speedFactor}
                    onChange={(e) => sim.setSpeedFactor(Number(e.target.value))}
                    className="w-16 accent-[var(--primary)]"
                    aria-label="Simulation speed"
                  />
                </div>
                <div className="pointer-events-auto flex flex-wrap gap-1 rounded-sm border border-panel-line bg-background/85 px-2 py-1 backdrop-blur-sm">
                  {SCENARIOS.map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => runScenario(id)}
                      className={`rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase ${
                        scenario === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-primary"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* vehicle detail */}
              {detailOpen && selected && (
                <div className="absolute right-2 top-2 w-60 rounded-sm border border-panel-line bg-background/92 p-3 backdrop-blur-sm">
                  <div className="mb-1 flex items-center justify-between">
                    <p className="font-display text-sm font-bold tracking-widest">TRUCK {selected.vehicleId.slice(1)}</p>
                    <button onClick={() => setDetailOpen(false)} className="font-mono text-xs text-muted-foreground hover:text-primary">
                      ✕
                    </button>
                  </div>
                  <p className={`font-mono text-xs ${RISK_STYLE[selected.risk].text}`}>
                    {RISK_STYLE[selected.risk].dot} {RISK_STYLE[selected.risk].label}
                  </p>
                  <div className="mt-2 border-t border-panel-line pt-2">
                    <Row k="Speed" v={`${selected.speed.toFixed(0)} km/h`} />
                    <Row k="Direction" v={`${selected.heading.toFixed(0)}° ${selected.headingText}`} />
                    <Row k="Zone" v={selected.zone ?? selected.areaStatus ?? selected.roadName} />
                    <Row k="Elevation" v={`RL ${selected.elevation}`} />
                    <Row k="State" v={selected.driveState.replace(/_/g, " ")} />
                    <Row k="GPS" v="✓" accent="text-risk-safe" />
                    <Row k="IMU" v="✓" accent="text-risk-safe" />
                    <Row k="Radar" v={selected.radarAlert ? "CONTACT" : "✓"} accent={selected.radarAlert ? "text-risk-medium" : "text-risk-safe"} />
                    <Row k="V2V" v={selected.v2v ? `✓ ×${selected.peers}` : "LOST"} accent={selected.v2v ? "text-risk-safe" : "text-risk-high"} />
                    <Row k="Nearest" v={nearestLabel(selected, sim.links)} />
                    <Row k="TTC" v={ttcLabel(selected, sim.links)} />
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ----------------------------------------------------- alerts */}
          <aside className="flex min-h-0 flex-col gap-2">
            <section className="panel-frame flex min-h-0 flex-1 flex-col">
              <header className="flex items-center justify-between border-b border-panel-line px-3 py-2">
                <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em]">Active safety alerts</h2>
                <span className="font-mono text-xs text-risk-medium">{String(alerts.length).padStart(2, "0")}</span>
              </header>
              <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
                {!alerts.length && <p className="tech-label">No active hazards — fleet nominal.</p>}
                {alerts.map((a) => {
                  const s = RISK_STYLE[a.level];
                  return (
                    <div key={a.key} className={`rounded-sm border ${s.border} ${s.bg} px-2 py-1.5`}>
                      <div className="flex items-center justify-between font-mono text-[11px]">
                        <span className={s.text}>
                          {s.dot} {a.title}
                        </span>
                        <span className="text-muted-foreground">{new Date(a.t).toLocaleTimeString("en-GB")}</span>
                      </div>
                      <p className="mt-0.5 font-mono text-[11px] text-foreground">{a.body}</p>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="panel-frame">
              <header className="border-b border-panel-line px-3 py-2">
                <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em]">Sensor network</h2>
              </header>
              <div className="p-2">
                <div className="grid grid-cols-2 gap-x-3 font-mono text-[11px]">
                  {[
                    ["GPS", "●"],
                    ["IMU", "●"],
                    ["RADAR", "●"],
                    ["V2V", "●"],
                  ].map(([k]) => (
                    <div key={k} className="flex items-center justify-between py-[2px]">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="text-risk-safe">●</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between py-[2px]">
                    <span className="text-muted-foreground">RSU</span>
                    <span className="text-risk-safe">
                      {rsuOnline}/{sim.rsuSnapshots.length}
                    </span>
                  </div>
                </div>
                <div className="mt-2 rounded-sm border border-panel-line p-2 text-center font-mono text-[10px] leading-5">
                  <p className="text-accent">GPS · IMU · mmWave RADAR · V2V · RSU</p>
                  <p className="text-muted-foreground">↓</p>
                  <p className="text-primary">SENSOR FUSION</p>
                  <p className="text-muted-foreground">↓</p>
                  <p className="text-risk-medium">RISK ENGINE</p>
                  <p className="text-muted-foreground">↓</p>
                  <p className="text-foreground">CONTROL CENTER → DRIVER WARNING</p>
                </div>
              </div>
            </section>

            <section className="panel-frame max-h-48 min-h-0">
              <header className="border-b border-panel-line px-3 py-2">
                <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em]">Incident log</h2>
              </header>
              <div className="max-h-32 overflow-auto p-2">
                <EventLog log={sim.log} />
              </div>
            </section>
          </aside>
        </div>
      )}

      {/* --------------------------------------------------- bottom bar */}
      <footer className="panel-frame mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-1.5 font-mono text-[11px]">
        {["GPS", "IMU", "RADAR", "V2V"].map((s) => (
          <span key={s} className="text-muted-foreground">
            {s} <span className="text-risk-safe">● CONNECTED</span>
          </span>
        ))}
        <span className="text-muted-foreground">
          RSU{" "}
          <span className="text-risk-safe">
            {rsuOnline}/{sim.rsuSnapshots.length}
          </span>
        </span>
        <span className="text-muted-foreground">
          MINEGUARD ENGINE <span className={sim.running ? "text-risk-safe" : "text-risk-caution"}>● {sim.running ? "ACTIVE" : "PAUSED"}</span>
        </span>
        <span className="ml-auto text-muted-foreground">
          Simulation / prototype · fictional Bailadila-inspired layout — not an official NMDC operational map
        </span>
      </footer>
    </main>
  );
}

function Stat({ label, value, tone = "text-foreground" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel-frame px-3 py-1.5">
      <p className="tech-label">{label}</p>
      <p className={`font-display text-lg font-bold leading-tight tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

function nearestLink(v: VehicleSnapshot, links: { a: string; b: string; distance: number; relativeSpeed: number }[]) {
  return links
    .filter((l) => l.a === v.vehicleId || l.b === v.vehicleId)
    .sort((x, y) => x.distance - y.distance)[0];
}

function nearestLabel(v: VehicleSnapshot, links: ReturnType<typeof useMineSim>["links"]) {
  const l = nearestLink(v, links);
  if (!l) return "—";
  return `TRUCK ${(l.a === v.vehicleId ? l.b : l.a).slice(1)} · ${Math.round(l.distance)} m`;
}

function ttcLabel(v: VehicleSnapshot, links: ReturnType<typeof useMineSim>["links"]) {
  const l = nearestLink(v, links);
  if (!l || l.relativeSpeed <= 0.5) return "—";
  return `${(l.distance / ((l.relativeSpeed * 1000) / 3600)).toFixed(1)} s`;
}
