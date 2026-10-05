import type { ReactNode } from "react";
import { blindCurves, checkpoints, riskZones, roads, type RiskLevel, type RiskZone } from "@/lib/mine/data";
import type { RsuSnapshot, V2VLink, VehicleSnapshot } from "@/lib/mine/useMineSim";

export const RISK_STYLE: Record<RiskLevel, { text: string; border: string; bg: string; dot: string; label: string }> = {
  HIGH: { text: "text-risk-high", border: "border-risk-high", bg: "bg-risk-high/12", dot: "🔴", label: "HIGH" },
  MEDIUM: { text: "text-risk-medium", border: "border-risk-medium", bg: "bg-risk-medium/12", dot: "🟠", label: "MEDIUM" },
  CAUTION: { text: "text-risk-caution", border: "border-risk-caution", bg: "bg-risk-caution/12", dot: "🟡", label: "CAUTION" },
  SAFE: { text: "text-risk-safe", border: "border-risk-safe", bg: "bg-risk-safe/10", dot: "🟢", label: "SAFE" },
};

export function Panel({ title, right, children, className = "" }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel-frame flex min-h-0 flex-col ${className}`}>
      <header className="flex items-center justify-between border-b border-panel-line px-3 py-2">
        <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em] text-foreground">{title}</h2>
        {right}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </section>
  );
}

export function Row({ k, v, accent }: { k: string; v: ReactNode; accent?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 whitespace-nowrap py-[3px]">
      <span className="tech-label">{k}</span>
      <span className={`font-mono text-xs ${accent ?? "text-foreground"}`}>{v}</span>
    </div>
  );
}

/* ------------------------------------------------------------ driver warning */

export function DriverWarning({ critical, vehicles }: { critical: VehicleSnapshot | null; vehicles: VehicleSnapshot[] }) {
  const curveVehicle = vehicles.find((v) => v.curveWarning);
  const collisionVehicle = vehicles.find((v) => v.collision && v.collision.risk !== "SAFE");
  const worst = critical ?? collisionVehicle ?? curveVehicle ?? null;

  if (!worst) {
    return (
      <div className="panel-frame border-risk-safe/60 bg-risk-safe/8 px-4 py-3">
        <p className="font-display text-2xl font-bold tracking-wide text-risk-safe">🟢 ALL VEHICLES SAFE</p>
        <p className="tech-label mt-1">Fognet risk engine · no active proximity or curve hazard</p>
      </div>
    );
  }

  const c = worst.collision;
  const cw = worst.curveWarning;
  const level: RiskLevel = worst.risk;
  const s = RISK_STYLE[level];
  const cs = c ? RISK_STYLE[c.risk] : s;

  return (
    <div className={`panel-frame ${s.bg} ${s.border} px-4 py-3 ${level === "HIGH" ? "pulse-alarm" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {c && (
          <div>
            <p className={`font-display text-2xl font-bold tracking-wide ${cs.text}`}>
              {cs.dot} {cs.label} COLLISION RISK
            </p>
            <p className="mt-1 font-mono text-sm text-foreground">
              {worst.vehicleId} → VEHICLE {c.a === worst.vehicleId ? c.b : c.a} · Distance: {Math.round(c.distance)} m ·{" "}
              {c.approach} · closing {Math.max(0, c.relativeSpeed).toFixed(1)} km/h
            </p>
          </div>
        )}
        {cw && (
          <div className="border-l border-panel-line pl-6">
            <p className="font-display text-xl font-bold tracking-wide text-risk-caution">⚠ BLIND CURVE AHEAD</p>
            <p className="mt-1 font-mono text-sm text-foreground">
              {cw.curveId} {cw.curveName} · Distance: {Math.round(cw.distance)} m · Recommended Speed:{" "}
              {cw.recommendedSpeed} km/h
            </p>
          </div>
        )}
      </div>
      <p className="tech-label mt-2">Driver warning issued · audible + HUD alert · offline mesh delivery</p>
    </div>
  );
}

/* ------------------------------------------------------------ vehicle cards */

