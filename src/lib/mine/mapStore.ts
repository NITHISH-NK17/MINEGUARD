/**
 * MINEGUARD map-data module.
 *
 * Holds mine maps (sample + imported QGIS exports) as layered GeoJSON in
 * WGS84 (EPSG:4326). Everything is stored locally in the browser so the
 * system works offline in the pit. This module knows nothing about vehicles,
 * telemetry or risk — those are separate modules.
 *
 * SIMULATION NOTICE: the bundled sample map is a fictional Bailadila-inspired
 * open-cast layout, not an official NMDC survey map.
 */

import { useCallback, useEffect, useState } from "react";
import {
  benchesGeoJSON,
  blindCurvesGeoJSON,
  checkpointsGeoJSON,
  dumpAreasGeoJSON,
  highwall,
  loadingAreasGeoJSON,
  mineBoundaryGeoJSON,
  restrictedGeoJSON,
  riskZonesGeoJSON,
  roadsGeoJSON,
  rsusGeoJSON,
} from "./geojson";

/* -------------------------------------------------------------- GeoJSON */

export type GeoGeometry = {
  type: string;
  coordinates: unknown;
};
export type GeoFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: GeoGeometry | null;
};
export type GeoFC = {
  type: "FeatureCollection";
  name?: string;
  features: GeoFeature[];
};

export const LAYER_KINDS = [
  "MINE_BOUNDARY",
  "BENCHES",
  "HIGHWALLS",
  "ROADS",
  "BLIND_CURVES",
  "RISK_ZONES",
  "RESTRICTED_ZONES",
  "LOADING_AREAS",
  "DUMPING_AREAS",
  "CHECKPOINTS",
  "RSUS",
  "OTHER",
] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

export const LAYER_LABEL: Record<LayerKind, string> = {
  MINE_BOUNDARY: "Mine boundary",
  BENCHES: "Mine benches",
  HIGHWALLS: "Highwalls",
  ROADS: "Haul roads",
  BLIND_CURVES: "Blind curves",
  RISK_ZONES: "Risk zones",
  RESTRICTED_ZONES: "Restricted areas",
  LOADING_AREAS: "Loading areas",
  DUMPING_AREAS: "Dumping areas",
  CHECKPOINTS: "Checkpoints",
  RSUS: "RSUs",
  OTHER: "Other features",
};

export type MapLayer = {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  fc: GeoFC;
};

export type MineMapDoc = {
  id: string;
  name: string;
  createdAt: number;
  source: "SAMPLE" | "IMPORT";
  /** CRS the file was authored in, before reprojection to EPSG:4326 */
  sourceCrs: string;
  note?: string;
  layers: MapLayer[];
};

/** Guess a layer kind from a layer / file name coming out of QGIS. */
export function guessKind(name: string): LayerKind {
  const n = name.toLowerCase();
  const has = (...k: string[]) => k.some((x) => n.includes(x));
  if (has("boundary", "lease", "perimeter")) return "MINE_BOUNDARY";
  if (has("bench")) return "BENCHES";
  if (has("highwall", "wall", "crest")) return "HIGHWALLS";
  if (has("road", "haul", "ramp", "track")) return "ROADS";
  if (has("curve", "blind", "bend")) return "BLIND_CURVES";
  if (has("restricted", "prohibit", "no-go", "nogo", "blast")) return "RESTRICTED_ZONES";
  if (has("risk", "hazard", "danger")) return "RISK_ZONES";
  if (has("load", "shovel", "excavat")) return "LOADING_AREAS";
  if (has("dump", "waste", "tip")) return "DUMPING_AREAS";
  if (has("checkpoint", "gate", "entrance", "entry")) return "CHECKPOINTS";
  if (has("rsu", "roadside", "beacon", "antenna")) return "RSUS";
  return "OTHER";
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function makeLayer(name: string, fc: GeoFC, kind?: LayerKind): MapLayer {
  return { id: uid(), name, kind: kind ?? guessKind(name), visible: true, fc };
}

/* ---------------------------------------------------------- sample map */

const lineFC = (name: string, coords: number[][], props: Record<string, unknown>): GeoFC => ({
  type: "FeatureCollection",
  name,
  features: [{ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } }],
});

