import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { LEGEND, type FeatureInfo, type MapCmd, type MapRsuMarker, type MapVehicle } from "@/lib/mine/mapView";
import {
  DEFAULT_DEVICE_CONFIG,
  esp32Sketch,
  loadDeviceConfig,
  saveDeviceConfig,
  useDeviceLink,
  type DeviceConfig,
} from "@/lib/mine/deviceLink";
import { createRsuDemo, mergeRsus, rsusFromMap, rsuWarnings, useLiveRsus } from "@/lib/mine/rsuLive";
import { RISK_STYLE, Row } from "@/components/mine/Panels";
import { roadLines } from "@/lib/mine/geojson";
import { ll } from "@/lib/mine/geojson";
import {
  createDemoTransmitter,
  downloadText,
  trailToCsv,
  useLiveFleet,
  type FleetMode,
  type LiveVehicle,
} from "@/lib/mine/liveFleet";
import { evaluateLiveRisk, hazardsFromMap } from "@/lib/mine/liveRisk";
import { LAYER_LABEL, useMineMaps } from "@/lib/mine/mapStore";
import { accuracyLabel, fixLabel } from "@/lib/mine/telemetry";
import { useMineSim } from "@/lib/mine/useMineSim";

const MineMapView = lazy(() => import("@/components/mine/MineMapView"));

