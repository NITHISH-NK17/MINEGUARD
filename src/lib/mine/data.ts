/**
 * Local mine dataset for MINEGUARD.
 *
 * SIMULATION DATA — this is a realistic *fictional* open-cast iron-ore layout
 * inspired by the visual characteristics of the Bailadila range in
 * Chhattisgarh. It is NOT an official NMDC / Bailadila survey map.
 *
 * Everything here is generated offline from local application data and is
 * exported as GeoJSON (see `mineGeoJSON`) so the map works with no internet
 * connection and no external tile / map provider.
 */

import {
  arcPoints,
  benchPolygon,
  pathLength,
  pointAt,
  spiralPoints,
  toLatLon,
  type Pt,
} from "./geo";

export type RiskLevel = "HIGH" | "MEDIUM" | "CAUTION" | "SAFE";

/* ------------------------------------------------------------------ benches */

export type Bench = {
  benchId: string;
  name: string;
  rx: number;
  ry: number;
  elevation: number;
  polygon: Pt[];
};

const BENCH_SPEC = [
  { benchId: "BL01", name: "Upper Bench", rx: 430, ry: 302, elevation: 1080 },
  { benchId: "BL02", name: "Upper-Mid Bench", rx: 352, ry: 246, elevation: 1035 },
  { benchId: "BL03", name: "Middle Bench", rx: 274, ry: 190, elevation: 990 },
  { benchId: "BL04", name: "Lower Bench", rx: 196, ry: 134, elevation: 945 },
  { benchId: "BL05", name: "Pit Floor", rx: 118, ry: 78, elevation: 900 },
];

export const benches: Bench[] = BENCH_SPEC.map((b, i) => ({
  ...b,
  polygon: benchPolygon(b.rx, b.ry, i * 5),
}));

/** Ground elevation (m AMSL) at a planar point, from the bench terrace it sits on. */
export function elevationAt(p: Pt): number {
  for (let i = benches.length - 1; i >= 0; i--) {
    const b = benches[i]!;
    const k = Math.hypot((p[0] - 500) / b.rx, (p[1] - 370) / b.ry);
    if (k <= 1) return b.elevation;
  }
  return 1125; // undisturbed hill crest outside the pit rim
}

/* -------------------------------------------------------------------- roads */

export type Road = {
  roadId: string;
  roadName: string;
  speedLimit: number; // km/h
  roadWidth: number; // metres
  elevation: number; // m AMSL (mean)
  riskLevel: RiskLevel;
  loop: boolean;
  points: Pt[];
  length: number; // map units
};

function road(r: Omit<Road, "length">): Road {
  return { ...r, length: pathLength(r.points) };
}

export const roads: Road[] = [
  road({
    roadId: "R01",
    roadName: "Main Haul Road",
    speedLimit: 30,
    roadWidth: 24,
    elevation: 1105,
    riskLevel: "MEDIUM",
    loop: false,
    points: [
      [30, 726],
      [110, 712],
      [196, 700],
      [286, 690],
      [368, 676],
      [438, 660],
      [492, 646],
    ],
  }),
  road({
    roadId: "R02",
    roadName: "Upper Bench Road",
    speedLimit: 25,
    roadWidth: 20,
    elevation: 1080,
    riskLevel: "MEDIUM",
    loop: true,
    points: arcPoints(392, 274, 0, 360, 72).slice(0, 72),
  }),
  road({
    roadId: "R03",
    roadName: "Middle Bench Road",
    speedLimit: 20,
    roadWidth: 18,
    elevation: 990,
    riskLevel: "HIGH",
    loop: true,
    points: arcPoints(312, 216, 0, 360, 64).slice(0, 64),
  }),
  road({
    roadId: "R04",
    roadName: "Lower Bench Ramp",
    speedLimit: 15,
    roadWidth: 16,
    elevation: 930,
    riskLevel: "HIGH",
    loop: false,
    points: spiralPoints(240, 166, 96, 62, 205, 585, 60),
  }),
  road({
    roadId: "R05",
    roadName: "Dumping Road",
    speedLimit: 25,
    roadWidth: 20,
    elevation: 1095,
    riskLevel: "MEDIUM",
    loop: false,
    points: [
      [846, 268],
      [872, 236],
      [890, 204],
      [906, 172],
      [922, 140],
      [936, 108],
    ],
  }),
  road({
    roadId: "R06",
    roadName: "Service Road",
    speedLimit: 20,
    roadWidth: 14,
    elevation: 1112,
    riskLevel: "CAUTION",
    loop: false,
    points: [
      [30, 726],
      [62, 686],
      [92, 646],
      [120, 606],
      [146, 570],
      [168, 540],
    ],
  }),
];