export function VehicleCard({
  v,
  selected,
  onSelect,
}: {
  v: VehicleSnapshot;
  selected: boolean;
  onSelect: () => void;
}) {
  const s = RISK_STYLE[v.risk];
  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-sm border ${selected ? "border-primary" : "border-panel-line"} ${s.bg} px-3 py-2 text-left transition-colors hover:border-primary/70`}
    >
      <div className="flex items-center justify-between">
        <span className="font-display text-base font-bold tracking-wide">🚛 {v.vehicleId}</span>
        <span className={`font-mono text-xs ${s.text}`}>
          {s.dot} {s.label}
        </span>
      </div>
      <p className="tech-label">{v.label} · {v.payload}</p>
      <div className="mt-1 grid grid-cols-2 gap-x-4">
        <Row k="Speed" v={`${v.speed.toFixed(1)} km/h`} />
        <Row k="Heading" v={`${v.heading.toFixed(0)}° ${v.headingText}`} />
        <Row k="Lat" v={v.gps.lat.toFixed(6)} />
        <Row k="Lon" v={v.gps.lon.toFixed(6)} />
        <Row k="Elev" v={`RL ${v.elevation}`} />
        <Row k="Road" v={`${v.roadId} (${v.speedLimit})`} />
        <Row k="V2V" v={v.v2v ? `LINKED ×${v.peers}` : "LOST"} accent={v.v2v ? "text-risk-safe" : "text-risk-high"} />
        <Row k="Fix" v="3D · 11 SV" />
      </div>
      {v.areaStatus && <p className="mt-1 font-mono text-[11px] text-accent">▸ {v.areaStatus}</p>}
      {v.zone && <p className="font-mono text-[11px] text-risk-medium">▸ IN {v.zone}</p>}
      {v.curveWarning && (
        <p className="mt-1 font-mono text-[11px] text-risk-caution">
          ⚠ {v.curveWarning.curveId} in {Math.round(v.curveWarning.distance)} m · rec {v.curveWarning.recommendedSpeed} km/h
        </p>
      )}
      {v.collision && v.collision.risk !== "SAFE" && (
        <p className={`font-mono text-[11px] ${RISK_STYLE[v.collision.risk].text}`}>
          {RISK_STYLE[v.collision.risk].dot} {v.collision.a === v.vehicleId ? v.collision.b : v.collision.a} @{" "}
          {Math.round(v.collision.distance)} m · {v.collision.approach}
        </p>
      )}
    </button>
  );
}

/* ------------------------------------------------------------ sensor fusion */

export function SensorFusion({ rsuOnline }: { rsuOnline: number }) {
  const sensors = [
    { k: "GPS", v: "ACTIVE" },
    { k: "IMU", v: "ACTIVE" },
    { k: "mmWave RADAR", v: "ACTIVE" },
    { k: "V2V", v: "ACTIVE" },
    { k: "RSU", v: `ONLINE ${rsuOnline}/5` },
    { k: "OFFLINE MODE", v: "ACTIVE" },
  ];
  return (
    <div>
      <div className="rounded-sm border border-panel-line bg-background/50 p-3 text-center font-mono text-[11px] leading-6">
        <p className="text-accent">GPS + IMU + mmWave RADAR + V2V</p>
        <p className="text-muted-foreground">↓</p>
        <p className="text-primary">SENSOR FUSION</p>
        <p className="text-muted-foreground">↓</p>
        <p className="text-risk-medium">RISK ENGINE</p>
        <p className="text-muted-foreground">↓</p>
        <p className="text-risk-high">DRIVER WARNING</p>
      </div>
      <div className="mt-3 space-y-1">
        {sensors.map((s) => (
          <div key={s.k} className="flex items-center justify-between">
            <span className="tech-label">{s.k}</span>
            <span className="font-mono text-xs text-risk-safe">● {s.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- V2V panel */

export function V2VPanel({ links }: { links: V2VLink[] }) {
  if (!links.length) return <p className="tech-label">No peers within 600 m broadcast range.</p>;
  return (
    <div className="space-y-2">
      {links
        .slice()
        .sort((a, b) => a.distance - b.distance)
        .map((l) => {
          const s = RISK_STYLE[l.risk];
          return (
            <div key={`${l.a}-${l.b}`} className={`rounded-sm border ${s.border} ${s.bg} px-2 py-1.5`}>
              <div className="flex items-center justify-between font-mono text-xs">
                <span>
                  {l.a} ⇄ {l.b}
                </span>
                <span className={s.text}>
                  {s.dot} {s.label}
                </span>
              </div>
              <div className="tech-label mt-0.5">
                {Math.round(l.distance)} m · {l.approach} · Δv {l.relativeSpeed.toFixed(1)} km/h
              </div>
            </div>
          );
        })}
    </div>
  );
}

/* -------------------------------------------------------------- RSU / CP */

export function RsuPanel({ rsuSnapshots }: { rsuSnapshots: RsuSnapshot[] }) {
  return (
    <div className="space-y-2">
      {rsuSnapshots.map((r) => (
        <div key={r.rsuId} className="rounded-sm border border-panel-line px-2 py-1.5">
          <div className="flex items-center justify-between font-mono text-xs">
            <span>📡 {r.rsuId}</span>
            <span className={r.online ? "text-risk-safe" : "text-risk-high"}>● {r.online ? "ONLINE" : "OFFLINE"}</span>
          </div>
          <div className="tech-label mt-0.5">{r.name}</div>
          <div className="mt-0.5 flex justify-between font-mono text-[11px] text-muted-foreground">
            <span>Detected: {r.detected.length ? r.detected.join(", ") : "—"}</span>
            <span>{new Date(r.lastComm).toLocaleTimeString("en-GB")}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function CheckpointPanel() {
  return (
    <div className="space-y-1">
      {checkpoints.map((c) => (
        <div key={c.cpId} className="flex items-center justify-between font-mono text-xs">
          <span className="text-primary">{c.cpId}</span>
          <span className="text-muted-foreground">{c.name}</span>
          <span className="text-risk-safe">CLEAR</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ zones / roads */

export function ZonePanel({ selected, onSelect }: { selected: RiskZone | null; onSelect: (z: RiskZone | null) => void }) {
  return (
    <div className="space-y-2">
      {riskZones.map((z) => {
        const s = RISK_STYLE[z.riskLevel];
        const on = selected?.zoneId === z.zoneId;
        return (
          <button
            key={z.zoneId}
            onClick={() => onSelect(on ? null : z)}
            className={`w-full rounded-sm border px-2 py-1.5 text-left ${on ? "border-primary" : "border-panel-line"} ${s.bg}`}
          >
            <div className="flex items-center justify-between font-mono text-xs">
              <span>
                {z.zoneId} · {z.zoneType}
              </span>
              <span className={s.text}>
                {s.dot} {s.label}
              </span>
            </div>
            {on && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{z.description}</p>}
          </button>
        );
      })}
    </div>
  );
}

export function RoadPanel() {
  return (
    <table className="w-full font-mono text-[11px]">
      <thead>
        <tr className="tech-label text-left">
          <th className="py-1">ID</th>
          <th>Name</th>
          <th>km/h</th>
          <th>Width</th>
          <th>RL</th>
          <th>Risk</th>
        </tr>
      </thead>
      <tbody>
        {roads.map((r) => (
          <tr key={r.roadId} className="border-t border-panel-line">
            <td className="py-1 text-primary">{r.roadId}</td>
            <td className="text-muted-foreground">{r.roadName}</td>
            <td>{r.speedLimit}</td>
            <td>{r.roadWidth} m</td>
            <td>{r.elevation}</td>
            <td className={RISK_STYLE[r.riskLevel].text}>{r.riskLevel}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CurvePanel({ vehicles }: { vehicles: VehicleSnapshot[] }) {
  return (
    <div className="space-y-1">
      {blindCurves.map((c) => {
        const approaching = vehicles.find((v) => v.curveWarning?.curveId === c.curveId);
        const s = RISK_STYLE[approaching ? "CAUTION" : c.riskLevel];
        return (
          <div
            key={c.curveId}
            className={`rounded-sm border px-2 py-1.5 ${approaching ? "border-risk-caution bg-risk-caution/12" : "border-panel-line"}`}
          >
            <div className="flex items-center justify-between font-mono text-xs">
              <span>
                ⚠ {c.curveId} · {c.curveName}
              </span>
              <span className={s.text}>{c.riskLevel}</span>
            </div>
            <div className="tech-label mt-0.5">
              {c.roadId} · rec {c.recommendedSpeed} km/h · warn {c.warningDistance} m
            </div>
            {approaching && (
              <p className="font-mono text-[11px] text-risk-caution">
                {approaching.vehicleId} approaching — {Math.round(approaching.curveWarning!.distance)} m
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ legend */

const LEGEND: [string, string][] = [
  ["━━", "Haul Road"],
  ["⚠", "Blind Curve"],
  ["▲", "Steep Slope"],
  ["🔴", "High Risk"],
  ["🟠", "Medium Risk"],
  ["🟡", "Caution"],
  ["🟢", "Safe"],
  ["🚛", "Mining Vehicle"],
  ["📡", "RSU"],
  ["⛏", "Loading Area"],
  ["⬇", "Dump Area"],
  ["🚧", "Restricted Zone"],
];

export function Legend() {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
      {LEGEND.map(([sym, label]) => (
        <div key={label} className="flex items-center gap-2 font-mono text-[11px]">
          <span className="w-5 text-center">{sym}</span>
          <span className="text-muted-foreground">{label}</span>
        </div>
      ))}
    </div>
  );
}

export function EventLog({ log }: { log: { t: number; text: string; level: RiskLevel }[] }) {
  if (!log.length) return <p className="tech-label">Awaiting risk events…</p>;
  return (
    <div className="space-y-1">
      {log.map((e, i) => (
        <div key={`${e.t}-${i}`} className="font-mono text-[11px]">
          <span className="text-muted-foreground">{new Date(e.t).toLocaleTimeString("en-GB")} </span>
          <span className={RISK_STYLE[e.level].text}>{e.text}</span>
        </div>
      ))}
    </div>
  );
}
