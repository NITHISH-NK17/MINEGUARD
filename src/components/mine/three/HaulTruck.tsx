/**
 * Procedural open-pit haul truck (rigid-frame mining dumper, ~CAT 793 scale).
 *
 * Modelled from primitives so the app stays fully offline — no external model
 * downloads. Local +Z is the rear, -Z is the direction of travel.
 */

import { useMemo } from "react";
import * as THREE from "three";

type Props = {
  color?: string;
  bodyColor?: string;
  headlights?: boolean;
  beacon?: boolean;
};

const WHEELS: [number, number][] = [
  [-3.1, -3.6],
  [3.1, -3.6],
  [-3.4, 3.0],
  [3.4, 3.0],
  [-3.4, 4.6],
  [3.4, 4.6],
];

export default function HaulTruck({
  color = "#e8a516",
  bodyColor = "#c8891a",
  headlights = true,
  beacon = false,
}: Props) {
  // Tapered dump body (trapezoid cross-section) built once.
  const trayGeom = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-3.1, 0);
    s.lineTo(3.1, 0);
    s.lineTo(4.2, 3.1);
    s.lineTo(-4.2, 3.1);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 9.5, bevelEnabled: false });
    g.rotateY(Math.PI / 2);
    g.center();
    return g;
  }, []);


  return (
    <group>
      {/* chassis frame */}
      <mesh position={[0, 1.9, 0.4]} castShadow>
        <boxGeometry args={[5.4, 1.5, 11.6]} />
        <meshStandardMaterial color="#2a2f36" roughness={0.85} metalness={0.35} />
      </mesh>

      {/* dump body */}
      <group position={[0, 4.5, 1.2]} rotation={[0.03, 0, 0]}>
        <mesh geometry={trayGeom} castShadow>
          <meshStandardMaterial color={bodyColor} roughness={0.62} metalness={0.5} />
        </mesh>
        {/* canopy over the cab */}
        <mesh position={[0, 1.55, -5.4]} castShadow>
          <boxGeometry args={[8.2, 0.5, 3.2]} />
          <meshStandardMaterial color={bodyColor} roughness={0.62} metalness={0.5} />
        </mesh>
      </group>

      {/* operator cab */}
      <mesh position={[-2.0, 4.3, -4.6]} castShadow>
        <boxGeometry args={[2.4, 2.2, 2.4]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.4} />
      </mesh>
      <mesh position={[-2.0, 4.5, -5.75]}>
        <boxGeometry args={[2.0, 1.3, 0.12]} />
        <meshStandardMaterial color="#0d1a24" roughness={0.15} metalness={0.9} />
      </mesh>
      {/* access stairway */}
      <mesh position={[-3.3, 2.6, -4.0]} castShadow>
        <boxGeometry args={[0.25, 3.4, 1.4]} />
        <meshStandardMaterial color="#8a9099" roughness={0.8} metalness={0.6} />
      </mesh>

      {/* front bumper / bull bar */}
      <mesh position={[0, 2.1, -6.1]} castShadow>
        <boxGeometry args={[6.2, 1.3, 0.7]} />
        <meshStandardMaterial color={color} roughness={0.55} metalness={0.45} />
      </mesh>

      {/* wheels */}
      {WHEELS.map(([x, z], i) => (
        <group key={i} position={[x, 1.85, z]} rotation={[0, 0, Math.PI / 2]}>
          <mesh castShadow>
            <cylinderGeometry args={[1.85, 1.85, 1.35, 20]} />
            <meshStandardMaterial color="#16181c" roughness={0.98} />
          </mesh>
          <mesh position={[0, x > 0 ? 0.62 : -0.62, 0]}>
            <cylinderGeometry args={[0.8, 0.8, 0.16, 16]} />
            <meshStandardMaterial color="#5d6570" roughness={0.6} metalness={0.7} />
          </mesh>
        </group>
      ))}

      {/* headlights */}
      {headlights && (
        <>
          {[-1.9, 1.9].map((x) => (
            <mesh key={x} position={[x, 2.6, -6.45]}>
              <sphereGeometry args={[0.34, 12, 12]} />
              <meshStandardMaterial color="#fff6dd" emissive="#ffe9b0" emissiveIntensity={2.4} />
            </mesh>
          ))}
        </>
      )}
      {beacon && (
        <mesh position={[-2.0, 5.6, -4.6]}>
          <sphereGeometry args={[0.28, 10, 10]} />
          <meshStandardMaterial color="#ffb020" emissive="#ff9500" emissiveIntensity={3} />
        </mesh>
      )}
    </group>
  );
}
