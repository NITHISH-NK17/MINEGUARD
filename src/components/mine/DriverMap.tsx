/**
 * MINEGUARD Driver Map — in-cab navigation display.
 *
 * The haul road is the primary visual element: a wide, lane-marked road drawn
 * on top of live satellite imagery, with the driver's own dumper held near the
 * lower centre of the screen and the road ahead filling the view. Everything
 * runs from local data (GeoJSON + GPS + V2V + radar), so the safety warnings
 * never depend on internet connectivity.
 */

import "leaflet/dist/leaflet.css";
import type { Map as LeafletMap } from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { Circle, MapContainer, Marker, Polygon, Polyline, TileLayer, useMap } from "react-leaflet";
import { roads } from "@/lib/mine/data";
import { pathLength, pointAt, toLatLon, UNIT_METERS, type Pt } from "@/lib/mine/geo";
import {
  blindCurvePoints,
  ll,
  lls,
  restrictedPolys,
  riskZonePolys,
  roadLines,
} from "@/lib/mine/geojson";
import { LANE_HALF, offsetPos, RADAR_RANGE, type VehicleSnapshot } from "@/lib/mine/useMineSim";
import { BASEMAPS, glyphIcon, riskHex, truckIcon } from "./mapShared";

/** Resample a road centreline and shift it sideways by `off` map units. */
function offsetLine(points: Pt[], off: number): [number, number][] {
  const total = pathLength(points);
  const steps = Math.max(24, Math.min(240, Math.round(total / 6)));
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const { pos, heading } = pointAt(points, (total * i) / steps);
    const p = offsetPos(pos, heading, off);
    const { lat, lon } = toLatLon(p);
    out.push([lat, lon]);
  }
  return out;
}

/** Camera: hold the truck near the lower centre, road ahead filling the view. */
function Follow({ pos, heading, zoom }: { pos: [number, number]; heading: number; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    // Push the map centre ahead of the vehicle so the truck sits low on screen.
    const ahead = 55; // metres
    const rad = (heading * Math.PI) / 180;
    const lat = pos[0] + (Math.cos(rad) * ahead) / 111320;
    const lon = pos[1] + (Math.sin(rad) * ahead) / (111320 * Math.cos((pos[0] * Math.PI) / 180));
    map.setView([lat, lon], zoom, { animate: false });
  }, [map, pos[0], pos[1], heading, zoom]);
  return null;
}

function Grab({ onMap }: { onMap: (m: LeafletMap) => void }) {
  const map = useMap();
  useEffect(() => onMap(map), [map, onMap]);
  return null;
}

type Props = {
  me: VehicleSnapshot;
  others: VehicleSnapshot[];
  headingUp: boolean;
  satellite: boolean;
  tilt: boolean;
  zoom: number;
  onMap: (m: LeafletMap) => void;
};

