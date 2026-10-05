/**
 * MINEGUARD Mine Command Center — 3D digital twin of the whole simulated mine.
 *
 * Operator-facing counterpart of the driver perception view: it renders the
 * complete (fictional, Bailadila-inspired) open-cast pit, the entire haul
 * fleet, safety states, V2V risk links, RSU coverage, danger zones and the
 * live visibility / fog heat map. It consumes exactly the same simulation
 * snapshots the Driver Map uses, so both views always agree.
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { riskZones, rsus, siteAreas } from "@/lib/mine/data";
import type { Pt } from "@/lib/mine/geo";
import type { V2VLink, VehicleSnapshot } from "@/lib/mine/useMineSim";
import HaulTruck from "./HaulTruck";
import MineWorld from "./MineWorld";
import { headingToYaw, worldPos } from "./world";

export type ViewMode = "3D" | "TOP";

export type Layers = {
  vehicles: boolean;
  roads: boolean;
  benches: boolean;
  zones: boolean;
  fog: boolean;
  rsus: boolean;
  loading: boolean;
  dump: boolean;
};

export type CameraCmd = { type: "RESET" | "ZOOM_IN" | "ZOOM_OUT"; n: number } | null;

const RISK_COLOR: Record<string, string> = {
  HIGH: "#ef3f3f",
  MEDIUM: "#f08a2c",
  CAUTION: "#e7c22b",
  SAFE: "#3ec98a",
};

type Props = {
  vehicles: VehicleSnapshot[];
  links: V2VLink[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  fog: boolean;
  follow: boolean;
  view: ViewMode;
  layers: Layers;
  cmd: CameraCmd;
};

/* ------------------------------------------------------------------ camera */

function OrbitRig({
  focus,
  focusing,
  view,
  cmd,
  wrap,
}: {
  focus: Pt | null;
  focusing: string;
  view: ViewMode;
  cmd: CameraCmd;
  wrap: React.RefObject<HTMLDivElement | null>;
}) {
  const { camera } = useThree();
  const yaw = useRef(0.6);
  const pitch = useRef(0.62);
  const dist = useRef(950);
  const target = useRef(new THREE.Vector3(0, 0, 0));
  const wanted = useRef(new THREE.Vector3(0, 0, 0));

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      dist.current = Math.max(90, Math.min(3200, dist.current * Math.exp(dy * 0.0012)));
    };
    let dragging = false;
    let lx = 0;
    let ly = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      yaw.current += (e.clientX - lx) * 0.005;
      pitch.current = Math.max(0.12, Math.min(1.45, pitch.current + (e.clientY - ly) * 0.004));
      lx = e.clientX;
      ly = e.clientY;
    };
    const up = () => (dragging = false);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [wrap]);

  useEffect(() => {
    pitch.current = view === "TOP" ? 1.42 : 0.6;
    if (view === "TOP") yaw.current = 0;
  }, [view]);

  useEffect(() => {
    if (!cmd) return;
    if (cmd.type === "RESET") {
      yaw.current = 0.6;
      pitch.current = 0.62;
      dist.current = 950;
    } else if (cmd.type === "ZOOM_IN") dist.current = Math.max(90, dist.current * 0.7);
    else dist.current = Math.min(3200, dist.current / 0.7);
  }, [cmd]);

  useEffect(() => {
    if (focusing) dist.current = Math.min(dist.current, 320);
  }, [focusing]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = focus ? new THREE.Vector3(...worldPos(focus, 6)) : new THREE.Vector3(0, 40, 0);
    wanted.current.copy(t);
    target.current.lerp(wanted.current, 1 - Math.exp(-3.2 * dt));

    const d = dist.current;
    const cp = Math.cos(pitch.current);
    const pos = new THREE.Vector3(
      target.current.x + Math.sin(yaw.current) * cp * d,
      target.current.y + Math.sin(pitch.current) * d,
      target.current.z + Math.cos(yaw.current) * cp * d,
    );
    camera.position.lerp(pos, 1 - Math.exp(-4 * dt));
    camera.lookAt(target.current);
  });
  return null;
}

/* ----------------------------------------------------------------- trucks */