export const roadById = (id: string) => roads.find((r) => r.roadId === id)!;

/* ------------------------------------------------------------- blind curves */

export type BlindCurve = {
  curveId: string;
  curveName: string;
  roadId: string;
  t: number; // fraction along road
  riskLevel: RiskLevel;
  recommendedSpeed: number; // km/h
  warningDistance: number; // metres
  pos: Pt;
};

function curve(
  c: Omit<BlindCurve, "pos">,
): BlindCurve {
  const r = roadById(c.roadId);
  return { ...c, pos: pointAt(r.points, r.length * c.t).pos };
}

export const blindCurves: BlindCurve[] = [
  curve({
    curveId: "BC01",
    curveName: "Upper Ramp Curve",
    roadId: "R02",
    t: 0.34,
    riskLevel: "HIGH",
    recommendedSpeed: 12,
    warningDistance: 150,
  }),
  curve({
    curveId: "BC02",
    curveName: "West Switchback",
    roadId: "R02",
    t: 0.56,
    riskLevel: "HIGH",
    recommendedSpeed: 10,
    warningDistance: 160,
  }),
  curve({
    curveId: "BC03",
    curveName: "Middle Bench Curve",
    roadId: "R03",
    t: 0.18,
    riskLevel: "MEDIUM",
    recommendedSpeed: 14,
    warningDistance: 130,
  }),
  curve({
    curveId: "BC04",
    curveName: "Lower Ramp Curve",
    roadId: "R04",
    t: 0.62,
    riskLevel: "HIGH",
    recommendedSpeed: 10,
    warningDistance: 120,
  }),
  curve({
    curveId: "BC05",
    curveName: "Dump Approach Curve",
    roadId: "R05",
    t: 0.45,
    riskLevel: "MEDIUM",
    recommendedSpeed: 15,
    warningDistance: 140,
  }),
];

/* ---------------------------------------------------------------- risk zones */

export type RiskZone = {
  zoneId: string;
  zoneType: string;
  riskLevel: RiskLevel;
  description: string;
  center: Pt;
  rx: number;
  ry: number;
};

export const riskZones: RiskZone[] = [
  {
    zoneId: "DZ01",
    zoneType: "Highwall Risk Zone",
    riskLevel: "HIGH",
    description:
      "Active highwall face on the north rim. Loose rock and overhang failure risk. No stopping within 30 m of the crest; spotter required for all haulage.",
    center: [520, 132],
    rx: 210,
    ry: 52,
  },
  {
    zoneId: "DZ02",
    zoneType: "Blind Curve Risk Zone",
    riskLevel: "HIGH",
    description:
      "West switchback cluster (BC02). Sight distance below 40 m. Horn mandatory, keep left, max 10 km/h. Covered by RSU-02.",
    center: [128, 402],
    rx: 86,
    ry: 96,
  },
  {
    zoneId: "DZ03",
    zoneType: "Steep Ramp Zone",
    riskLevel: "HIGH",
    description:
      "Lower ramp gradient 1:10 descending to the pit floor. Engine braking only, no gear change on grade, 40 m following distance.",
    center: [430, 470],
    rx: 120,
    ry: 76,
  },
  {
    zoneId: "DZ04",
    zoneType: "Dumping Area Risk Zone",
    riskLevel: "MEDIUM",
    description:
      "Waste dump edge with tipping berm. Reverse only under RSU-05 guidance. Edge-of-tip failure risk in wet conditions.",
    center: [922, 118],
    rx: 78,
    ry: 62,
  },
  {
    zoneId: "DZ05",
    zoneType: "Heavy Traffic Zone",
    riskLevel: "MEDIUM",
    description:
      "Main haul road / service road junction near the mine entrance. Highest vehicle interaction density in the lease. Give way to loaded dumpers.",
    center: [190, 700],
    rx: 150,
    ry: 46,
  },
];

