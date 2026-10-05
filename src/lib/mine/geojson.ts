/**
 * MINEGUARD offline geographic data layer.
 *
 * Every MINEGUARD map feature is exported here as a modular GeoJSON
 * FeatureCollection in real WGS84 coordinates (lon/lat), generated from the
 * local mine model. No pixel coordinates leave this module — the map
 * components consume latitude/longitude only.
 *
 * SIMULATION NOTICE: the mine geography is placed at the real geographic
 * location of the Bailadila range (Dantewada, Chhattisgarh) but the internal
 * haul roads, RSUs, checkpoints and safety zones are a fictional layout for
 * demonstration — not an official NMDC operational survey.
 */

import {
  benches,
  blindCurves,
  checkpoints,
  restrictedZones,
  riskZones,
  roads,
  rsus,
  siteAreas,
  steepSlopes,
} from "./data";
import { arcPoints, toLatLon, type Pt } from "./geo";

export type LatLng = [number, number];

export const ll = (p: Pt): LatLng => {
  const { lat, lon } = toLatLon(p);
  return [lat, lon];
};
export const lls = (pts: Pt[]): LatLng[] => pts.map(ll);
const lonlat = (p: Pt) => {
  const { lat, lon } = toLatLon(p);
  return [lon, lat];
};
const ringOf = (pts: Pt[]) => {
  const c = pts.map(lonlat);
  c.push(c[0]!);
  return [c];
};

type FC = { type: "FeatureCollection"; name: string; features: unknown[] };
const fc = (name: string, features: unknown[]): FC => ({ type: "FeatureCollection", name, features });

/* ---------------------------------------------------------- mine boundary */

const BOUNDARY_PTS: Pt[] = [
  [24, 750],
  [16, 590],
  [56, 330],
  [214, 92],
  [520, 26],
  [830, 34],
  [986, 118],
  [988, 296],
  [872, 470],
  [762, 668],
  [520, 754],
];

export const mineBoundary: LatLng[] = lls(BOUNDARY_PTS);
export const mineBoundaryGeoJSON = fc("mine_boundary", [
  {
    type: "Feature",
    properties: { name: "MINEGUARD Mine Safety Area (simulated lease boundary)" },
    geometry: { type: "Polygon", coordinates: ringOf(BOUNDARY_PTS) },
  },
]);

/* ----------------------------------------------------------------- benches */

export const benchRings = benches.map((b) => ({
  benchId: b.benchId,
  name: b.name,
  elevation: b.elevation,
  ring: lls(b.polygon),
}));

/** Highwall crest arc along the north rim of the pit. */
export const highwall: LatLng[] = lls(arcPoints(438, 308, 196, 344, 40));

export const benchesGeoJSON = fc(
  "benches",
  benches.map((b) => ({
    type: "Feature",
    properties: { benchId: b.benchId, name: b.name, elevation: b.elevation },
    geometry: { type: "Polygon", coordinates: ringOf(b.polygon) },
  })),
);

/* ------------------------------------------------------------------- roads */

export type RoadLine = {
  roadId: string;
  roadName: string;
  speedLimit: number;
  roadWidth: number;
  elevation: number;
  riskLevel: string;
  direction: string;
  path: LatLng[];
};

const ROAD_DIRECTION: Record<string, string> = {
  R01: "TWO-WAY",
  R02: "CLOCKWISE LOOP",
  R03: "CLOCKWISE LOOP",
  R04: "TWO-WAY RAMP",
  R05: "TWO-WAY",
  R06: "TWO-WAY",
};

export const roadLines: RoadLine[] = roads.map((r) => ({
  roadId: r.roadId,
  roadName: r.roadName,
  speedLimit: r.speedLimit,
  roadWidth: r.roadWidth,
  elevation: r.elevation,
  riskLevel: r.riskLevel,
  direction: ROAD_DIRECTION[r.roadId] ?? "TWO-WAY",
  path: lls(r.points),
}));

export const roadsGeoJSON = fc(
  "roads",
  roadLines.map((r) => ({
    type: "Feature",
    properties: {
      roadId: r.roadId,
      roadName: r.roadName,
      speedLimit: r.speedLimit,
      roadWidth: r.roadWidth,
      elevation: r.elevation,
      riskLevel: r.riskLevel,
      direction: r.direction,
    },
    geometry: { type: "LineString", coordinates: roads.find((x) => x.roadId === r.roadId)!.points.map(lonlat) },
  })),
);

/* ------------------------------------------------------------ blind curves */

export const blindCurvePoints = blindCurves.map((c) => ({ ...c, ll: ll(c.pos) }));
export const blindCurvesGeoJSON = fc(
  "blind_curves",
  blindCurves.map((c) => ({
    type: "Feature",
    properties: {
      curveId: c.curveId,
      curveName: c.curveName,
      roadId: c.roadId,
      riskLevel: c.riskLevel,
      recommendedSpeed: c.recommendedSpeed,
      warningDistance: c.warningDistance,
    },
    geometry: { type: "Point", coordinates: lonlat(c.pos) },
  })),
);

/* -------------------------------------------------------------- risk zones */

/** Elliptical zones converted to real polygons so they overlay satellite imagery. */
export const riskZonePolys = riskZones.map((z) => ({
  ...z,
  ring: lls(arcPoints(z.rx, z.ry, 0, 360, 48, z.center)),
}));

export const riskZonesGeoJSON = fc(
  "risk_zones",
  riskZonePolys.map((z) => ({
    type: "Feature",
    properties: { zoneId: z.zoneId, zoneType: z.zoneType, riskLevel: z.riskLevel, description: z.description },
    geometry: { type: "Polygon", coordinates: ringOf(arcPoints(z.rx, z.ry, 0, 360, 48, z.center)) },
  })),
);

