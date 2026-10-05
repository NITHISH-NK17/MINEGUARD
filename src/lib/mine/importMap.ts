/**
 * QGIS / GIS import module.
 *
 * Parses map files exported from QGIS into MINEGUARD layers, and reprojects
 * their coordinates into WGS84 (EPSG:4326) so live GNSS vehicle positions and
 * imported map geometry always share one coordinate reference system.
 *
 * Supported today: GeoJSON (.geojson/.json), KML (.kml), CSV with coordinate
 * columns. Shapefile / GeoPackage are handled through a documented conversion
 * workflow (export to GeoJSON from QGIS) rather than parsed in the browser.
 */

import { guessKind, makeLayer, type GeoFC, type GeoFeature, type MapLayer, type MineMapDoc } from "./mapStore";

export const CRS_OPTIONS = [
  { id: "EPSG:4326", label: "EPSG:4326 — WGS84 lat/lon (recommended QGIS export)" },
  { id: "EPSG:3857", label: "EPSG:3857 — Web Mercator (metres)" },
  { id: "EPSG:32644", label: "EPSG:32644 — UTM zone 44N / WGS84" },
  { id: "EPSG:32645", label: "EPSG:32645 — UTM zone 45N / WGS84 (Bailadila area)" },
] as const;

export type CrsId = (typeof CRS_OPTIONS)[number]["id"];

/* ------------------------------------------------------- reprojection */

const R = 6378137;

function webMercatorToWgs84(x: number, y: number): [number, number] {
  const lon = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/** Inverse UTM (WGS84 ellipsoid) — northern hemisphere zones. */
function utmToWgs84(easting: number, northing: number, zone: number): [number, number] {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const x = easting - 500000;
  const y = northing;
  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));
  const p1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const ep2 = e2 / (1 - e2);
  const c1 = ep2 * Math.cos(p1) ** 2;
  const t1 = Math.tan(p1) ** 2;
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2);
  const r1 = (a * (1 - e2)) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5;
  const d = x / (n1 * k0);
  const lat =
    p1 -
    ((n1 * Math.tan(p1)) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6) / 720);
  const lon =
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5) / 120) /
    Math.cos(p1);
  const lonDeg = (zone - 1) * 6 - 180 + 3 + (lon * 180) / Math.PI;
  return [lonDeg, (lat * 180) / Math.PI];
}

/** Project a single [x, y] pair from `crs` to [lon, lat] WGS84. */
export function toWgs84(x: number, y: number, crs: string): [number, number] {
  if (crs === "EPSG:3857") return webMercatorToWgs84(x, y);
  if (crs === "EPSG:32644") return utmToWgs84(x, y, 44);
  if (crs === "EPSG:32645") return utmToWgs84(x, y, 45);
  return [x, y];
}

function reprojectCoords(c: unknown, crs: string): unknown {
  if (!Array.isArray(c)) return c;
  if (typeof c[0] === "number" && typeof c[1] === "number") {
    const [lon, lat] = toWgs84(c[0] as number, c[1] as number, crs);
    return c.length > 2 ? [lon, lat, c[2]] : [lon, lat];
  }
  return c.map((x) => reprojectCoords(x, crs));
}

export function reprojectFC(fc: GeoFC, crs: string): GeoFC {
  if (crs === "EPSG:4326") return fc;
  return {
    ...fc,
    features: fc.features.map((f) => ({
      ...f,
      geometry: f.geometry ? { ...f.geometry, coordinates: reprojectCoords(f.geometry.coordinates, crs) } : null,
    })),
  };
}

/** Coordinates outside lat/lon range mean the file is projected, not WGS84. */
export function looksProjected(fc: GeoFC): boolean {
  let flagged = false;
  const walk = (c: unknown) => {
    if (flagged || !Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      if (Math.abs(c[0] as number) > 180 || Math.abs(c[1] as number) > 90) flagged = true;
      return;
    }
    for (const x of c) walk(x);
  };
  for (const f of fc.features) walk(f.geometry?.coordinates);
  return flagged;
}

/* ------------------------------------------------------------ parsers */

function splitByGeoJsonLayers(name: string, fc: GeoFC): MapLayer[] {
  // A single QGIS export can contain several thematic layers distinguished by
  // a "layer" / "type" / "category" property. Split on it when present.
  const keyed = new Map<string, GeoFeature[]>();
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const raw = p["layer"] ?? p["Layer"] ?? p["category"] ?? p["featureType"];
    const key = typeof raw === "string" && raw.trim() ? raw.trim() : "";
    const list = keyed.get(key) ?? [];
    list.push(f);
    keyed.set(key, list);
  }
  if (keyed.size <= 1) return [makeLayer(fc.name ?? name, fc)];
  return Array.from(keyed.entries()).map(([k, features]) =>
    makeLayer(k || name, { type: "FeatureCollection", name: k || name, features }),
  );
}