export const Route = createFileRoute("/live")({
  head: () => ({
    meta: [
      { title: "Live Vehicle Tracking — MINEGUARD Bailadila Mine Safety" },
      {
        name: "description",
        content:
          "Track real RTK GNSS + IMU mine vehicles on the MINEGUARD mine map: breadcrumb trail, GPS accuracy, RTK status, blind-curve and overspeed warnings, and V2V collision risk.",
      },
      { property: "og:title", content: "MINEGUARD — Live Vehicle Tracking" },
      {
        property: "og:description",
        content: "Live ESP32 vehicle telemetry on an imported QGIS mine map, connected to the MINEGUARD risk engine.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LivePage,
});

function LivePage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const maps = useMineMaps();
  const sim = useMineSim();
  const [mode, setMode] = useState<FleetMode>("SIMULATION");
  const fleet = useLiveFleet(mode === "LIVE");

  const [selected, setSelected] = useState<string>("V01");
  const [follow, setFollow] = useState(true);
  const [showTrail, setShowTrail] = useState(true);
  const [imagery, setImagery] = useState(true);
  const [cmd, setCmd] = useState<MapCmd>(null);
  const [info, setInfo] = useState<FeatureInfo | null>(null);
  const mapBox = useRef<HTMLDivElement>(null);

  /* ------------------------------------------------ ESP32 device link */
  const [device, setDevice] = useState<DeviceConfig>(DEFAULT_DEVICE_CONFIG);
  useEffect(() => setDevice(loadDeviceConfig()), []);
  const patchDevice = (patch: Partial<DeviceConfig>) =>
    setDevice((d) => {
      const next = { ...d, ...patch };
      saveDeviceConfig(next);
      return next;
    });
  const link = useDeviceLink(mode === "LIVE", device);
  const [endpointUrl, setEndpointUrl] = useState("/api/public/vehicle/telemetry");
  useEffect(() => setEndpointUrl(`${window.location.origin}/api/public/vehicle/telemetry`), []);
  const [showSketch, setShowSketch] = useState(false);

  /* ------------------------------------------------- demo transmitters */
  const demo = useMemo(() => {
    const path = (roadLines.find((r) => r.roadId === "R02") ?? roadLines[0]!).path as [number, number][];
    return [
      createDemoTransmitter(path, "V01"),
      createDemoTransmitter(path, "V02", { offset: Math.floor(path.length / 2) }),
    ];
  }, []);
  const [demoRunning, setDemoRunning] = useState(false);
  useEffect(() => () => demo.forEach((d) => d.stop()), [demo]);

  const startDemo = () => {
    setMode("LIVE");
    demo.forEach((d) => d.start(500));
    rsuDemo.start(1000);
    setDemoRunning(true);
  };
  const pauseDemo = () => {
    demo.forEach((d) => d.stop());
    rsuDemo.stop();
    setDemoRunning(false);
  };
  const resetDemo = () => {
    demo.forEach((d) => d.reset());
    rsuDemo.stop();
    setDemoRunning(false);
    fleet.clearAll();
  };

  /* ------------------------------------------------------ RSU network */
  const rsuLive = useLiveRsus(mode === "LIVE");
  const mapRsus = useMemo(() => rsusFromMap(maps.active), [maps.active]);
  const rsus = useMemo(
    () => mergeRsus(mapRsus, rsuLive.reports, fleet.vehicles, rsuLive.now),
    [mapRsus, rsuLive.reports, rsuLive.now, fleet.vehicles],
  );
  const rsuMarkers: MapRsuMarker[] = useMemo(
    () =>
      mode === "LIVE"
        ? rsus.map((r) => ({
            rsuId: r.rsuId,
            name: r.name,
            latitude: r.latitude,
            longitude: r.longitude,
            rangeMetres: r.rangeMetres,
            status: r.status,
            detections: r.detections.map((d) => ({ vehicleId: d.vehicleId, distance: d.distance })),
          }))
        : [],
    [mode, rsus],
  );
  const mapRsusRef = useRef(mapRsus);
  const fleetRef = useRef(fleet.vehicles);
  mapRsusRef.current = mapRsus;
  fleetRef.current = fleet.vehicles;
  const rsuDemo = useMemo(() => createRsuDemo(() => mapRsusRef.current, () => fleetRef.current), []);
  useEffect(() => () => rsuDemo.stop(), [rsuDemo]);

  /* --------------------------------------------------- map vehicle set */
  const liveRisk = useMemo(
    () => evaluateLiveRisk(fleet.vehicles, hazardsFromMap(maps.active), (v) => fleet.statusOf(v) === "LOST"),
    [fleet, maps.active],
  );

  const vehicles: MapVehicle[] = useMemo(() => {
    if (mode === "LIVE") {
      return fleet.vehicles.map((v) => ({
        vehicleId: v.vehicleId,
        latitude: v.latitude,
        longitude: v.longitude,
        heading: v.heading,
        speed: v.speed,
        risk: liveRisk.riskById[v.vehicleId] ?? "SAFE",
        accuracy: v.gpsAccuracy,
        trail: v.trail.map((p) => [p.latitude, p.longitude] as [number, number]),
        lost: fleet.statusOf(v) === "LOST",
      }));
    }
    return sim.vehicles.map((v) => ({
      vehicleId: v.vehicleId,
      latitude: ll(v.pos)[0],
      longitude: ll(v.pos)[1],
      heading: v.heading,
      speed: v.speed,
      risk: v.risk,
      accuracy: 0,
      trail: v.trail.map((p) => ll(p)),
    }));
  }, [mode, fleet, liveRisk, sim.vehicles]);

  const liveSel: LiveVehicle | null = fleet.byId[selected] ?? fleet.vehicles[0] ?? null;
  const simSel = sim.vehicles.find((v) => v.vehicleId === selected) ?? sim.vehicles[0] ?? null;
  const selVehicle = vehicles.find((v) => v.vehicleId === selected) ?? vehicles[0] ?? null;

  const warnings =
    mode === "LIVE"
      ? [...liveRisk.warnings, ...rsuWarnings(rsus, fleet.vehicles)]
      : sim.vehicles.flatMap((v) =>
          v.curveWarning
            ? [
                {
                  key: `${v.vehicleId}-${v.curveWarning.curveId}`,
                  vehicleId: v.vehicleId,
                  level: "CAUTION" as const,
                  title: "BLIND CURVE AHEAD",
                  body: `${v.curveWarning.curveId} · Distance: ${Math.round(v.curveWarning.distance)} m · Recommended speed: ${v.curveWarning.recommendedSpeed} km/h`,
                },
              ]
            : [],
        );

  const connLabel = liveSel ? fleet.statusOf(liveSel) : "OFFLINE";
  const rsuOnline = sim.rsuSnapshots.filter((r) => r.online).length;

  const fireCmd = (type: "ZOOM_IN" | "ZOOM_OUT" | "RESET" | "FIT") => setCmd({ type, n: Date.now() });
  const fullscreen = () => {
    const el = mapBox.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const exportJson = () => {
    if (!liveSel) return;
    downloadText(`${liveSel.vehicleId}-telemetry.json`, JSON.stringify(liveSel.trail, null, 2), "application/json");
  };
  const exportCsv = () => {
    if (!liveSel) return;
    downloadText(`${liveSel.vehicleId}-telemetry.csv`, trailToCsv(liveSel), "text/csv");
  };

  return (
    <main className="flex min-h-screen flex-col bg-background p-2 text-foreground">
      {/* ------------------------------------------------------- header */}
      <header className="panel-frame mb-2 flex flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div className="flex items-center gap-4">
          <div>
            <p className="font-display text-xl font-bold leading-none tracking-[0.22em] text-primary">MINEGUARD</p>
            <h1 className="tech-label">Bailadila mine safety system</h1>
          </div>
          <span
            className={`flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-xs ${
              mode === "LIVE" ? "border-risk-safe text-risk-safe" : "border-primary text-primary"
            }`}
          >
            <span className={`pulse-alarm inline-block h-2 w-2 rounded-full ${mode === "LIVE" ? "bg-risk-safe" : "bg-primary"}`} />
            {mode === "LIVE" ? "LIVE VEHICLE MODE" : "SIMULATION MODE"}
          </span>
        </div>
        <nav className="flex flex-wrap gap-2 font-mono text-xs uppercase">
          <Link to="/" className="rounded-sm border border-panel-line px-3 py-1 hover:text-primary">
            Command center
          </Link>
          <Link to="/maps" className="rounded-sm border border-panel-line px-3 py-1 hover:text-primary">
            Maps
          </Link>
        </nav>
      </header>

      <div className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[260px_minmax(0,1fr)_320px]">
        {/* ------------------------------------------------ left: controls */}
        <aside className="panel-frame min-h-0 space-y-3 overflow-auto p-3">
          <div>
            <p className="tech-label mb-1">Data source</p>
            <div className="flex overflow-hidden rounded-sm border border-panel-line font-mono text-[11px]">
              {(["SIMULATION", "LIVE"] as FleetMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 px-2 py-1 uppercase ${mode === m ? "bg-primary text-primary-foreground" : "hover:text-primary"}`}
                >
                  {m === "LIVE" ? "Live vehicle" : "Simulation"}
                </button>
              ))}
            </div>
            <p className="mt-1 font-mono text-[10px] leading-4 text-muted-foreground">
              Live mode shows only real telemetry received from the vehicle. MINEGUARD never generates fake GPS movement —
              if packets stop, the marker stays at its last known position.
            </p>
          </div>

          <div>
            <p className="tech-label mb-1">Vehicle device (ESP32)</p>
            <div className="mb-1 flex overflow-hidden rounded-sm border border-panel-line font-mono text-[11px]">
              {(["HTTP", "WS"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => patchDevice({ transport: t })}
                  className={`flex-1 px-2 py-1 uppercase ${device.transport === t ? "bg-primary text-primary-foreground" : "hover:text-primary"}`}
                >
                  {t === "HTTP" ? "HTTP post" : "WebSocket"}
                </button>
              ))}
            </div>

            {device.transport === "HTTP" ? (
              <>
                <p className="font-mono text-[10px] text-muted-foreground">Device posts to</p>
                <div className="flex items-center gap-1">
                  <code className="flex-1 truncate rounded-sm border border-panel-line px-1 py-0.5 font-mono text-[10px] text-accent">
                    {endpointUrl}
                  </code>
                  <button
                    onClick={() => void navigator.clipboard?.writeText(endpointUrl)}
                    className="rounded-sm border border-panel-line px-1.5 py-0.5 font-mono text-[10px] uppercase hover:text-primary"
                  >
                    Copy
                  </button>
                </div>
                <label className="mt-1 block font-mono text-[10px] uppercase text-muted-foreground">
                  Poll interval (ms)
                  <input
                    type="number"
                    min={200}
                    step={100}
                    value={device.pollMs}
                    onChange={(e) => patchDevice({ pollMs: Number(e.target.value) || 1000 })}
                    className="mt-0.5 w-full rounded-sm border border-panel-line bg-transparent px-1.5 py-0.5 font-mono text-[11px]"
                  />
                </label>
              </>
            ) : (
              <label className="block font-mono text-[10px] uppercase text-muted-foreground">
                Device / gateway WebSocket
                <input
                  value={device.wsUrl}
                  onChange={(e) => patchDevice({ wsUrl: e.target.value })}
                  placeholder="ws://192.168.4.1:81"
                  className="mt-0.5 w-full rounded-sm border border-panel-line bg-transparent px-1.5 py-0.5 font-mono text-[11px]"
                />
              </label>
            )}

            <label className="mt-1 block font-mono text-[10px] uppercase text-muted-foreground">
              Device key (optional)
              <input
                value={device.deviceKey}
                onChange={(e) => patchDevice({ deviceKey: e.target.value })}
                placeholder="matches MINEGUARD_TELEMETRY_KEY"
                className="mt-0.5 w-full rounded-sm border border-panel-line bg-transparent px-1.5 py-0.5 font-mono text-[11px]"
              />
            </label>

            <div className="mt-1.5 rounded-sm border border-panel-line px-2 py-1 font-mono text-[10px]">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Link</span>
                <span
                  className={
                    link.state === "RECEIVING"
                      ? "text-risk-safe"
                      : link.state === "ERROR" || link.state === "NO_DATA"
                        ? "text-risk-high"
                        : "text-muted-foreground"
                  }
                >
                  ● {link.state.replace("_", " ")}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Packets</span>
                <span>
                  {link.packets} · {link.rate.toFixed(1)}/s
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Last packet</span>
                <span>{link.secondsSince === null ? "—" : `${link.secondsSince.toFixed(1)} s ago`}</span>
              </div>
            </div>
            <p className="mt-1 font-mono text-[10px] leading-4 text-muted-foreground">
              Switch to Live vehicle mode to open the link. Nothing is shown until the device transmits.
            </p>
            <button
              onClick={() => setShowSketch((v) => !v)}
              className="mt-1 w-full rounded-sm border border-panel-line px-2 py-1 font-mono text-[10px] uppercase hover:text-primary"
            >
              {showSketch ? "Hide ESP32 sketch" : "Show ESP32 sketch"}
            </button>
            {showSketch && (
              <>
                <pre className="mt-1 max-h-44 overflow-auto rounded-sm border border-panel-line p-2 font-mono text-[9px] leading-3 text-muted-foreground">
                  {esp32Sketch(endpointUrl, device.deviceKey)}
                </pre>
                <button
                  onClick={() => downloadText("mineguard_vehicle_node.ino", esp32Sketch(endpointUrl, device.deviceKey))}
                  className="mt-1 w-full rounded-sm border border-panel-line px-2 py-1 font-mono text-[10px] uppercase hover:text-primary"
                >
                  Download sketch
                </button>
              </>
            )}
          </div>

          <div>
            <p className="tech-label mb-1">Demo vehicle (no hardware)</p>
            <div className="flex gap-1 font-mono text-[11px] uppercase">
              <button onClick={startDemo} className="flex-1 rounded-sm border border-panel-line px-2 py-1 hover:text-primary">
                ▶ Start
              </button>
              <button onClick={pauseDemo} className="flex-1 rounded-sm border border-panel-line px-2 py-1 hover:text-primary">
                ⏸ Pause
              </button>
              <button onClick={resetDemo} className="flex-1 rounded-sm border border-panel-line px-2 py-1 hover:text-primary">
                ↻ Reset
              </button>
            </div>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              {demoRunning ? "Demo telemetry transmitting (labelled DEMO)." : "Publishes demo packets on the same bus the ESP32 will use."}
            </p>
          </div>

          <div>
            <p className="tech-label mb-1">Map view</p>
            <div className="grid grid-cols-2 gap-1 font-mono text-[11px] uppercase">
              <button onClick={() => fireCmd("ZOOM_IN")} className="rounded-sm border border-panel-line px-2 py-1">Zoom in</button>
              <button onClick={() => fireCmd("ZOOM_OUT")} className="rounded-sm border border-panel-line px-2 py-1">Zoom out</button>
              <button onClick={() => fireCmd("RESET")} className="rounded-sm border border-panel-line px-2 py-1">Reset view</button>
              <button onClick={() => fireCmd("FIT")} className="rounded-sm border border-panel-line px-2 py-1">Fit mine</button>
              <button
                onClick={() => setFollow((f) => !f)}
                className={`rounded-sm border px-2 py-1 ${follow ? "border-primary text-primary" : "border-panel-line"}`}
              >
                Follow {follow ? "on" : "off"}
              </button>
              <button onClick={fullscreen} className="rounded-sm border border-panel-line px-2 py-1">Fullscreen</button>
              <button
                onClick={() => setShowTrail((t) => !t)}
                className={`rounded-sm border px-2 py-1 ${showTrail ? "border-primary text-primary" : "border-panel-line"}`}
              >
                {showTrail ? "Hide trail" : "Show trail"}
              </button>
              <button
                onClick={() => setImagery((i) => !i)}
                className={`rounded-sm border px-2 py-1 ${imagery ? "border-primary text-primary" : "border-panel-line"}`}
              >
                Imagery
              </button>
            </div>
          </div>

          <div>
            <p className="tech-label mb-1">Map layers</p>
            {!maps.active && (
              <p className="font-mono text-[11px] text-muted-foreground">
                No active map.{" "}
                <button onClick={() => maps.loadSample()} className="text-primary underline">
                  Load sample Bailadila map
                </button>
              </p>
            )}
            {maps.active?.layers.map((l) => (
              <label key={l.id} className="flex cursor-pointer items-center gap-2 py-[3px] font-mono text-[11px]">
                <input
                  type="checkbox"
                  checked={l.visible}
                  onChange={(e) => maps.setLayerVisible(maps.active!.id, l.id, e.target.checked)}
                  className="accent-[var(--primary)]"
                />
                <span className="truncate text-muted-foreground">{l.name || LAYER_LABEL[l.kind]}</span>
              </label>
            ))}
          </div>

          <div>
            <p className="tech-label mb-1">Trail data</p>
            <div className="grid grid-cols-2 gap-1 font-mono text-[11px] uppercase">
              <button
                onClick={() => liveSel && fleet.clearTrail(liveSel.vehicleId)}
                className="rounded-sm border border-panel-line px-2 py-1"
              >
                Clear trail
              </button>
              <button onClick={exportCsv} className="rounded-sm border border-panel-line px-2 py-1">Export CSV</button>
              <button onClick={exportJson} className="col-span-2 rounded-sm border border-panel-line px-2 py-1">Export JSON</button>
            </div>
          </div>

          <div>
            <p className="tech-label mb-1">Legend</p>
            <div className="space-y-[3px] font-mono text-[11px]">
              {LEGEND.map((l) => (
                <div key={l.label} className="flex items-center gap-2">
                  <span style={{ color: l.color }}>{l.swatch}</span>
                  <span className="text-muted-foreground">{l.label}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* ---------------------------------------------------- centre map */}
        <section ref={mapBox} className="panel-frame relative min-h-[60vh] overflow-hidden bg-[#0b0e12]">
          {mounted && (
            <Suspense fallback={<div className="grid h-full place-items-center font-mono text-xs">LOADING MAP ENGINE…</div>}>
              <MineMapView
                doc={maps.active}
                vehicles={vehicles}
                selectedVehicle={selVehicle?.vehicleId ?? null}
                onSelectVehicle={setSelected}
                onFeatureClick={setInfo}
                follow={follow}
                showTrail={showTrail}
                imagery={imagery}
                rsus={rsuMarkers}
                cmd={cmd}
              />
            </Suspense>
          )}

          <div className="pointer-events-none absolute left-2 top-2 z-[500] rounded-sm border border-panel-line bg-background/85 px-2 py-1 font-mono text-[11px] backdrop-blur-sm">
            {maps.active ? maps.active.name : "No mine map loaded"} · {vehicles.length} vehicle(s)
          </div>

          {/* feature info panel */}
          {info && (
            <div className="absolute right-2 top-2 z-[500] w-64 rounded-sm border border-panel-line bg-background/92 p-3 backdrop-blur-sm">
              <div className="mb-1 flex items-center justify-between">
                <p className="font-display text-xs font-bold uppercase tracking-widest text-primary">{LAYER_LABEL[info.kind]}</p>
                <button onClick={() => setInfo(null)} className="font-mono text-xs text-muted-foreground hover:text-primary">
                  ✕
                </button>
              </div>
              <p className="mb-1 font-mono text-xs">{info.title}</p>
              <div className="max-h-56 overflow-auto border-t border-panel-line pt-1">
                {Object.entries(info.props)
                  .filter(([, v]) => v !== "" && v !== null && v !== undefined)
                  .slice(0, 16)
                  .map(([k, v]) => (
                    <Row key={k} k={k} v={String(v)} />
                  ))}
              </div>
            </div>
          )}

          {/* warning banner */}
          {!!warnings.length && (
            <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-[500] space-y-1">
              {warnings.slice(0, 2).map((w) => {
                const s = RISK_STYLE[w.level];
                return (
                  <div key={w.key} className={`rounded-sm border ${s.border} bg-background/92 px-3 py-2 backdrop-blur-sm`}>
                    <p className={`font-display text-sm font-bold tracking-widest ${s.text}`}>⚠ {w.title}</p>
                    <p className="font-mono text-[11px] text-foreground">{w.body}</p>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* -------------------------------------------- right: vehicle info */}
        <aside className="flex min-h-0 flex-col gap-2">
          <section className="panel-frame p-3">
            <div className="mb-2 flex flex-wrap gap-1 font-mono text-[11px] uppercase">
              {(mode === "LIVE" ? fleet.vehicles.map((v) => v.vehicleId) : sim.vehicles.map((v) => v.vehicleId)).map((id) => (
                <button
                  key={id}
                  onClick={() => setSelected(id)}
                  className={`rounded-sm border px-2 py-0.5 ${
                    id === (selVehicle?.vehicleId ?? "") ? "border-primary text-primary" : "border-panel-line text-muted-foreground"
                  }`}
                >
                  {id}
                </button>
              ))}
              {!vehicles.length && <span className="text-muted-foreground">Awaiting vehicle telemetry…</span>}
            </div>

            {mode === "LIVE" && liveSel && (
              <div className="font-mono text-[11px]">
                <p className={`mb-1 font-display text-sm font-bold tracking-widest ${RISK_STYLE[liveRisk.riskById[liveSel.vehicleId] ?? "SAFE"].text}`}>
                  {liveSel.vehicleId} · {connLabel === "LOST" ? "CONNECTION LOST" : connLabel}
                </p>
                <Row k="Latitude" v={liveSel.latitude.toFixed(7)} />
                <Row k="Longitude" v={liveSel.longitude.toFixed(7)} />
                <Row k="Altitude" v={`${liveSel.altitude.toFixed(1)} m`} />
                <Row k="Speed" v={`${liveSel.speed.toFixed(1)} km/h`} />
                <Row k="Heading" v={`${liveSel.heading.toFixed(0)}°`} />
                <Row k="GPS accuracy" v={accuracyLabel(liveSel.gpsAccuracy)} />
                <Row k="RTK status" v={fixLabel(liveSel.fixType)} />
                <Row k="Satellites" v={String(liveSel.satellites)} />
                <Row k="Encoder dist." v={`${liveSel.encoderDistance.toFixed(1)} m`} />
                <Row k="Distance travelled" v={`${liveSel.distanceTravelled.toFixed(1)} m`} />
                <Row k="Max speed" v={`${liveSel.maxSpeed.toFixed(1)} km/h`} />
                <Row k="Avg speed" v={`${liveSel.avgSpeed.toFixed(1)} km/h`} />
                <Row k="Trail points" v={String(liveSel.trail.length)} />
                <Row k="Source" v={liveSel.source} />
                <Row
                  k="Last update"
                  v={`${fleet.secondsSince(liveSel).toFixed(1)} s ago`}
                  accent={fleet.statusOf(liveSel) === "LOST" ? "text-risk-high" : "text-risk-safe"}
                />
                {liveSel.imu && (
                  <Row k="IMU" v={`a ${liveSel.imu.ax.toFixed(2)}/${liveSel.imu.ay.toFixed(2)}/${liveSel.imu.az.toFixed(2)}`} />
                )}
              </div>
            )}

            {mode === "SIMULATION" && simSel && (
              <div className="font-mono text-[11px]">
                <p className={`mb-1 font-display text-sm font-bold tracking-widest ${RISK_STYLE[simSel.risk].text}`}>
                  {simSel.vehicleId} · SIMULATED
                </p>
                <Row k="Latitude" v={ll(simSel.pos)[0].toFixed(7)} />
                <Row k="Longitude" v={ll(simSel.pos)[1].toFixed(7)} />
                <Row k="Speed" v={`${simSel.speed.toFixed(1)} km/h`} />
                <Row k="Heading" v={`${simSel.heading.toFixed(0)}° ${simSel.headingText}`} />
                <Row k="Elevation" v={`RL ${simSel.elevation}`} />
                <Row k="Road" v={simSel.roadName} />
                <Row k="Risk" v={RISK_STYLE[simSel.risk].label} />
              </div>
            )}
          </section>

          <section className="panel-frame flex min-h-0 flex-1 flex-col">
            <header className="flex items-center justify-between border-b border-panel-line px-3 py-2">
              <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em]">Risk &amp; warnings</h2>
              <span className="font-mono text-xs text-risk-medium">{String(warnings.length).padStart(2, "0")}</span>
            </header>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
              {!warnings.length && <p className="tech-label">No active warnings.</p>}
              {warnings.slice(0, 12).map((w) => {
                const s = RISK_STYLE[w.level];
                return (
                  <div key={w.key} className={`rounded-sm border ${s.border} ${s.bg} px-2 py-1.5`}>
                    <p className={`font-mono text-[11px] ${s.text}`}>
                      {s.dot} {w.title}
                    </p>
                    <p className="font-mono text-[11px]">{w.body}</p>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel-frame flex max-h-72 min-h-0 flex-col">
            <header className="flex items-center justify-between border-b border-panel-line px-3 py-2">
              <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em]">RSU network</h2>
              <span className="font-mono text-xs text-accent">
                {rsus.filter((r) => r.status === "ONLINE").length}/{rsus.length} online
              </span>
            </header>
            <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px]">
              {!rsus.length && <p className="tech-label">No RSUs on the active map.</p>}
              {rsus.map((r) => (
                <div key={r.rsuId} className="mb-1.5 rounded-sm border border-panel-line px-2 py-1">
                  <div className="flex items-center justify-between">
                    <span>{r.name}</span>
                    <span
                      className={
                        r.status === "ONLINE" ? "text-risk-safe" : r.status === "OFFLINE" ? "text-risk-high" : "text-muted-foreground"
                      }
                    >
                      ● {r.status === "NO_SIGNAL" ? "NO TELEMETRY" : r.status}
                    </span>
                  </div>
                  <Row k="RSU ID" v={r.rsuId} />
                  <Row k="Range" v={`${Math.round(r.rangeMetres)} m`} />
                  <Row k="Vehicles detected" v={String(r.detections.length)} />
                  <Row
                    k="Last communication"
                    v={r.secondsSince === null ? "never" : `${r.secondsSince.toFixed(1)} s ago`}
                  />
                  {r.detections.map((d) => (
                    <Row
                      key={d.vehicleId}
                      k={`↳ ${d.vehicleId}`}
                      v={`${Math.round(d.distance)} m${d.rssi !== null ? ` · ${d.rssi} dBm` : ""} · ${d.origin === "REPORTED" ? "RSU" : "GNSS"}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className="panel-frame p-3 font-mono text-[10px] leading-4 text-muted-foreground">
            <p className="tech-label mb-1">Hardware hand-off</p>
            <p>
              Vehicle nodes post to <span className="text-accent">POST /api/public/vehicle/telemetry</span>; roadside
              units post to <span className="text-accent">POST /api/public/rsu/telemetry</span> (JSON, single report or
              array). WebSocket / MQTT transports publish onto the same buses.
            </p>
          </section>
        </aside>
      </div>

      {/* ---------------------------------------------------- bottom bar */}
      <footer className="panel-frame mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-1.5 font-mono text-[11px]">
        <span className="text-muted-foreground">
          GPS <span className={liveSel && connLabel !== "LOST" ? "text-risk-safe" : "text-muted-foreground"}>● {mode === "LIVE" ? (liveSel && connLabel !== "LOST" ? "CONNECTED" : "NO DATA") : "SIMULATED"}</span>
        </span>
        <span className="text-muted-foreground">
          RTK <span className="text-risk-safe">● {liveSel ? fixLabel(liveSel.fixType) : "—"}</span>
        </span>
        <span className="text-muted-foreground">
          IMU <span className={liveSel?.imu ? "text-risk-safe" : "text-muted-foreground"}>● {liveSel?.imu ? "ONLINE" : "—"}</span>
        </span>
        <span className="text-muted-foreground">
          V2V <span className="text-risk-safe">● {liveRisk.pairs.length || sim.links.length} LINKS</span>
        </span>
        <span className="text-muted-foreground">
          RSU{" "}
          <span className={mode === "LIVE" && !rsus.some((r) => r.status === "ONLINE") ? "text-muted-foreground" : "text-risk-safe"}>
            ● {mode === "LIVE"
              ? `${rsus.filter((r) => r.status === "ONLINE").length}/${rsus.length} ONLINE`
              : `${rsuOnline}/${sim.rsuSnapshots.length} ONLINE`}
          </span>
        </span>
        <span className="text-muted-foreground">
          NETWORK <span className="text-risk-safe">● ONLINE</span>
        </span>
        <span className="ml-auto text-muted-foreground">
          Simulation / prototype · positioning accuracy shown exactly as reported by the connected hardware
        </span>
      </footer>
    </main>
  );
}
