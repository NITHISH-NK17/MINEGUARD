/**
 * MINEGUARD 3D perception view — the driver's primary display.
 *
 * A perspective, vehicle-centric visualisation of the simulated open-cast
 * mine: the driver's own haul truck, surrounding traffic resolved from
 * GPS + V2V + mmWave radar, the haul road ahead and the live safety envelope.
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { VehicleSnapshot } from "@/lib/mine/useMineSim";
import { RADAR_RANGE } from "@/lib/mine/useMineSim";
import type { Pt } from "@/lib/mine/geo";
import HaulTruck from "./HaulTruck";
import MineWorld from "./MineWorld";
import { headingToYaw, worldPos, wx, wz } from "./world";

export type CameraMode = "FOLLOW" | "DRIVER" | "TOP";

const RISK_COLOR: Record<string, string> = {
  HIGH: "#ef3f3f",
  MEDIUM: "#f08a2c",
  CAUTION: "#e7c22b",
  SAFE: "#3ec98a",
};

type Props = {
  me: VehicleSnapshot;
  others: VehicleSnapshot[];
  cameraMode: CameraMode;
  fog: boolean;
  safety: "SAFE" | "CAUTION" | "HIGH";
};

/* --------------------------------------------------------------- camera */

function CameraRig({
  target,
  heading,
  mode,
  orbit,
  dist,
}: {
  target: [number, number, number];
  heading: number;
  mode: CameraMode;
  orbit: React.RefObject<number>;
  dist: React.RefObject<number>;
}) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3(...target));
  const desired = useRef(new THREE.Vector3());

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const yaw = headingToYaw(heading) + (orbit.current ?? 0);
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)); // behind the truck
    const t = new THREE.Vector3(...target);
    const d = dist.current ?? 46;

    if (mode === "TOP") {
      desired.current.set(t.x, t.y + d * 2.1, t.z + 0.001);
      look.current.lerp(t, 1 - Math.exp(-6 * dt));
    } else if (mode === "DRIVER") {
      const ahead = fwd.clone().multiplyScalar(-1);
      desired.current.copy(t).add(ahead.clone().multiplyScalar(3)).add(new THREE.Vector3(-2, 7.4, 0));
      look.current.lerp(t.clone().add(ahead.clone().multiplyScalar(70)).setY(t.y + 4), 1 - Math.exp(-5 * dt));
    } else {
      desired.current
        .copy(t)
        .add(fwd.clone().multiplyScalar(d))
        .add(new THREE.Vector3(0, d * 0.52, 0));
      const ahead = fwd.clone().multiplyScalar(-1);
      look.current.lerp(t.clone().add(ahead.multiplyScalar(d * 0.35)).setY(t.y + 5), 1 - Math.exp(-5 * dt));
    }

    camera.position.lerp(desired.current, 1 - Math.exp(-(mode === "DRIVER" ? 9 : 4.5) * dt));
    camera.lookAt(look.current);
  });
  return null;
}

/* -------------------------------------------------------------- vehicle */

function Truck({
  v,
  self,
  distance,
  ringColor,
  fog,
}: {
  v: VehicleSnapshot;
  self?: boolean | undefined;
  distance?: number | undefined;
  ringColor?: string | undefined;
  fog: boolean;
}) {
  const g = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const targetPos = useMemo(() => new THREE.Vector3(...worldPos(v.pos, 0)), [v.pos[0], v.pos[1]]);
  const targetYaw = headingToYaw(v.heading);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    if (g.current) {
      g.current.position.lerp(targetPos, 1 - Math.exp(-8 * dt));
      const cur = g.current.rotation.y;
      let diff = ((targetYaw - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      g.current.rotation.y = cur + diff * (1 - Math.exp(-7 * dt));
    }
    if (ring.current) {
      const p = 0.9 + Math.sin(state.clock.elapsedTime * 3) * 0.08;
      ring.current.scale.setScalar(p);
    }
  });

  return (
    <group ref={g} position={worldPos(v.pos, 0)} rotation={[0, targetYaw, 0]}>
      <HaulTruck
        color={self ? "#f0b429" : "#c9761f"}
        bodyColor={self ? "#d09315" : "#a75f18"}
        beacon={!self}
        
      />
      {self && ringColor && (
        <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.6, 0]}>
          <ringGeometry args={[RADAR_RANGE * 0.42, RADAR_RANGE * 0.5, 64]} />
          <meshBasicMaterial color={ringColor} transparent opacity={0.45} side={THREE.DoubleSide} />
        </mesh>
      )}
      {!self && (fog ? true : true) && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.5, 0]}>
          <ringGeometry args={[9, 10.4, 40]} />
          <meshBasicMaterial
            color={RISK_COLOR[v.risk] ?? "#3ec98a"}
            transparent
            opacity={0.5}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      <Html position={[0, self ? 11.5 : 10.5, 0]} center distanceFactor={70} zIndexRange={[40, 0]}>
        <div
          className={`whitespace-nowrap rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-widest backdrop-blur-sm ${
            self
              ? "border-primary bg-background/80 text-primary"
              : "border-panel-line bg-background/75 text-foreground"
          }`}
        >
          {self ? "YOU / TRUCK 01" : `TRUCK ${v.vehicleId.slice(1)}`}
          {distance !== undefined && <span className="ml-2 text-muted-foreground">{Math.round(distance)} m</span>}
        </div>
      </Html>
    </group>
  );
}