function parseGeoJson(name: string, text: string): MapLayer[] {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (data["type"] === "FeatureCollection") return splitByGeoJsonLayers(name, data as unknown as GeoFC);
  if (data["type"] === "Feature")
    return [
      makeLayer(name, { type: "FeatureCollection", name, features: [data as unknown as GeoFeature] }),
    ];
  if (data["type"] === "GeometryCollection" || typeof data["coordinates"] !== "undefined")
    return [
      makeLayer(name, {
        type: "FeatureCollection",
        name,
        features: [{ type: "Feature", properties: {}, geometry: data as unknown as GeoFeature["geometry"] }],
      }),
    ];
  // GeoPackage-style JSON bundle: { layerName: FeatureCollection, ... }
  const out: MapLayer[] = [];
  for (const [k, v] of Object.entries(data)) {
    const fc = v as GeoFC;
    if (fc && fc.type === "FeatureCollection") out.push(makeLayer(k, fc, guessKind(k)));
  }
  if (!out.length) throw new Error("No GeoJSON features found in this file.");
  return out;
}

function kmlCoords(text: string): number[][] {
  return text
    .trim()
    .split(/\s+/)
    .map((tok) => tok.split(",").map(Number))
    .filter((c) => c.length >= 2 && Number.isFinite(c[0]!) && Number.isFinite(c[1]!))
    .map((c) => [c[0]!, c[1]!]);
}

function parseKml(name: string, text: string): MapLayer[] {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const features: GeoFeature[] = [];
  for (const pm of Array.from(doc.getElementsByTagName("Placemark"))) {
    const props: Record<string, unknown> = {
      name: pm.getElementsByTagName("name")[0]?.textContent ?? "",
      description: pm.getElementsByTagName("description")[0]?.textContent ?? "",
    };
    for (const d of Array.from(pm.getElementsByTagName("SimpleData"))) {
      const k = d.getAttribute("name");
      if (k) props[k] = d.textContent ?? "";
    }
    const point = pm.getElementsByTagName("Point")[0];
    const line = pm.getElementsByTagName("LineString")[0];
    const poly = pm.getElementsByTagName("Polygon")[0];
    if (point) {
      const c = kmlCoords(point.getElementsByTagName("coordinates")[0]?.textContent ?? "")[0];
      if (c) features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });
    } else if (line) {
      const c = kmlCoords(line.getElementsByTagName("coordinates")[0]?.textContent ?? "");
      if (c.length) features.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: c } });
    } else if (poly) {
      const c = kmlCoords(poly.getElementsByTagName("coordinates")[0]?.textContent ?? "");
      if (c.length) features.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [c] } });
    }
  }
  if (!features.length) throw new Error("No placemarks found in this KML file.");
  return [makeLayer(name, { type: "FeatureCollection", name, features })];
}

function parseCsv(name: string, text: string): MapLayer[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("CSV needs a header row and at least one coordinate row.");
  const delim = (lines[0]!.match(/;/g)?.length ?? 0) > (lines[0]!.match(/,/g)?.length ?? 0) ? ";" : ",";
  const head = lines[0]!.split(delim).map((h) => h.trim().toLowerCase());
  const findCol = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const latI = findCol("lat", "latitude", "y", "northing");
  const lonI = findCol("lon", "lng", "long", "longitude", "x", "easting");
  if (latI < 0 || lonI < 0) throw new Error("CSV must contain latitude/longitude (or x/y) columns.");
  const features: GeoFeature[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(delim);
    const lat = Number(cells[latI]);
    const lon = Number(cells[lonI]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const props: Record<string, unknown> = {};
    head.forEach((h, i) => {
      if (i !== latI && i !== lonI) props[h] = cells[i]?.trim() ?? "";
    });
    features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lon, lat] } });
  }
  if (!features.length) throw new Error("No valid coordinate rows found in the CSV.");
  return [makeLayer(name, { type: "FeatureCollection", name, features })];
}

export type ParsedImport = {
  layers: MapLayer[];
  suggestedCrs: CrsId;
  warning?: string;
};

/** Parse a QGIS export into MINEGUARD layers (still in its source CRS). */
export async function parseMapFile(file: File): Promise<ParsedImport> {
  const lower = file.name.toLowerCase();
  const base = file.name.replace(/\.[^.]+$/, "");

  if (/\.(shp|dbf|shx|gpkg|zip|kmz)$/.test(lower)) {
    throw new Error(
      `${lower.split(".").pop()!.toUpperCase()} files are imported through a conversion step: in QGIS use Layer → Export → Save Features As… → GeoJSON (EPSG:4326), then upload that file here.`,
    );
  }

  const text = await file.text();
  let layers: MapLayer[];
  if (/\.(kml|xml)$/.test(lower)) layers = parseKml(base, text);
  else if (lower.endsWith(".csv")) layers = parseCsv(base, text);
  else layers = parseGeoJson(base, text);

  const projected = layers.some((l) => looksProjected(l.fc));
  return {
    layers,
    suggestedCrs: projected ? "EPSG:32645" : "EPSG:4326",
    ...(projected
      ? {
          warning:
            "Coordinates are outside latitude/longitude range — this file looks projected. Pick the CRS it was authored in so MINEGUARD can reproject it to WGS84.",
        }
      : {}),
  };
}

/** Finalise an import: reproject every layer to WGS84 and build the map doc. */
export function buildImportedMap(name: string, layers: MapLayer[], crs: string): MineMapDoc {
  return {
    id: `map-${Date.now().toString(36)}`,
    name,
    createdAt: Date.now(),
    source: "IMPORT",
    sourceCrs: crs,
    layers: layers.map((l) => ({ ...l, fc: reprojectFC(l.fc, crs) })),
  };
}