/** Fictional Bailadila-inspired demonstration mine (offline, no hardware needed). */
export function buildSampleMap(): MineMapDoc {
  const fc = (x: unknown) => x as GeoFC;
  return {
    id: "sample-bailadila",
    name: "Bailadila Sample Mine",
    createdAt: Date.now(),
    source: "SAMPLE",
    sourceCrs: "EPSG:4326",
    note: "Simulation / prototype — fictional open-cast layout inspired by Bailadila. Not an official NMDC map.",
    layers: [
      makeLayer("Mine boundary", fc(mineBoundaryGeoJSON), "MINE_BOUNDARY"),
      makeLayer("Benches", fc(benchesGeoJSON), "BENCHES"),
      makeLayer(
        "Highwall crest",
        lineFC("highwalls", highwall.map(([la, lo]) => [lo, la]), { name: "North highwall crest" }),
        "HIGHWALLS",
      ),
      makeLayer("Haul roads", fc(roadsGeoJSON), "ROADS"),
      makeLayer("Blind curves", fc(blindCurvesGeoJSON), "BLIND_CURVES"),
      makeLayer("Risk zones", fc(riskZonesGeoJSON), "RISK_ZONES"),
      makeLayer("Restricted areas", fc(restrictedGeoJSON), "RESTRICTED_ZONES"),
      makeLayer("Loading areas", fc(loadingAreasGeoJSON), "LOADING_AREAS"),
      makeLayer("Dumping areas", fc(dumpAreasGeoJSON), "DUMPING_AREAS"),
      makeLayer("Checkpoints", fc(checkpointsGeoJSON), "CHECKPOINTS"),
      makeLayer("RSUs", fc(rsusGeoJSON), "RSUS"),
    ],
  };
}

/* ------------------------------------------------------------- storage */

const KEY = "mineguard.maps.v1";
const ACTIVE = "mineguard.maps.active";

type Store = { maps: MineMapDoc[]; activeId: string | null };

const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function read(): Store {
  if (typeof window === "undefined") return { maps: [], activeId: null };
  try {
    const raw = window.localStorage.getItem(KEY);
    const maps = raw ? (JSON.parse(raw) as MineMapDoc[]) : [];
    return { maps, activeId: window.localStorage.getItem(ACTIVE) };
  } catch {
    return { maps: [], activeId: null };
  }
}

function write(maps: MineMapDoc[], activeId: string | null) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(maps));
    if (activeId) window.localStorage.setItem(ACTIVE, activeId);
    else window.localStorage.removeItem(ACTIVE);
  } catch {
    /* quota — map stays in memory for this session */
  }
  emit();
}

/** React binding for the map library. Client-only (localStorage backed). */
export function useMineMaps() {
  const [store, setStore] = useState<Store>({ maps: [], activeId: null });

  useEffect(() => {
    const sync = () => setStore(read());
    sync();
    subs.add(sync);
    return () => {
      subs.delete(sync);
    };
  }, []);

  const saveMap = useCallback((doc: MineMapDoc, activate = true) => {
    const s = read();
    const maps = [doc, ...s.maps.filter((m) => m.id !== doc.id)];
    write(maps, activate ? doc.id : s.activeId);
    return doc.id;
  }, []);

  const deleteMap = useCallback((id: string) => {
    const s = read();
    const maps = s.maps.filter((m) => m.id !== id);
    write(maps, s.activeId === id ? (maps[0]?.id ?? null) : s.activeId);
  }, []);

  const renameMap = useCallback((id: string, name: string) => {
    const s = read();
    write(
      s.maps.map((m) => (m.id === id ? { ...m, name } : m)),
      s.activeId,
    );
  }, []);

  const setActive = useCallback((id: string | null) => {
    const s = read();
    write(s.maps, id);
  }, []);

  const setLayerVisible = useCallback((mapId: string, layerId: string, visible: boolean) => {
    const s = read();
    write(
      s.maps.map((m) =>
        m.id === mapId
          ? { ...m, layers: m.layers.map((l) => (l.id === layerId ? { ...l, visible } : l)) }
          : m,
      ),
      s.activeId,
    );
  }, []);

  const loadSample = useCallback(() => {
    const doc = buildSampleMap();
    const s = read();
    const maps = [doc, ...s.maps.filter((m) => m.id !== doc.id)];
    write(maps, doc.id);
    return doc.id;
  }, []);

  const active = store.maps.find((m) => m.id === store.activeId) ?? null;

  return {
    maps: store.maps,
    active,
    activeId: store.activeId,
    saveMap,
    deleteMap,
    renameMap,
    setActive,
    setLayerVisible,
    loadSample,
  };
}

/* ------------------------------------------------------------- helpers */

/** Bounding box [minLat, minLon, maxLat, maxLon] of every visible layer. */
export function mapBounds(doc: MineMapDoc | null): [[number, number], [number, number]] | null {
  if (!doc) return null;
  let minLat = 90;
  let minLon = 180;
  let maxLat = -90;
  let maxLon = -180;
  let any = false;
  const walk = (c: unknown) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const lon = c[0] as number;
      const lat = c[1] as number;
      any = true;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      return;
    }
    for (const x of c) walk(x);
  };
  for (const l of doc.layers) for (const f of l.fc.features) walk(f.geometry?.coordinates);
  if (!any) return null;
  return [
    [minLat, minLon],
    [maxLat, maxLon],
  ];
}

export function featureCount(doc: MineMapDoc) {
  return doc.layers.reduce((n, l) => n + l.fc.features.length, 0);
}