export default function DriverMap({ me, others, headingUp, satellite, tilt, zoom, onMap }: Props) {
  const bearing = headingUp ? me.heading : 0;
  const pos = useMemo(() => ll(me.pos), [me.pos[0], me.pos[1]]);
  const [, force] = useState(0);
  useEffect(() => force((x) => x + 1), [headingUp, tilt]);

  // Road surface geometry for the road the driver is on.
  const myRoad = roads.find((r) => r.roadId === me.roadId);
  const lanes = useMemo(() => {
    if (!myRoad) return null;
    return {
      centre: offsetLine(myRoad.points, 0),
      laneA: offsetLine(myRoad.points, LANE_HALF),
      laneB: offsetLine(myRoad.points, -LANE_HALF),
      edgeR: offsetLine(myRoad.points, LANE_HALF * 2),
      edgeL: offsetLine(myRoad.points, -LANE_HALF * 2),
    };
  }, [myRoad?.roadId]);

  // Pixel width of the haul road at the current zoom (metres -> px, roughly).
  const mPerPx = (156543.03392 * Math.cos((pos[0] * Math.PI) / 180)) / Math.pow(2, zoom);
  const roadPx = Math.max(26, Math.min(240, (LANE_HALF * 4 * UNIT_METERS) / mPerPx));
  const truckPx = Math.max(48, Math.min(190, 9 / mPerPx));

  const transform = [
    tilt ? "perspective(1100px) rotateX(38deg)" : "",
    `rotate(${-bearing}deg)`,
    tilt ? "scale(1.7)" : "scale(1.45)",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#080b0f]">
      <div
        className="h-full w-full"
        style={{ transform, transformOrigin: "50% 58%" }}
      >
        <MapContainer
          center={pos}
          zoom={zoom}
          minZoom={14}
          maxZoom={20}
          zoomControl={false}
          attributionControl={false}
          dragging={false}
          doubleClickZoom={false}
          scrollWheelZoom={false}
          preferCanvas
          className="h-full w-full bg-[#080b0f]"
        >
          <Grab onMap={onMap} />
          <Follow pos={pos} heading={me.heading} zoom={zoom} />
          {satellite ? (
            <TileLayer url={BASEMAPS.satellite.url} maxNativeZoom={18} maxZoom={20} />
          ) : (
            <TileLayer url={BASEMAPS.terrain.url} maxNativeZoom={16} maxZoom={20} opacity={0.9} />
          )}

          {/* other haul roads, kept subtle */}
          {roadLines
            .filter((r) => r.roadId !== me.roadId)
            .map((r) => (
              <Polyline
                key={r.roadId}
                positions={r.path}
                pathOptions={{ color: "#f2e2c4", weight: Math.max(4, roadPx * 0.22), opacity: 0.35, lineCap: "round" }}
              />
            ))}

          {/* --- the driver's own two-lane haul road --- */}
          {lanes && (
            <>
              {/* berm / shoulder casing */}
              <Polyline
                positions={lanes.centre}
                pathOptions={{ color: "#20160c", weight: roadPx * 1.24, opacity: 0.95, lineCap: "round", lineJoin: "round" }}
              />
              {/* running surface */}
              <Polyline
                positions={lanes.centre}
                pathOptions={{ color: "#6b5c47", weight: roadPx, opacity: 0.92, lineCap: "round", lineJoin: "round" }}
              />
              {/* road edge lines */}
              <Polyline positions={lanes.edgeR} pathOptions={{ color: "#f6f1e4", weight: 3, opacity: 0.85 }} />
              <Polyline positions={lanes.edgeL} pathOptions={{ color: "#f6f1e4", weight: 3, opacity: 0.85 }} />
              {/* lane divider */}
              <Polyline
                positions={lanes.centre}
                pathOptions={{ color: "#ffd447", weight: 4, opacity: 0.95, dashArray: `${roadPx * 0.5} ${roadPx * 0.45}` }}
              />
              {/* lane guidance */}
              <Polyline
                positions={lanes.laneA}
                pathOptions={{ color: "#4ec3ff", weight: 2, opacity: 0.5, dashArray: "10 14" }}
              />
              <Polyline
                positions={lanes.laneB}
                pathOptions={{ color: "#ff9d4e", weight: 2, opacity: 0.4, dashArray: "10 14" }}
              />
            </>
          )}

          {riskZonePolys
            .filter((z) => z.riskLevel === "HIGH")
            .map((z) => (
              <Polygon
                key={z.zoneId}
                positions={z.ring}
                pathOptions={{ color: riskHex(z.riskLevel), weight: 1.5, fillColor: riskHex(z.riskLevel), fillOpacity: 0.12 }}
              />
            ))}
          {restrictedPolys.map((z) => (
            <Polygon
              key={z.id}
              positions={z.ring}
              pathOptions={{ color: "#ff3b3b", weight: 1.5, dashArray: "6 4", fillColor: "#ff3b3b", fillOpacity: 0.1 }}
            />
          ))}
          <Polyline positions={lls(me.trail)} pathOptions={{ color: "#4ec3ff", weight: 3, opacity: 0.55 }} />

          {blindCurvePoints
            .filter((c) => c.roadId === me.roadId)
            .map((c) => (
              <Marker key={c.curveId} position={c.ll} icon={glyphIcon("⚠", "#e7c22b", c.curveId, 30)} />
            ))}

          <Circle
            center={pos}
            radius={RADAR_RANGE}
            pathOptions={{ color: "#4ec3ff", weight: 1, dashArray: "4 6", fillColor: "#4ec3ff", fillOpacity: 0.04 }}
          />

          {others.map((v) => (
            <Marker
              key={v.vehicleId}
              position={ll(v.pos)}
              icon={truckIcon({
                id: v.vehicleId,
                heading: v.heading,
                risk: v.risk,
                rotate: -bearing,
                size: Math.round(truckPx * 0.85),
                showLabel: true,
              })}
            />
          ))}

          <Marker
            position={pos}
            icon={truckIcon({
              id: me.vehicleId,
              heading: me.heading,
              risk: me.risk,
              rotate: -bearing,
              size: Math.round(truckPx),
              selected: true,
              showLabel: true,
            })}
          />
        </MapContainer>
      </div>

      {/* compass (not rotated with the map) */}
      <div className="pointer-events-none absolute right-3 top-3 z-[500] grid h-14 w-14 place-items-center rounded-full border border-panel-line bg-background/80">
        <div style={{ transform: `rotate(${-bearing}deg)` }} className="text-center">
          <div className="font-display text-sm font-bold leading-none text-risk-high">N</div>
          <div className="mx-auto my-0.5 h-5 w-px bg-panel-line" />
        </div>
        <span className="absolute bottom-1 font-mono text-[8px] tracking-widest text-muted-foreground">
          {headingUp ? "HDG UP" : "N UP"}
        </span>
      </div>
    </div>
  );
}