function FleetTruck({
  v,
  selected,
  onSelect,
  nearest,
}: {
  v: VehicleSnapshot;
  selected: boolean;
  onSelect: () => void;
  nearest: { id: string; distance: number } | null;
}) {
  const g = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const targetPos = useMemo(() => new THREE.Vector3(...worldPos(v.pos, 0)), [v.pos[0], v.pos[1]]);
  const targetYaw = headingToYaw(v.heading);
  const color = RISK_COLOR[v.risk] ?? RISK_COLOR["SAFE"]!;

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    if (g.current) {
      g.current.position.lerp(targetPos, 1 - Math.exp(-7 * dt));
      const cur = g.current.rotation.y;
      const diff = ((targetYaw - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      g.current.rotation.y = cur + diff * (1 - Math.exp(-6 * dt));
    }
    if (ring.current && v.risk !== "SAFE") {
      ring.current.scale.setScalar(1 + Math.sin(state.clock.elapsedTime * 3.4) * 0.06);
    }
  });

  return (
    <group ref={g} position={worldPos(v.pos, 0)} rotation={[0, targetYaw, 0]} onClick={(e) => (e.stopPropagation(), onSelect())}>
      <HaulTruck
        color={selected ? "#ffd25e" : "#d08a22"}
        bodyColor={selected ? "#d6a020" : "#a86a18"}
        beacon={v.risk === "HIGH"}
        
      />
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.6, 0]}>
        <ringGeometry args={[selected ? 15 : 11, selected ? 17.5 : 12.6, 48]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.75 : 0.5} side={THREE.DoubleSide} />
      </mesh>
      <Html position={[0, 13, 0]} center distanceFactor={240} zIndexRange={[40, 0]}>
        <button
          onClick={(e) => (e.stopPropagation(), onSelect())}
          className={`whitespace-nowrap rounded-sm border px-2 py-1 text-left font-mono text-[13px] leading-tight tracking-widest backdrop-blur-sm ${
            selected ? "border-primary bg-background/90 text-primary" : "border-panel-line bg-background/80 text-foreground"
          }`}
          style={{ borderLeftWidth: 4, borderLeftColor: color }}
        >
          <span className="block font-semibold">TRUCK {v.vehicleId.slice(1)}</span>
          <span className="block text-muted-foreground">
            {v.speed.toFixed(0)} km/h{nearest ? ` · ${Math.round(nearest.distance)} m` : ""}
          </span>
        </button>
      </Html>
    </group>
  );
}