/* -------------------------------------------------------------- steep slopes */

export type SteepSlope = {
  slopeId: string;
  name: string;
  gradient: string;
  pos: Pt;
  rotation: number;
};

export const steepSlopes: SteepSlope[] = [
  { slopeId: "SS01", name: "North Highwall Slope", gradient: "1:6", pos: [520, 186], rotation: 0 },
  { slopeId: "SS02", name: "South Ramp Slope", gradient: "1:10", pos: [446, 512], rotation: 180 },
];

/* --------------------------------------------------- loading / dumping areas */

export type SiteArea = {
  areaId: string;
  name: string;
  kind: "LOADING" | "DUMPING" | "SERVICE" | "ENTRANCE";
  status: string;
  center: Pt;
  rx: number;
  ry: number;
};

export const siteAreas: SiteArea[] = [
  {
    areaId: "LA01",
    name: "Ore Loading Zone",
    kind: "LOADING",
    status: "LOADING ORE — SHOVEL 02 ACTIVE",
    center: [470, 386],
    rx: 84,
    ry: 50,
  },
  {
    areaId: "DA01",
    name: "Waste / Dump Zone",
    kind: "DUMPING",
    status: "TIPPING WASTE — REVERSE UNDER GUIDANCE",
    center: [930, 104],
    rx: 62,
    ry: 48,
  },
  {
    areaId: "MS01",
    name: "Maintenance & Service Bay",
    kind: "SERVICE",
    status: "SERVICE BAY",
    center: [172, 536],
    rx: 58,
    ry: 38,
  },
  {
    areaId: "EN01",
    name: "Mine Entrance",
    kind: "ENTRANCE",
    status: "AT MINE ENTRANCE",
    center: [34, 728],
    rx: 34,
    ry: 26,
  },
];

/* --------------------------------------------------------- restricted zones */

export type Restricted = { id: string; name: string; polygon: Pt[] };

export const restrictedZones: Restricted[] = [
  {
    id: "RZ01",
    name: "Blasting Zone — No Entry",
    polygon: [
      [648, 546],
      [790, 500],
      [842, 566],
      [742, 632],
      [636, 606],
    ],
  },
  {
    id: "RZ02",
    name: "Highwall Crest — No Entry",
    polygon: [
      [332, 96],
      [700, 88],
      [712, 124],
      [326, 132],
    ],
  },
];

/* ------------------------------------------------------------------- RSUs */

export type RSU = { rsuId: string; name: string; pos: Pt; range: number };

export const rsus: RSU[] = [
  { rsuId: "RSU-01", name: "Mine Entrance", pos: [96, 700], range: 130 },
  { rsuId: "RSU-02", name: "West Switchback (BC02)", pos: [122, 356], range: 140 },
  { rsuId: "RSU-03", name: "Upper Ramp Curve (BC01)", pos: [318, 616], range: 130 },
  { rsuId: "RSU-04", name: "Ore Loading Zone", pos: [418, 336], range: 120 },
  { rsuId: "RSU-05", name: "Dump Approach", pos: [886, 176], range: 130 },
];

/* ------------------------------------------------------------- checkpoints */

export type Checkpoint = { cpId: string; name: string; pos: Pt };

export const checkpoints: Checkpoint[] = [
  { cpId: "CP01", name: "Mine Entrance", pos: [64, 716] },
  { cpId: "CP02", name: "Upper Bench", pos: [658, 610] },
  { cpId: "CP03", name: "Middle Bench", pos: [770, 288] },
  { cpId: "CP04", name: "Lower Bench", pos: [388, 452] },
  { cpId: "CP05", name: "Dump Area", pos: [908, 190] },
];

/* --------------------------------------------------------------- vehicles */

