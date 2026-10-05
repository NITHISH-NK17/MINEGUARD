/**
 * MINEGUARD mine map engine.
 *
 * Renders the ACTIVE mine map (sample layout or an imported QGIS export) as a
 * clear top-down engineering view, and draws live / simulated vehicle
 * positions on top of it in the same coordinate reference system (WGS84).
 *
 *   QGIS map -> GeoJSON -> MINEGUARD map engine -> live vehicle telemetry -> position
 */

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { GeoJsonObject } from "geojson";
import { Circle, GeoJSON, MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet";
import { BASEMAPS, riskHex, truckIcon } from "./mapShared";
import { glyphIcon } from "./mapShared";
import type { RiskLevel } from "@/lib/mine/data";
import { mapBounds, type GeoFeature, type LayerKind, type MineMapDoc } from "@/lib/mine/mapStore";
import type { FeatureInfo, MapCmd, MapRsuMarker, MapVehicle } from "@/lib/mine/mapView";

const STYLE: Record<LayerKind, { color: string; fill: string; weight: number; dash?: string }> = {
  MINE_BOUNDARY: { color: "#7dd3fc", fill: "transparent", weight: 2, dash: "8 6" },
  BENCHES: { color: "#8a7a5f", fill: "#3a3327", weight: 1.2 },
  HIGHWALLS: { color: "#e2b04a", fill: "transparent", weight: 3, dash: "2 5" },
  ROADS: { color: "#e6edf5", fill: "transparent", weight: 4 },
  BLIND_CURVES: { color: "#f08a2c", fill: "#f08a2c", weight: 2 },
  RISK_ZONES: { color: "#ef3f3f", fill: "#ef3f3f", weight: 1.5 },
  RESTRICTED_ZONES: { color: "#c24bd8", fill: "#c24bd8", weight: 1.5, dash: "5 4" },
  LOADING_AREAS: { color: "#3ec98a", fill: "#3ec98a", weight: 1.5 },
  DUMPING_AREAS: { color: "#4aa3e2", fill: "#4aa3e2", weight: 1.5 },
  CHECKPOINTS: { color: "#e7c22b", fill: "#e7c22b", weight: 1.5 },
  RSUS: { color: "#5ad1ff", fill: "#5ad1ff", weight: 1.5 },
  OTHER: { color: "#9aa7b4", fill: "#9aa7b4", weight: 1.5 },
};

const GLYPH: Partial<Record<LayerKind, string>> = {
  BLIND_CURVES: "⚠",
  CHECKPOINTS: "📍",
  RSUS: "📡",
  LOADING_AREAS: "⛏",
  DUMPING_AREAS: "⬇",
};

const roadColor = (risk: unknown) => {
  const r = String(risk ?? "").toUpperCase();
  if (r === "HIGH") return "#ef3f3f";
  if (r === "MEDIUM") return "#f08a2c";
  if (r === "CAUTION") return "#e7c22b";
  return "#e6edf5";
};

function featureTitle(kind: LayerKind, p: Record<string, unknown>) {
  return String(
    p["roadName"] ?? p["curveName"] ?? p["name"] ?? p["zoneType"] ?? p["roadId"] ?? p["zoneId"] ?? p["rsuId"] ?? kind,
  );
}

/* ------------------------------------------------------------ controls */

function MapController({
  cmd,
  bounds,
  follow,
  followPos,
}: {
  cmd: MapCmd;
  bounds: [[number, number], [number, number]] | null;
  follow: boolean;
  followPos: [number, number] | null;
}) {
  const map = useMap();
  const initial = useRef(false);

  useEffect(() => {
    if (initial.current || !bounds) return;
    initial.current = true;
    map.fitBounds(bounds, { padding: [30, 30] });
  }, [bounds, map]);

  useEffect(() => {
    if (!cmd) return;
    if (cmd.type === "ZOOM_IN") map.zoomIn();
    else if (cmd.type === "ZOOM_OUT") map.zoomOut();
    else if (bounds) map.fitBounds(bounds, { padding: [30, 30] });
  }, [cmd, map, bounds]);

  useEffect(() => {
    if (!follow || !followPos) return;
    map.panTo(followPos, { animate: true, duration: 0.6 });
  }, [follow, followPos, map]);

  return null;
}

/* ---------------------------------------------------------------- view */

export default function MineMapView({
  doc,
  vehicles,
  selectedVehicle,
  onSelectVehicle,
  onFeatureClick,
  follow,
  showTrail = true,
  imagery = true,
  rsus = [],
  onSelectRsu,
  cmd,
}: {
  doc: MineMapDoc | null;
  vehicles: MapVehicle[];
  selectedVehicle?: string | null;
  onSelectVehicle?: (id: string) => void;
  onFeatureClick?: (info: FeatureInfo) => void;
  follow: boolean;
  showTrail?: boolean;
  imagery?: boolean;
  rsus?: MapRsuMarker[];
  onSelectRsu?: (id: string) => void;
  cmd: MapCmd;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const bounds = useMemo(() => mapBounds(doc), [doc]);
  const centre = bounds
    ? ([(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2] as [number, number])
    : ([18.68, 81.22] as [number, number]);

  const followTarget = vehicles.find((v) => v.vehicleId === selectedVehicle) ?? vehicles[0];
  const followPos: [number, number] | null = followTarget
    ? [followTarget.latitude, followTarget.longitude]
    : null;

  if (!ready) {
    return <div className="grid h-full place-items-center font-mono text-xs text-muted-foreground">LOADING MAP ENGINE…</div>;
  }

  return (
    <MapContainer
      center={centre}
      zoom={15}
      className="h-full w-full bg-[#0b0e12]"
      zoomControl={false}
      attributionControl={false}
      preferCanvas
    >
      {imagery && (
        <TileLayer url={BASEMAPS.satellite.url} maxNativeZoom={BASEMAPS.satellite.maxNativeZoom} opacity={0.75} />
      )}

      {doc?.layers
        .filter((l) => l.visible)
        .map((layer) => {
          const st = STYLE[layer.kind];
          const glyph = GLYPH[layer.kind];
          return (
            <GeoJSON
              key={`${doc.id}-${layer.id}`}
              data={layer.fc as unknown as GeoJsonObject}
              style={(f) => {
                const p = (f?.properties ?? {}) as Record<string, unknown>;
                const color = layer.kind === "ROADS" ? roadColor(p["riskLevel"]) : st.color;
                return {
                  color,
                  weight: st.weight,
                  opacity: 0.95,
                  fillColor: st.fill,
                  fillOpacity: st.fill === "transparent" ? 0 : layer.kind === "BENCHES" ? 0.35 : 0.18,
                  ...(st.dash ? { dashArray: st.dash } : {}),
                };
              }}
              pointToLayer={(f, latlng) =>
                glyph
                  ? L.marker(latlng, { icon: glyphIcon(glyph, st.color) })
                  : L.circleMarker(latlng, { radius: 5, color: st.color, fillColor: st.fill, fillOpacity: 0.8 })
              }
              onEachFeature={(f, lyr) => {
                lyr.on("click", () => {
                  const p = ((f as GeoFeature).properties ?? {}) as Record<string, unknown>;
                  onFeatureClick?.({ kind: layer.kind, title: featureTitle(layer.kind, p), props: p });
                });
              }}
            />
          );
        })}

      {vehicles.map((v) => (
        <Fragment key={v.vehicleId}>
          {showTrail && v.trail.length > 1 && (
            <Polyline positions={v.trail} pathOptions={{ color: riskHex(v.risk), weight: 2, opacity: 0.6, dashArray: "4 4" }} />
          )}
          {v.accuracy > 0 && (
            <Circle
              center={[v.latitude, v.longitude]}
              radius={Math.max(v.accuracy, 0.5)}
              pathOptions={{ color: "#5ad1ff", weight: 1, fillOpacity: 0.08 }}
            />
          )}
          <Marker
            position={[v.latitude, v.longitude]}
            icon={truckIcon({
              id: v.vehicleId,
              heading: v.heading,
              risk: v.risk,
              size: 36,
              selected: v.vehicleId === selectedVehicle,
              showLabel: true,
            })}
            opacity={v.lost ? 0.55 : 1}
            eventHandlers={{ click: () => onSelectVehicle?.(v.vehicleId) }}
          />
        </Fragment>
      ))}

      {rsus.map((r) => {
        const col = r.status === "ONLINE" ? "#5ad1ff" : r.status === "OFFLINE" ? "#ef3f3f" : "#7b8794";
        return (
          <Fragment key={`rsu-${r.rsuId}`}>
            <Circle
              center={[r.latitude, r.longitude]}
              radius={r.rangeMetres}
              pathOptions={{ color: col, weight: 1, opacity: 0.7, dashArray: "5 5", fillColor: col, fillOpacity: 0.05 }}
            />
            {r.status === "ONLINE" &&
              r.detections.map((d) => {
                const v = vehicles.find((x) => x.vehicleId === d.vehicleId);
                return v ? (
                  <Polyline
                    key={`${r.rsuId}-${d.vehicleId}`}
                    positions={[
                      [r.latitude, r.longitude],
                      [v.latitude, v.longitude],
                    ]}
                    pathOptions={{ color: col, weight: 1.4, opacity: 0.75, dashArray: "3 5" }}
                  />
                ) : null;
              })}
            <Marker
              position={[r.latitude, r.longitude]}
              icon={glyphIcon("📡", col, `${r.rsuId} · ${r.status === "ONLINE" ? `${r.detections.length} VEH` : r.status}`, 22)}
              eventHandlers={{ click: () => onSelectRsu?.(r.rsuId) }}
            />
          </Fragment>
        );
      })}

      <MapController cmd={cmd} bounds={bounds} follow={follow} followPos={followPos} />
    </MapContainer>
  );
}
