/**
 * Static 3D environment: stepped benches, highwalls, haul roads, ramps,
 * loading / dumping areas, blind-curve markers and safety berms.
 *
 * Geometry is derived from the same local mine dataset the Control Center
 * uses, so both views describe one simulated (Bailadila-inspired, fictional)
 * open-cast iron ore mine.
 */

import { useMemo } from "react";
import * as THREE from "three";
import { benches, blindCurves, roads, siteAreas, elevationAt } from "@/lib/mine/data";
import { CENTER, type Pt } from "@/lib/mine/geo";
import {
  BASE_RL,
  bermPlacements,
  dashGeometry,
  headingToYaw,
  ribbonGeometry,
  rimOutline,
  rockTexture,
  terraceGeometry,
  wallGeometry,
  worldPos,
  wx,
  wz,
} from "./world";

const BENCH_COLORS = ["#a9835c", "#9e7954", "#946f4c", "#8a6544", "#7f5c3d"];

type WorldProps = {
  showRoads?: boolean;
  showBenches?: boolean;
  showLoading?: boolean;
  showDump?: boolean;
};

export default function MineWorld({
  showRoads = true,
  showBenches = true,
  showLoading = true,
  showDump = true,
}: WorldProps = {}) {
  const tex = useMemo(
    () => ({
      ground: rockTexture("#9a7551", "#c2a077"),
      road: rockTexture("#8b8073", "#b3a795", 256, 1800),
      wall: rockTexture("#7a5b3e", "#a3805c", 256, 3400),
    }),
    [],
  );

  const terrain = useMemo(() => {
    const rim = rimOutline();
    const crestY = 1125 - BASE_RL;
    const terraces: { geom: THREE.BufferGeometry; color: string }[] = [];
    const walls: THREE.BufferGeometry[] = [];

    // undisturbed hill crest around the pit
    const outer = new THREE.Shape();
    outer.moveTo(-2600, -2200);
    outer.lineTo(2600, -2200);
    outer.lineTo(2600, 2200);
    outer.lineTo(-2600, 2200);
    outer.closePath();
    const hole = new THREE.Path();
    rim.forEach((p, i) => (i === 0 ? hole.moveTo(wx(p), wz(p)) : hole.lineTo(wx(p), wz(p))));
    hole.closePath();
    outer.holes.push(hole);
    const crest = new THREE.ShapeGeometry(outer);
    crest.rotateX(Math.PI / 2);
    crest.computeVertexNormals();
    terraces.push({ geom: crest, color: "#8d6f4e" });
    walls.push(wallGeometry(rim, crestY, benches[0]!.polygon, benches[0]!.elevation - BASE_RL));

    benches.forEach((b, i) => {
      const inner = benches[i + 1];
      terraces.push({
        geom: terraceGeometry(b.polygon, inner ? inner.polygon : null),
        color: BENCH_COLORS[i] ?? "#5f452f",
      });
      if (inner) {
        walls.push(
          wallGeometry(inner.polygon, b.elevation - BASE_RL, inner.polygon, inner.elevation - BASE_RL),
        );
      }
    });
    return { terraces, walls };
  }, []);

  const roadMeshes = useMemo(
    () =>
      roads.map((r) => ({
        id: r.roadId,
        surface: ribbonGeometry(r, r.roadWidth, 0.4),
        shoulder: ribbonGeometry(r, r.roadWidth + 7, 0.2),
        dash: dashGeometry(r),
        berms: bermPlacements(r, r.roadWidth / 2 + 3.4),
      })),
    [],
  );

  return (
    <group>
      {/* --- stepped benches and highwalls --- */}
      {showBenches &&
        terrain.terraces.map((t, i) => (
        <mesh key={`t${i}`} geometry={t.geom} position={[0, benchY(i), 0]} receiveShadow>
          <meshStandardMaterial
            color={t.color}
            map={tex.ground}
            roughness={1}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
      {showBenches &&
        terrain.walls.map((g, i) => (
        <mesh key={`w${i}`} geometry={g} castShadow receiveShadow>
          <meshStandardMaterial color="#8a6647" map={tex.wall} roughness={1} side={THREE.DoubleSide} />
        </mesh>
      ))}

      {/* --- haul roads --- */}
      {showRoads &&
        roadMeshes.map((r) => (
        <group key={r.id}>
          <mesh geometry={r.shoulder} receiveShadow>
            <meshStandardMaterial color="#8a7a63" roughness={1} side={THREE.DoubleSide} />
          </mesh>
          <mesh geometry={r.surface} receiveShadow>
            <meshStandardMaterial color="#9a9184" map={tex.road} roughness={0.95} side={THREE.DoubleSide} />
          </mesh>
          <mesh geometry={r.dash}>
            <meshStandardMaterial
              color="#ffd447"
              emissive="#8a6b12"
              emissiveIntensity={0.4}
              roughness={0.6}
              side={THREE.DoubleSide}
            />
          </mesh>
          {r.berms.map((b, i) => (
            <mesh key={i} position={b.pos} rotation={[0, b.yaw, 0]} castShadow>
              <boxGeometry args={[3.2, 1.8, 9]} />
              <meshStandardMaterial color="#5d472f" roughness={1} />
            </mesh>
          ))}
        </group>
      ))}

      {/* --- blind curve markers --- */}
      {blindCurves.map((c) => (
        <group key={c.curveId} position={worldPos(c.pos, 0)}>
          <mesh position={[0, 3.2, 0]} castShadow>
            <coneGeometry args={[1.5, 6.4, 4]} />
            <meshStandardMaterial color="#e7c22b" emissive="#6b5a08" emissiveIntensity={0.5} roughness={0.6} />
          </mesh>
          <mesh position={[0, 7.4, 0]}>
            <sphereGeometry args={[0.9, 12, 12]} />
            <meshStandardMaterial color="#ffdf5e" emissive="#ffbf00" emissiveIntensity={2} />
          </mesh>
        </group>
      ))}

      {/* --- loading / dumping / service areas --- */}
      {siteAreas
        .filter((a) => (a.kind === "LOADING" ? showLoading : a.kind === "DUMPING" ? showDump : true))
        .map((a) => (
        <group key={a.areaId} position={worldPos(a.center, 0.6)}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[a.rx * 2 - 5, a.rx * 2, 64]} />
            <meshStandardMaterial
              color={a.kind === "LOADING" ? "#3ec98a" : a.kind === "DUMPING" ? "#f08a2c" : "#4ec3ff"}
              emissive={a.kind === "LOADING" ? "#12603f" : a.kind === "DUMPING" ? "#6b3a0c" : "#0d4a6b"}
              emissiveIntensity={0.8}
              transparent
              opacity={0.35}
              side={THREE.DoubleSide}
            />
          </mesh>
          {a.kind === "LOADING" && <Shovel />}
          {a.kind === "DUMPING" && <TipBerm />}
        </group>
      ))}

      {/* --- scattered pit boulders for scale --- */}
      {BOULDERS.map((b, i) => (
        <mesh key={i} position={worldPos(b, 1.2)} castShadow scale={2 + (i % 3)}>
          <dodecahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color="#54402e" roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

/** Terrace i sits at bench i elevation (index 0 = crest ring). */
function benchY(i: number) {
  if (i === 0) return 1125 - BASE_RL;
  const b = benches[i - 1];
  return b ? b.elevation - BASE_RL : 0;
}

const BOULDERS: Pt[] = [
  [330, 606],
  [130, 372],
  [702, 214],
  [452, 470],
  [900, 150],
  [214, 690],
  [560, 300],
  [640, 420],
];

function Shovel() {
  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 3, 0]} castShadow>
        <boxGeometry args={[9, 6, 12]} />
        <meshStandardMaterial color="#c9a227" roughness={0.6} metalness={0.4} />
      </mesh>
      <mesh position={[0, 9, -6]} rotation={[0.5, 0, 0]} castShadow>
        <boxGeometry args={[2, 2, 18]} />
        <meshStandardMaterial color="#b08f1e" roughness={0.6} metalness={0.4} />
      </mesh>
      <mesh position={[0, 3.5, -13]} castShadow>
        <boxGeometry args={[7, 5, 6]} />
        <meshStandardMaterial color="#3a3f46" roughness={0.9} metalness={0.5} />
      </mesh>
    </group>
  );
}

function TipBerm() {
  return (
    <group>
      {[-24, -8, 8, 24].map((x) => (
        <mesh key={x} position={[x, 1.6, 0]} castShadow>
          <boxGeometry args={[13, 3.2, 5]} />
          <meshStandardMaterial color="#6a4d31" roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

/** Ground height under any planar point (used by the camera rig). */
export function groundY(p: Pt) {
  return elevationAt(p) - BASE_RL;
}

export const MINE_CENTER: Pt = CENTER;
export const _unusedWz = wz;
