/**
 * MINEGUARD Control Center map.
 *
 * Real interactive geographic map (Leaflet) with satellite imagery as the
 * visual foundation and MINEGUARD safety data drawn as geographic overlays in
 * WGS84 coordinates. All MINEGUARD layers come from local GeoJSON, so safety
 * data keeps rendering when the tile service is unreachable.
 */

import "leaflet/dist/leaflet.css";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { RiskZone } from "@/lib/mine/data";
import {
  ZOOM,
  areaPolys,
  benchRings,
  blindCurvePoints,
  checkpointPoints,
  crumbForZoom,
  highwall,
  ll,
  lls,
  MINE_CENTER,
  mineBoundary,
  places,
  restrictedPolys,
  riskZonePolys,
  roadLines,
  rsuPoints,
  slopePoints,
  type LatLng,
  type Place,
} from "@/lib/mine/geojson";
import type { V2VLink, VehicleSnapshot } from "@/lib/mine/useMineSim";
import { BASEMAPS, glyphIcon, riskHex, truckIcon } from "./mapShared";

export type LayerKey =
  | "satellite"
  | "terrain"
  | "boundary"
  | "roads"
  | "vehicles"
  | "tracks"
  | "curves"
  | "zones"
  | "rsus"
  | "checkpoints"
  | "v2v"
  | "loading"
  | "dump"
  | "restricted";

export const LAYER_LIST: { key: LayerKey; label: string }[] = [
  { key: "satellite", label: "Satellite" },
  { key: "terrain", label: "Terrain" },
  { key: "boundary", label: "Mine Boundary" },
  { key: "roads", label: "Haul Roads" },
  { key: "vehicles", label: "Vehicles" },
  { key: "tracks", label: "GPS Tracks" },
  { key: "curves", label: "Blind Curves" },
  { key: "zones", label: "Risk Zones" },
  { key: "rsus", label: "RSUs" },
  { key: "checkpoints", label: "Checkpoints" },
  { key: "v2v", label: "V2V Links" },
  { key: "loading", label: "Loading Areas" },
  { key: "dump", label: "Dump Areas" },
  { key: "restricted", label: "Restricted Areas" },
];

export type FlyTarget = { center: LatLng; zoom: number; key: number } | null;

type Props = {
  vehicles: VehicleSnapshot[];
  links: V2VLink[];
  selectedVehicle: string | null;
  onSelectVehicle: (id: string) => void;
  selectedZone: RiskZone | null;
  onSelectZone: (z: RiskZone | null) => void;
  flyTarget: FlyTarget;
};

function Flyer({ target }: { target: FlyTarget }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target.center, target.zoom, { duration: 2.2 });
  }, [target, map]);
  return null;
}