/* ------------------------------------------------------------ v2v links */

function V2VLine({ a, b, color }: { a: Pt; b: Pt; color: string }) {
  const pts = useMemo(() => {
    const [ax, ay, az] = worldPos(a, 8);
    const [bx, by, bz] = worldPos(b, 8);
    return new Float32Array([ax, ay, az, bx, by, bz]);
  }, [a[0], a[1], b[0], b[1]]);
  return (
    <line>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[pts, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={0.6} />
    </line>
  );
}

/* ----------------------------------------------------------------- root */

export default function PerceptionView({ me, others, cameraMode, fog, safety }: Props) {
  const orbit = useRef(0);
  const dist = useRef(52);
  const wrap = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  // Wheel zoom + drag orbit (native listeners: React wheel is passive).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      dist.current = Math.max(22, Math.min(220, dist.current * Math.exp(dy * 0.0015)));
    };
    let dragging = false;
    let lastX = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      orbit.current += (e.clientX - lastX) * 0.006;
      lastX = e.clientX;
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
  }, []);

  useEffect(() => {
    orbit.current = 0;
    force((x) => x + 1);
  }, [cameraMode]);

  const target = worldPos(me.pos, 4);
  const ringColor = RISK_COLOR[safety] ?? RISK_COLOR['SAFE']!;
  const dists = new Map(
    others.map((o) => [o.vehicleId, Math.hypot(o.pos[0] - me.pos[0], o.pos[1] - me.pos[1]) * 2]),
  );

  return (
    <div ref={wrap} className="h-full w-full cursor-grab touch-none active:cursor-grabbing">
      <Canvas
        shadows
        dpr={[1, 1.8]}
        camera={{ fov: 55, near: 1, far: 6000, position: [target[0], target[1] + 40, target[2] + 70] }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={[fog ? "#a79c8c" : "#22303f"]} />
        <fogExp2 attach="fog" args={[fog ? "#a79c8c" : "#22303f", fog ? 0.006 : 0.0009]} />
        <hemisphereLight args={[fog ? "#e2dac9" : "#b9cee8", "#6b5540", fog ? 2.2 : 1.6]} />
        <ambientLight intensity={fog ? 0.7 : 0.55} />
        <directionalLight
          position={[400, 620, 260]}
          intensity={fog ? 0.9 : 2.8}
          color={fog ? "#d8d0c2" : "#ffe6c2"}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-camera-left={-260}
          shadow-camera-right={260}
          shadow-camera-top={260}
          shadow-camera-bottom={-260}
          shadow-camera-far={1600}
        />
        <MineWorld />
        <Truck v={me} self ringColor={ringColor} fog={fog} />
        {others.map((o) => (
          <Truck key={o.vehicleId} v={o} distance={dists.get(o.vehicleId)} fog={fog} />
        ))}
        {others
          .filter((o) => (dists.get(o.vehicleId) ?? 999) < 400)
          .map((o) => (
            <V2VLine
              key={`l${o.vehicleId}`}
              a={me.pos}
              b={o.pos}
              color={(dists.get(o.vehicleId) ?? 999) < 120 ? "#f08a2c" : "#4ec3ff"}
            />
          ))}
        <CameraRig target={target} heading={me.heading} mode={cameraMode} orbit={orbit} dist={dist} />
      </Canvas>
    </div>
  );
}

export const _wxwz = { wx, wz };
