import L from "leaflet";
import type { RiskLevel } from "@/lib/mine/data";

/** Basemap tile sources. Satellite imagery is the visual foundation. */
export const BASEMAPS = {
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    maxNativeZoom: 18,
  },
  terrain: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
    attribution: "Hillshade © Esri",
    maxNativeZoom: 16,
  },
  labels: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    attribution: "Labels © Esri",
    maxNativeZoom: 18,
  },
};

export const RISK_HEX: Record<RiskLevel, string> = {
  HIGH: "#ef3f3f",
  MEDIUM: "#f08a2c",
  CAUTION: "#e7c22b",
  SAFE: "#3ec98a",
};

export function riskHex(r: string) {
  return RISK_HEX[(r as RiskLevel) ?? "SAFE"] ?? RISK_HEX.SAFE;
}

/** Professional top-down haul-truck marker, oriented to GPS heading. */
export function truckIcon(opts: {
  id: string;
  heading: number;
  risk: RiskLevel;
  size?: number;
  selected?: boolean;
  showLabel?: boolean;
  rotate?: number;
}) {
  const size = opts.size ?? 34;
  const color = riskHex(opts.risk);
  const rot = opts.heading + (opts.rotate ?? 0);
  const alarm = opts.risk === "HIGH";
  const html = `
  <div style="position:relative;width:${size}px;height:${size}px;">
    <div style="position:absolute;inset:0;transform:rotate(${rot}deg);transform-origin:50% 50%;">
      <svg viewBox="0 0 40 40" width="${size}" height="${size}">
        <g ${alarm ? 'class="pulse-alarm"' : ""}>
          <circle cx="20" cy="20" r="18" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-opacity="0.55" stroke-width="1"/>
        </g>
        <path d="M20 3 L25 11 L15 11 Z" fill="${color}"/>
        <rect x="12" y="11" width="16" height="20" rx="2.5" fill="#11161c" stroke="${color}" stroke-width="2"/>
        <rect x="14.5" y="13.5" width="11" height="6" rx="1" fill="${color}" fill-opacity="0.85"/>
        <rect x="14.5" y="21" width="11" height="8" rx="1" fill="${color}" fill-opacity="0.35"/>
        <rect x="9.5" y="13" width="3" height="6" rx="1" fill="#0b0e12"/>
        <rect x="27.5" y="13" width="3" height="6" rx="1" fill="#0b0e12"/>
        <rect x="9.5" y="23" width="3" height="6" rx="1" fill="#0b0e12"/>
        <rect x="27.5" y="23" width="3" height="6" rx="1" fill="#0b0e12"/>
      </svg>
    </div>
    ${
      opts.showLabel
        ? `<div style="position:absolute;top:${size}px;left:50%;transform:translateX(-50%);white-space:nowrap;font:600 10px/1.2 'JetBrains Mono',monospace;letter-spacing:.08em;color:${color};background:rgba(8,12,16,.78);border:1px solid ${color}55;padding:1px 4px;border-radius:2px;">${opts.id}</div>`
        : ""
    }
  </div>`;
  return L.divIcon({
    html,
    className: `mineguard-marker${opts.selected ? " mineguard-marker-selected" : ""}`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Small square glyph marker used for RSUs, checkpoints, curves, areas. */
export function glyphIcon(glyph: string, color: string, label?: string, size = 22) {
  return L.divIcon({
    html: `<div style="display:flex;flex-direction:column;align-items:center;">
      <div style="width:${size}px;height:${size}px;display:grid;place-items:center;border:1px solid ${color};background:rgba(8,12,16,.8);border-radius:3px;color:${color};font:600 ${Math.round(size * 0.55)}px/1 'Barlow',sans-serif;">${glyph}</div>
      ${label ? `<div style="margin-top:2px;white-space:nowrap;font:500 9px/1.2 'JetBrains Mono',monospace;letter-spacing:.08em;color:#cfd6de;background:rgba(8,12,16,.72);padding:1px 3px;border-radius:2px;">${label}</div>` : ""}
    </div>`,
    className: "mineguard-marker",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}