function RiskLink({ a, b, color, dashed }: { a: Pt; b: Pt; color: string; dashed?: boolean }) {
  const pts = useMemo(() => {
    const [ax, ay, az] = worldPos(a, 10);
    const [bx, by, bz] = worldPos(b, 10);
    return new Float32Array([ax, ay, az, bx, by, bz]);
  }, [a[0], a[1], b[0], b[1]]);
  return (
    <line>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[pts, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={dashed ? 0.35 : 0.85} linewidth={2} />
    </line>
  );
}

/* ------------------------------------------------------- visibility layer */

/** Simulated visibility cells over the pit (fictional, demo data). */
const VIS_CELLS: { id: string; pos: Pt; r: number; base: number }[] = [
  { id: "Bench 1", pos: [520, 220], r: 150, base: 0.15 },
  { id: "Bench 2", pos: [280, 430], r: 160, base: 0.35 },
  { id: "Bench 3", pos: [700, 460], r: 170, base: 0.75 },
  { id: "Pit floor", pos: [500, 370], r: 130, base: 0.55 },
  { id: "Dump area", pos: [820, 250], r: 150, base: 0.25 },
];

export function visibilityCells(fog: boolean) {
  return VIS_CELLS.map((c) => {
    const v = Math.min(1, c.base + (fog ? 0.35 : 0));
    return { ...c, level: v > 0.66 ? "CRITICAL" : v > 0.33 ? "REDUCED" : "GOOD", value: v };
  });
}

function VisibilityLayer({ fog }: { fog: boolean }) {
  const cells = visibilityCells(fog);
  return (
    <group>
      {cells.map((c) => (
        <mesh key={c.id} position={worldPos(c.pos, 26)} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[c.r * 2, 48]} />
          <meshBasicMaterial
            color={c.level === "CRITICAL" ? "#ef3f3f" : c.level === "REDUCED" ? "#e7c22b" : "#3ec98a"}
            transparent
            opacity={0.1}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

/* -------------------------------------------------------------------- root */

export default function CommandView({
  vehicles,
  links,
  selectedId,
  onSelect,
  fog,
  follow,
  view,
  layers,
  cmd,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const selected = vehicles.find((v) => v.vehicleId === selectedId) ?? null;
  const focus = follow && selected ? selected.pos : null;

  const nearestOf = (id: string) => {
    const mine = links.filter((l) => l.a === id || l.b === id).sort((x, y) => x.distance - y.distance)[0];
    return mine ? { id: mine.a === id ? mine.b : mine.a, distance: mine.distance } : null;
  };

  return (
    <div ref={wrap} className="h-full w-full cursor-grab touch-none active:cursor-grabbing">
      <Canvas
        shadows
        dpr={[1, 1.7]}
        camera={{ fov: 48, near: 1, far: 12000, position: [900, 900, 900] }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={[fog ? "#9a9184" : "#131b24"]} />
        <fogExp2 attach="fog" args={[fog ? "#9a9184" : "#1a2430", fog ? 0.0014 : 0.00035]} />
        <hemisphereLight args={[fog ? "#ded6c6" : "#adc5e0", "#5d4832", fog ? 2.1 : 1.5]} />
        <ambientLight intensity={fog ? 0.6 : 0.45} />
        <directionalLight
          position={[900, 1300, 620]}
          intensity={fog ? 1.0 : 2.6}
          color={fog ? "#d8d0c2" : "#ffe6c2"}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-camera-left={-1400}
          shadow-camera-right={1400}
          shadow-camera-top={1400}
          shadow-camera-bottom={-1400}
          shadow-camera-far={4200}
        />

        <MineWorld
          showRoads={layers.roads}
          showBenches={layers.benches}
          showLoading={layers.loading}
          showDump={layers.dump}
        />

        {layers.zones &&
          riskZones.map((z) => (
            <mesh key={z.zoneId} position={worldPos(z.center, 8)} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[z.rx * 1.9, z.rx * 2, 56]} />
              <meshBasicMaterial
                color={RISK_COLOR[z.riskLevel] ?? "#e7c22b"}
                transparent
                opacity={0.28}
                side={THREE.DoubleSide}
              />
            </mesh>
          ))}

        {layers.rsus &&
          rsus.map((r) => (
            <group key={r.rsuId} position={worldPos(r.pos, 0)}>
              <mesh position={[0, 9, 0]} castShadow>
                <cylinderGeometry args={[0.6, 1.1, 18, 8]} />
                <meshStandardMaterial color="#8d99a6" metalness={0.7} roughness={0.4} />
              </mesh>
              <mesh position={[0, 19, 0]}>
                <sphereGeometry args={[1.6, 12, 12]} />
                <meshStandardMaterial color="#4ec3ff" emissive="#0d6ea6" emissiveIntensity={2.4} />
              </mesh>
              <mesh position={[0, 0.6, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[r.range * 1.9, r.range * 2, 64]} />
                <meshBasicMaterial color="#4ec3ff" transparent opacity={0.18} side={THREE.DoubleSide} />
              </mesh>
            </group>
          ))}

        {layers.fog && <VisibilityLayer fog={fog} />}

        {layers.vehicles &&
          vehicles.map((v) => (
            <FleetTruck
              key={v.vehicleId}
              v={v}
              selected={v.vehicleId === selectedId}
              onSelect={() => onSelect(v.vehicleId)}
              nearest={nearestOf(v.vehicleId)}
            />
          ))}

        {layers.vehicles &&
          links
            .filter((l) => l.risk !== "SAFE")
            .map((l) => {
              const a = vehicles.find((v) => v.vehicleId === l.a);
              const b = vehicles.find((v) => v.vehicleId === l.b);
              if (!a || !b) return null;
              return (
                <RiskLink
                  key={`${l.a}-${l.b}`}
                  a={a.pos}
                  b={b.pos}
                  color={RISK_COLOR[l.risk] ?? "#e7c22b"}
                  dashed={l.risk === "CAUTION"}
                />
              );
            })}

        <OrbitRig focus={focus} focusing={follow ? (selectedId ?? "") : ""} view={view} cmd={cmd} wrap={wrap} />
      </Canvas>
    </div>
  );
}

export const SITE_AREA_COUNT = siteAreas.length;