export type VehicleSpec = {
  vehicleId: string;
  label: string;
  roadId: string;
  startT: number;
  dir: 1 | -1;
  payload: string;
};

export const vehicleSpecs: VehicleSpec[] = [
  { vehicleId: "V01", label: "Mining Dumper", roadId: "R02", startT: 0.2, dir: 1, payload: "Loaded — Iron Ore" },
  { vehicleId: "V02", label: "Mining Dumper", roadId: "R02", startT: 0.56, dir: -1, payload: "Empty" },
  { vehicleId: "V03", label: "Mining Dumper", roadId: "R03", startT: 0.1, dir: 1, payload: "Loaded — Iron Ore" },
  { vehicleId: "V04", label: "Mining Dumper", roadId: "R04", startT: 0.3, dir: 1, payload: "Empty" },
];

/* -------------------------------------------------------------- GeoJSON out */

function ring(pts: Pt[]) {
  const coords = pts.map((p) => {
    const { lat, lon } = toLatLon(p);
    return [lon, lat];
  });
  coords.push(coords[0]!);
  return [coords];
}

function line(pts: Pt[]) {
  return pts.map((p) => {
    const { lat, lon } = toLatLon(p);
    return [lon, lat];
  });
}

function point(p: Pt) {
  const { lat, lon } = toLatLon(p);
  return [lon, lat];
}

/**
 * The whole mine as a single offline GeoJSON FeatureCollection.
 * Kept in sync with the objects above — this is the hand-off format for
 * swapping the simulator for live ESP32 GPS + a real survey layer.
 */
export const mineGeoJSON = {
  type: "FeatureCollection" as const,
  name: "MINEGUARD Simulated Open-Cast Mine (fictional, Bailadila-inspired)",
  features: [
    ...benches.map((b) => ({
      type: "Feature" as const,
      properties: { kind: "bench", benchId: b.benchId, name: b.name, elevation: b.elevation },
      geometry: { type: "Polygon" as const, coordinates: ring(b.polygon) },
    })),
    ...roads.map((r) => ({
      type: "Feature" as const,
      properties: {
        kind: "haul_road",
        roadId: r.roadId,
        roadName: r.roadName,
        speedLimit: r.speedLimit,
        roadWidth: r.roadWidth,
        elevation: r.elevation,
        riskLevel: r.riskLevel,
      },
      geometry: { type: "LineString" as const, coordinates: line(r.points) },
    })),
    ...blindCurves.map((c) => ({
      type: "Feature" as const,
      properties: {
        kind: "blind_curve",
        curveId: c.curveId,
        roadId: c.roadId,
        riskLevel: c.riskLevel,
        recommendedSpeed: c.recommendedSpeed,
        warningDistance: c.warningDistance,
      },
      geometry: { type: "Point" as const, coordinates: point(c.pos) },
    })),
    ...riskZones.map((z) => ({
      type: "Feature" as const,
      properties: {
        kind: "risk_zone",
        zoneId: z.zoneId,
        zoneType: z.zoneType,
        riskLevel: z.riskLevel,
        description: z.description,
      },
      geometry: { type: "Point" as const, coordinates: point(z.center) },
    })),
    ...restrictedZones.map((z) => ({
      type: "Feature" as const,
      properties: { kind: "restricted_zone", id: z.id, name: z.name },
      geometry: { type: "Polygon" as const, coordinates: ring(z.polygon) },
    })),
    ...rsus.map((r) => ({
      type: "Feature" as const,
      properties: { kind: "rsu", rsuId: r.rsuId, name: r.name, range: r.range },
      geometry: { type: "Point" as const, coordinates: point(r.pos) },
    })),
    ...checkpoints.map((c) => ({
      type: "Feature" as const,
      properties: { kind: "checkpoint", cpId: c.cpId, name: c.name },
      geometry: { type: "Point" as const, coordinates: point(c.pos) },
    })),
    ...siteAreas.map((a) => ({
      type: "Feature" as const,
      properties: { kind: a.kind.toLowerCase(), areaId: a.areaId, name: a.name },
      geometry: { type: "Point" as const, coordinates: point(a.center) },
    })),
  ],
};
