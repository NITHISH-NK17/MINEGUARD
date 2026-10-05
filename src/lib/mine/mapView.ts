/**
 * Browser-safe map view contracts and legend.
 *
 * Kept out of the Leaflet component so pages can import these types and the
 * legend without pulling Leaflet (a browser-only library) into the SSR graph.
 */

import type { RiskLevel } from "./data";
import type { LayerKind } from "./mapStore";

export type MapCmd = { type: "ZOOM_IN" | "ZOOM_OUT" | "RESET" | "FIT"; n: number } | null;

export type MapVehicle = {
  vehicleId: string;
  latitude: number;
  longitude: number;
  heading: number;
  speed: number;
  risk: RiskLevel;
  accuracy: number;
  trail: [number, number][];
  lost?: boolean;
};

export type FeatureInfo = {
  kind: LayerKind;
  title: string;
  props: Record<string, unknown>;
};

export const LEGEND: { swatch: string; label: string; color: string }[] = [
  { swatch: "▬", label: "Safe road", color: "#3ec98a" },
  { swatch: "▬", label: "Medium risk road", color: "#e7c22b" },
  { swatch: "▬", label: "High risk road", color: "#ef3f3f" },
  { swatch: "⚠", label: "Blind curve", color: "#f08a2c" },
  { swatch: "▦", label: "Restricted zone", color: "#c24bd8" },
  { swatch: "🚛", label: "Mining vehicle", color: "#e6edf5" },
  { swatch: "📡", label: "RSU", color: "#5ad1ff" },
  { swatch: "📍", label: "Checkpoint", color: "#e7c22b" },
  { swatch: "⛏", label: "Loading area", color: "#3ec98a" },
  { swatch: "⬇", label: "Dumping area", color: "#4aa3e2" },
];


/** Roadside unit drawn on the map (geometry from the map, status from telemetry). */
export type MapRsuMarker = {
  rsuId: string;
  name: string;
  latitude: number;
  longitude: number;
  rangeMetres: number;
  status: "ONLINE" | "OFFLINE" | "NO_SIGNAL";
  detections: { vehicleId: string; distance: number }[];
};