export const restrictedPolys = restrictedZones.map((z) => ({ ...z, ring: lls(z.polygon) }));
export const restrictedGeoJSON = fc(
  "restricted_areas",
  restrictedZones.map((z) => ({
    type: "Feature",
    properties: { id: z.id, name: z.name },
    geometry: { type: "Polygon", coordinates: ringOf(z.polygon) },
  })),
);

/* --------------------------------------------------- loading / dump / site */

export const areaPolys = siteAreas.map((a) => ({
  ...a,
  ll: ll(a.center),
  ring: lls(arcPoints(a.rx, a.ry, 0, 360, 36, a.center)),
}));

const areaFeature = (kind: string) =>
  siteAreas
    .filter((a) => a.kind === kind)
    .map((a) => ({
      type: "Feature",
      properties: { areaId: a.areaId, name: a.name, kind: a.kind, status: a.status },
      geometry: { type: "Polygon", coordinates: ringOf(arcPoints(a.rx, a.ry, 0, 360, 36, a.center)) },
    }));

export const loadingAreasGeoJSON = fc("loading_areas", areaFeature("LOADING"));
export const dumpAreasGeoJSON = fc("dump_areas", areaFeature("DUMPING"));

/* ------------------------------------------------------- RSUs / checkpoints */

export const rsuPoints = rsus.map((r) => ({ ...r, ll: ll(r.pos), rangeM: r.range * 2 }));
export const rsusGeoJSON = fc(
  "rsus",
  rsus.map((r) => ({
    type: "Feature",
    properties: { rsuId: r.rsuId, name: r.name, rangeMetres: r.range * 2 },
    geometry: { type: "Point", coordinates: lonlat(r.pos) },
  })),
);

export const checkpointPoints = checkpoints.map((c) => ({ ...c, ll: ll(c.pos) }));
export const checkpointsGeoJSON = fc(
  "checkpoints",
  checkpoints.map((c) => ({
    type: "Feature",
    properties: { cpId: c.cpId, name: c.name },
    geometry: { type: "Point", coordinates: lonlat(c.pos) },
  })),
);

export const slopePoints = steepSlopes.map((s) => ({ ...s, ll: ll(s.pos) }));

/* ------------------------------------------------------ location hierarchy */

export type Place = {
  id: string;
  name: string;
  level: "COUNTRY" | "STATE" | "DISTRICT" | "RANGE" | "MINE" | "SAFETY";
  center: LatLng;
  zoom: number;
  crumb: string[];
};

export const MINE_CENTER: LatLng = ll([500, 370]);

export const places: Place[] = [
  { id: "india", name: "India", level: "COUNTRY", center: [22.4, 79.0], zoom: 4, crumb: ["INDIA"] },
  {
    id: "chhattisgarh",
    name: "Chhattisgarh",
    level: "STATE",
    center: [21.28, 81.87],
    zoom: 7,
    crumb: ["INDIA", "CHHATTISGARH"],
  },
  {
    id: "dantewada",
    name: "Dantewada Region",
    level: "DISTRICT",
    center: [18.9, 81.35],
    zoom: 10,
    crumb: ["INDIA", "CHHATTISGARH", "DANTEWADA"],
  },
  {
    id: "bailadila",
    name: "Bailadila Range",
    level: "RANGE",
    center: [18.68, 81.23],
    zoom: 12,
    crumb: ["INDIA", "CHHATTISGARH", "DANTEWADA", "BAILADILA"],
  },
  {
    id: "mine",
    name: "Bailadila Iron Ore Mining Region",
    level: "MINE",
    center: MINE_CENTER,
    zoom: 15,
    crumb: ["INDIA", "CHHATTISGARH", "BAILADILA", "MINING REGION"],
  },
  {
    id: "mineguard",
    name: "MINEGUARD Mine Safety Area",
    level: "SAFETY",
    center: MINE_CENTER,
    zoom: 16,
    crumb: ["INDIA", "CHHATTISGARH", "BAILADILA", "MINEGUARD SAFETY AREA"],
  },
];

export function crumbForZoom(z: number): string[] {
  if (z < 6) return ["INDIA"];
  if (z < 9) return ["INDIA", "CHHATTISGARH"];
  if (z < 11.5) return ["INDIA", "CHHATTISGARH", "DANTEWADA"];
  if (z < 14) return ["INDIA", "CHHATTISGARH", "DANTEWADA", "BAILADILA"];
  if (z < 15.5) return ["INDIA", "CHHATTISGARH", "BAILADILA", "MINING REGION"];
  return ["INDIA", "CHHATTISGARH", "BAILADILA", "MINEGUARD SAFETY AREA"];
}

/** Zoom thresholds that gate which MINEGUARD layers are drawn. */
export const ZOOM = {
  region: 11,
  mine: 13,
  safety: 14.5,
  vehicleDetail: 16.5,
  roadLabels: 15,
};

/** Every MINEGUARD dataset in one bundle — the offline hand-off format. */
export const mineguardGeoJSON = {
  mine_boundary: mineBoundaryGeoJSON,
  benches: benchesGeoJSON,
  roads: roadsGeoJSON,
  blind_curves: blindCurvesGeoJSON,
  risk_zones: riskZonesGeoJSON,
  restricted_areas: restrictedGeoJSON,
  loading_areas: loadingAreasGeoJSON,
  dump_areas: dumpAreasGeoJSON,
  rsus: rsusGeoJSON,
  checkpoints: checkpointsGeoJSON,
};