function ZoomWatch({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  useEffect(() => onZoom(map.getZoom()), [map, onZoom]);
  return null;
}

export default function ControlMap(props: Props) {
  const { vehicles, links, selectedVehicle, onSelectVehicle, selectedZone, onSelectZone, flyTarget } = props;
  const [zoom, setZoom] = useState(15);
  const [offline, setOffline] = useState(false);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    satellite: true,
    terrain: true,
    boundary: true,
    roads: true,
    vehicles: true,
    tracks: true,
    curves: true,
    zones: true,
    rsus: true,
    checkpoints: true,
    v2v: true,
    loading: true,
    dump: true,
    restricted: true,
  });
  const [search, setSearch] = useState("");
  const [manualTarget, setManualTarget] = useState<FlyTarget>(null);

  const target = useMemo(() => {
    if (!flyTarget) return manualTarget;
    if (!manualTarget) return flyTarget;
    return manualTarget.key > flyTarget.key ? manualTarget : flyTarget;
  }, [flyTarget, manualTarget]);

  const crumb = crumbForZoom(zoom);
  const showMine = zoom >= ZOOM.mine;
  const showSafety = zoom >= ZOOM.safety;
  const showDetail = zoom >= ZOOM.vehicleDetail;
  const showLabels = zoom >= ZOOM.roadLabels;
  const clustered = zoom >= ZOOM.region && zoom < ZOOM.mine;

  const toggle = (k: LayerKey) => setLayers((s) => ({ ...s, [k]: !s[k] }));
  const goto = (p: Place) => setManualTarget({ center: p.center, zoom: p.zoom, key: Date.now() });

  const runSearch = () => {
    const q = search.trim().toLowerCase();
    if (!q) return;
    const hit =
      places.find((p) => p.name.toLowerCase() === q) ??
      places.find((p) => p.name.toLowerCase().includes(q)) ??
      places.find((p) => p.id.includes(q));
    if (hit) goto(hit);
  };

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={MINE_CENTER}
        zoom={15}
        minZoom={3}
        maxZoom={19}
        zoomControl
        preferCanvas
        className="h-full w-full bg-[#0b0f14]"
      >
        <ZoomWatch onZoom={setZoom} />
        <Flyer target={target} />

        {layers.satellite && (
          <TileLayer
            url={BASEMAPS.satellite.url}
            attribution={BASEMAPS.satellite.attribution}
            maxNativeZoom={BASEMAPS.satellite.maxNativeZoom}
            maxZoom={19}
            eventHandlers={{ tileerror: () => setOffline(true), tileload: () => setOffline(false) }}
          />
        )}
        {layers.terrain && (
          <TileLayer
            url={BASEMAPS.terrain.url}
            maxNativeZoom={BASEMAPS.terrain.maxNativeZoom}
            maxZoom={19}
            opacity={layers.satellite ? 0.35 : 1}
          />
        )}
        <TileLayer url={BASEMAPS.labels.url} maxNativeZoom={18} maxZoom={19} opacity={0.9} />

        {/* Offline fallback base: local terrain model keeps the mine readable
            with no tile service. */}
        {offline &&
          showMine &&
          benchRings.map((b, i) => (
            <Polygon
              key={b.benchId}
              positions={b.ring}
              pathOptions={{
                color: "#6b5a3c",
                weight: 1,
                fillColor: ["#6b5333", "#5d492d", "#4f3f27", "#413521", "#342b1c"][i],
                fillOpacity: 1,
              }}
            />
          ))}

        {/* ---------------- mine boundary / terrain overlays ---------------- */}
        {layers.boundary && zoom >= ZOOM.region && (
          <Polygon
            positions={mineBoundary}
            pathOptions={{ color: "#f0a83c", weight: 2, dashArray: "8 6", fill: false }}
          >
            <Tooltip sticky>MINEGUARD Mine Safety Area — simulated lease boundary</Tooltip>
          </Polygon>
        )}

        {showMine &&
          !offline &&
          benchRings.map((b) => (
            <Polygon
              key={b.benchId}
              positions={b.ring}
              pathOptions={{ color: "#e0c9a0", weight: 1, opacity: 0.55, fillOpacity: 0.06, fillColor: "#e0c9a0" }}
            >
              <Tooltip sticky>{`${b.benchId} — ${b.name} · RL ${b.elevation} m`}</Tooltip>
            </Polygon>
          ))}

        {showMine && (
          <Polyline positions={highwall} pathOptions={{ color: "#ff6b4a", weight: 3, dashArray: "2 7" }}>
            <Tooltip sticky>Highwall crest — no stopping within 30 m</Tooltip>
          </Polyline>
        )}

        {/* ------------------------------ haul roads ------------------------------ */}
        {layers.roads &&
          showMine &&
          roadLines.map((r) => (
            <Polyline
              key={r.roadId}
              positions={r.path}
              pathOptions={{
                color: "#f2e2c4",
                weight: Math.max(2, r.roadWidth / (zoom >= 16 ? 2.2 : 5)),
                opacity: 0.9,
                lineCap: "round",
              }}
            >
              {showLabels && (
                <Tooltip permanent direction="center" className="mineguard-road-label">
                  {`${r.roadId} · ${r.roadName} · ${r.speedLimit} km/h`}
                </Tooltip>
              )}
              <Popup>
                <div className="font-mono text-[11px] leading-5">
                  <b>
                    {r.roadId} — {r.roadName}
                  </b>
                  <br />
                  SPEED LIMIT {r.speedLimit} km/h
                  <br />
                  WIDTH {r.roadWidth} m · RL {r.elevation} m
                  <br />
                  DIRECTION {r.direction} · RISK {r.riskLevel}
                </div>
              </Popup>
            </Polyline>
          ))}

        {/* ------------------------------ areas ------------------------------ */}
        {showMine &&
          areaPolys.map((a) => {
            const on =
              a.kind === "LOADING"
                ? layers.loading
                : a.kind === "DUMPING"
                  ? layers.dump
                  : layers.boundary;
            if (!on) return null;
            const color = a.kind === "LOADING" ? "#4ec3ff" : a.kind === "DUMPING" ? "#c58bff" : "#9fb0c0";
            return (
              <Polygon
                key={a.areaId}
                positions={a.ring}
                pathOptions={{ color, weight: 1.5, fillColor: color, fillOpacity: 0.14 }}
              >
                <Tooltip sticky>{`${a.areaId} — ${a.name}`}</Tooltip>
              </Polygon>
            );
          })}

        {layers.restricted &&
          showMine &&
          restrictedPolys.map((z) => (
            <Polygon
              key={z.id}
              positions={z.ring}
              pathOptions={{ color: "#ff3b3b", weight: 1.5, dashArray: "6 4", fillColor: "#ff3b3b", fillOpacity: 0.12 }}
            >
              <Tooltip sticky>{`${z.id} — ${z.name} (NO ENTRY)`}</Tooltip>
            </Polygon>
          ))}

        {/* ---------------------------- risk zones ---------------------------- */}
        {layers.zones &&
          showSafety &&
          riskZonePolys.map((z) => {
            const c = riskHex(z.riskLevel);
            const sel = selectedZone?.zoneId === z.zoneId;
            return (
              <Polygon
                key={z.zoneId}
                positions={z.ring}
                pathOptions={{
                  color: c,
                  weight: sel ? 3 : 1.6,
                  fillColor: c,
                  fillOpacity: sel ? 0.26 : 0.14,
                }}
                eventHandlers={{ click: () => onSelectZone(z) }}
              >
                <Tooltip sticky>{`${z.zoneId} — ${z.zoneType} · ${z.riskLevel}`}</Tooltip>
              </Polygon>
            );
          })}

        {showSafety &&
          slopePoints.map((s) => (
            <Marker key={s.slopeId} position={s.ll} icon={glyphIcon("▲", "#f0a83c", showDetail ? s.gradient : "")}>
              <Tooltip>{`${s.slopeId} — ${s.name} · gradient ${s.gradient}`}</Tooltip>
            </Marker>
          ))}

        {/* --------------------------- blind curves --------------------------- */}
        {layers.curves &&
          showSafety &&
          blindCurvePoints.map((c) => (
            <Fragment key={c.curveId}>
              {showDetail && (
                <Circle
                  center={c.ll}
                  radius={c.warningDistance}
                  pathOptions={{ color: "#e7c22b", weight: 1, dashArray: "4 5", fillOpacity: 0.05 }}
                />
              )}
              <Marker position={c.ll} icon={glyphIcon("⚠", riskHex(c.riskLevel), showDetail ? c.curveId : "")}>
                <Popup>
                  <div className="font-mono text-[11px] leading-5">
                    <b>
                      {c.curveId} — {c.curveName}
                    </b>
                    <br />
                    ROAD {c.roadId} · RISK {c.riskLevel}
                    <br />
                    RECOMMENDED {c.recommendedSpeed} km/h
                    <br />
                    WARNING RADIUS {c.warningDistance} m
                  </div>
                </Popup>
              </Marker>
            </Fragment>
          ))}

        {/* -------------------------------- RSUs -------------------------------- */}
        {layers.rsus &&
          showSafety &&
          rsuPoints.map((r) => (
            <Fragment key={r.rsuId}>
              <Circle
                center={r.ll}
                radius={r.rangeM}
                pathOptions={{ color: "#4ec3ff", weight: 1, opacity: 0.5, fillColor: "#4ec3ff", fillOpacity: 0.05 }}
              />
              <Marker position={r.ll} icon={glyphIcon("📡", "#4ec3ff", showDetail ? r.rsuId : "")}>
                <Tooltip>{`${r.rsuId} — ${r.name}`}</Tooltip>
              </Marker>
            </Fragment>
          ))}

        {layers.checkpoints &&
          showSafety &&
          checkpointPoints.map((c) => (
            <Marker key={c.cpId} position={c.ll} icon={glyphIcon("⛳", "#9fb0c0", showDetail ? c.cpId : "")}>
              <Tooltip>{`${c.cpId} — ${c.name}`}</Tooltip>
            </Marker>
          ))}

        {/* ------------------------------- V2V ------------------------------- */}
        {layers.v2v &&
          showSafety &&
          links.map((l) => {
            const a = vehicles.find((v) => v.vehicleId === l.a);
            const b = vehicles.find((v) => v.vehicleId === l.b);
            if (!a || !b) return null;
            const c = riskHex(l.risk);
            return (
              <Polyline
                key={`${l.a}-${l.b}`}
                positions={[ll(a.pos), ll(b.pos)]}
                pathOptions={{
                  color: c,
                  weight: l.risk === "HIGH" ? 3.5 : 1.5,
                  opacity: l.risk === "SAFE" ? 0.35 : 0.9,
                  dashArray: l.risk === "HIGH" ? undefined : "5 6",
                }}
              >
                <Tooltip sticky>{`V2V ${l.a} ⇄ ${l.b} · ${Math.round(l.distance)} m · ${l.approach} · ${l.risk}`}</Tooltip>
              </Polyline>
            );
          })}

        {/* ----------------------------- GPS tracks ----------------------------- */}
        {layers.tracks &&
          showMine &&
          vehicles.map((v) => (
            <Polyline
              key={`t-${v.vehicleId}`}
              positions={lls(v.trail)}
              pathOptions={{ color: riskHex(v.risk), weight: 1.5, opacity: 0.45 }}
            />
          ))}

        {/* ------------------------------ vehicles ------------------------------ */}
        {layers.vehicles &&
          zoom >= ZOOM.mine &&
          vehicles.map((v) => (
            <Fragment key={v.vehicleId}>
            {showDetail && (
              <Circle
                center={ll(v.pos)}
                radius={60}
                pathOptions={{ color: "#4ec3ff", weight: 1, dashArray: "3 5", fillOpacity: 0.03 }}
              />
            )}
            <Marker
              position={ll(v.pos)}
              icon={truckIcon({
                id: v.vehicleId,
                heading: v.heading,
                risk: v.risk,
                selected: selectedVehicle === v.vehicleId,
                showLabel: showSafety,
                size: showDetail ? 40 : 30,
              })}
              eventHandlers={{ click: () => onSelectVehicle(v.vehicleId) }}
            >
              <Popup>
                <div className="font-mono text-[11px] leading-5">
                  <b>
                    {v.vehicleId} — {v.label}
                  </b>
                  <br />
                  {v.gps.lat.toFixed(6)}, {v.gps.lon.toFixed(6)}
                  <br />
                  {v.speed.toFixed(1)} km/h · HDG {Math.round(v.heading)}° {v.headingText}
                  <br />
                  {v.roadId} — {v.roadName} · RL {v.elevation} m<br />
                  RISK {v.risk} · V2V {v.v2v ? "LINKED" : "LOST"} ({v.peers})
                </div>
              </Popup>
            </Marker>
            </Fragment>
          ))}

        {/* Clustered site marker when zoomed out past the mine level. */}
        {clustered && (
          <CircleMarker
            center={MINE_CENTER}
            radius={13}
            pathOptions={{ color: "#f0a83c", fillColor: "#f0a83c", fillOpacity: 0.7, weight: 2 }}
          >
            <Tooltip permanent direction="right">{`MINEGUARD · ${vehicles.length} units`}</Tooltip>
          </CircleMarker>
        )}
        {zoom < ZOOM.region && (
          <CircleMarker
            center={MINE_CENTER}
            radius={8}
            pathOptions={{ color: "#f0a83c", fillColor: "#f0a83c", fillOpacity: 0.8, weight: 2 }}
          >
            <Tooltip permanent direction="right">
              BAILADILA — MINEGUARD SITE
            </Tooltip>
          </CircleMarker>
        )}
      </MapContainer>

      {/* ------------------------------ breadcrumb ------------------------------ */}
      <div className="pointer-events-none absolute left-12 top-2 z-[500] flex max-w-[calc(100%-19rem)] flex-col items-start gap-1">
        <div className="panel-frame pointer-events-auto px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] text-foreground/90">
          {crumb.join("  /  ")}
          <span className="ml-2 text-muted-foreground">Z{zoom.toFixed(0)}</span>
        </div>
        {zoom >= ZOOM.mine && (
          <div className="panel-frame pointer-events-auto px-3 py-1 font-display text-xs tracking-[0.18em] text-primary">
            MINEGUARD — BAILADILA-INSPIRED SIMULATION
          </div>
        )}
        <div
          className={`panel-frame pointer-events-auto px-3 py-1 font-mono text-[10px] tracking-[0.12em] ${offline ? "text-risk-medium" : "text-risk-safe"}`}
        >
          {offline ? "OFFLINE BASEMAP — LOCAL GEOJSON" : "SATELLITE BASEMAP · MINEGUARD OVERLAYS"}
        </div>
      </div>

      {/* -------------------------------- search -------------------------------- */}
      <div className="absolute right-2 top-2 z-[500] w-56">
        <div className="panel-frame flex items-center gap-1 px-2 py-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            placeholder="Search location…"
            list="mineguard-places"
            className="w-full bg-transparent font-mono text-[11px] outline-none placeholder:text-muted-foreground"
            aria-label="Search location"
          />
          <datalist id="mineguard-places">
            {places.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
          <button onClick={runSearch} className="font-mono text-[10px] text-primary" aria-label="Go">
            GO
          </button>
        </div>
        <div className="panel-frame mt-1 max-h-[42vh] overflow-auto p-2">
          <p className="tech-label mb-1">Location hierarchy</p>
          {places.map((p, i) => (
            <button
              key={p.id}
              onClick={() => goto(p)}
              className="block w-full truncate text-left font-mono text-[10px] leading-5 text-foreground/80 hover:text-primary"
            >
              {"›".repeat(i ? 1 : 0)} {p.name.toUpperCase()}
            </button>
          ))}
          <p className="tech-label mb-1 mt-2">Map layers</p>
          <div className="grid grid-cols-1 gap-0.5">
            {LAYER_LIST.map((l) => (
              <label key={l.key} className="flex cursor-pointer items-center gap-2 font-mono text-[10px] leading-5">
                <input
                  type="checkbox"
                  checked={layers[l.key]}
                  onChange={() => toggle(l.key)}
                  className="accent-[var(--primary)]"
                />
                {l.label}
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
