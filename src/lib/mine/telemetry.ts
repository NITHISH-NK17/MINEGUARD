/**
 * MINEGUARD telemetry interface layer.
 *
 * The UI never talks to the simulator directly — it consumes `VehicleTelemetry`
 * packets published on this bus. Today the packets come from the built-in
 * simulator or the demo generator; tomorrow they can come from an ESP32 edge
 * device (RTK GNSS + IMU + wheel encoder + optional mmWave radar / camera)
 * over HTTP POST, WebSocket, or MQTT with no UI changes.
 *
 * Hardware chain the software is designed for:
 *   RTK GNSS + IMU + Wheel encoder (+ radar / camera)
 *      -> ESP32 / edge device
 *      -> Vehicle telemetry (JSON)
 *      -> MINEGUARD telemetry bus
 *      -> Live mine map + risk engine
 *
 * Expected ESP32 JSON payload:
 * {
 *   "vehicleId": "V01", "latitude": 18.676, "longitude": 81.214,
 *   "altitude": 1042, "speed": 24, "heading": 135, "distanceTravelled": 1820,
 *   "timestamp": 1736412345678, "gpsAccuracy": 0.02, "fixType": "RTK_FIXED",
 *   "satellites": 21, "connectionStatus": "ONLINE",
 *   "imu": { "ax":0,"ay":0,"az":9.81,"gx":0,"gy":0,"gz":0 },
 *   "encoderDistance": 1818.4
 * }
 *
 * ACCURACY NOTE: `gpsAccuracy` is whatever the hardware reports (metres).
 * MINEGUARD never invents an accuracy figure and never claims millimetre-level
 * absolute positioning from ordinary GNSS.
 */

export type FixType = "RTK_FIXED" | "RTK_FLOAT" | "DGPS" | "SINGLE" | "NO_FIX";
export type ConnectionStatus = "ONLINE" | "DEGRADED" | "OFFLINE";

export type ImuSample = {
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
};

export type VehicleTelemetry = {
  vehicleId: string;
  latitude: number;
  longitude: number;
  /** metres above mean sea level, as reported by the receiver */
  altitude: number;
  speed: number; // km/h
  heading: number; // degrees, 0 = north
  /** cumulative distance travelled in metres (fused GNSS + encoder) */
  distanceTravelled: number;
  timestamp: number;
  /** horizontal position accuracy in METRES, exactly as reported by hardware */
  gpsAccuracy: number;
  fixType: FixType;
  satellites: number;
  connectionStatus: ConnectionStatus;
  imu: ImuSample | null;
  /** wheel-encoder relative distance in metres */
  encoderDistance: number;
  /** legacy/simulator sensor availability flags */
  elevation: number;
  gps: boolean;
  radar: boolean;
  v2v: boolean;
  /** SIMULATION = generated in-app, LIVE = received from real hardware */
  source: "SIMULATION" | "DEMO" | "LIVE";
};

export type TelemetryListener = (packet: VehicleTelemetry) => void;

const listeners = new Set<TelemetryListener>();

export const telemetryBus = {
  subscribe(fn: TelemetryListener) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  publish(packet: VehicleTelemetry) {
    for (const fn of listeners) fn(packet);
  },
};

const FIXES: FixType[] = ["RTK_FIXED", "RTK_FLOAT", "DGPS", "SINGLE", "NO_FIX"];

/** Validate an untrusted payload coming off the wire (HTTP / WS / MQTT). */
export function parseTelemetry(raw: unknown): VehicleTelemetry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const lat = num(o["latitude"]);
  const lon = num(o["longitude"]);
  if (typeof o["vehicleId"] !== "string" || lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const imuRaw = o["imu"];
  let imu: ImuSample | null = null;
  if (imuRaw && typeof imuRaw === "object") {
    const i = imuRaw as Record<string, unknown>;
    imu = {
      ax: num(i["ax"]) ?? 0,
      ay: num(i["ay"]) ?? 0,
      az: num(i["az"]) ?? 0,
      gx: num(i["gx"]) ?? 0,
      gy: num(i["gy"]) ?? 0,
      gz: num(i["gz"]) ?? 0,
    };
  }

  const fix = typeof o["fixType"] === "string" && FIXES.includes(o["fixType"] as FixType)
    ? (o["fixType"] as FixType)
    : "SINGLE";
  const conn = o["connectionStatus"];
  const altitude = num(o["altitude"]) ?? num(o["elevation"]) ?? 0;
  const src = o["source"];

  return {
    vehicleId: o["vehicleId"],
    latitude: lat,
    longitude: lon,
    altitude,
    elevation: altitude,
    speed: num(o["speed"]) ?? 0,
    heading: num(o["heading"]) ?? 0,
    distanceTravelled: num(o["distanceTravelled"]) ?? num(o["encoderDistance"]) ?? 0,
    timestamp: num(o["timestamp"]) ?? Date.now(),
    gpsAccuracy: num(o["gpsAccuracy"]) ?? 0,
    fixType: fix,
    satellites: Math.max(0, Math.round(num(o["satellites"]) ?? 0)),
    connectionStatus:
      conn === "OFFLINE" || conn === "DEGRADED" || conn === "ONLINE" ? conn : "ONLINE",
    imu,
    encoderDistance: num(o["encoderDistance"]) ?? 0,
    gps: o["gps"] !== false,
    radar: o["radar"] !== false,
    v2v: o["v2v"] !== false,
    source: src === "LIVE" || src === "DEMO" || src === "SIMULATION" ? src : "LIVE",
  };
}

/** Human label for a GNSS fix type. */
export function fixLabel(fix: FixType) {
  switch (fix) {
    case "RTK_FIXED":
      return "RTK FIXED";
    case "RTK_FLOAT":
      return "RTK FLOAT";
    case "DGPS":
      return "DGPS";
    case "SINGLE":
      return "SINGLE";
    default:
      return "NO FIX";
  }
}

/** Format the accuracy actually reported by the hardware (metres in, cm/m out). */
export function accuracyLabel(metres: number) {
  if (!Number.isFinite(metres) || metres <= 0) return "—";
  if (metres < 1) return `${(metres * 100).toFixed(1)} cm`;
  return `${metres.toFixed(2)} m`;
}

/* ----------------------------------------------------------- transports */

/**
 * Attach a live ESP32 telemetry stream over WebSocket (local mine network).
 * The device may send a single packet or an array of packets per frame.
 * Returns a disconnect function.
 */
export function connectEsp32WebSocket(url: string, onState?: (s: "OPEN" | "CLOSED" | "ERROR") => void) {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      onState?.("ERROR");
      retry = setTimeout(open, 3000);
      return;
    }
    ws.onopen = () => onState?.("OPEN");
    ws.onerror = () => onState?.("ERROR");
    ws.onclose = () => {
      onState?.("CLOSED");
      if (!closed) retry = setTimeout(open, 3000);
    };
    ws.onmessage = (ev) => {
      try {
        const body: unknown = JSON.parse(String(ev.data));
        const list = Array.isArray(body) ? body : [body];
        for (const raw of list) {
          const packet = parseTelemetry(raw);
          if (packet) telemetryBus.publish(packet);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
  };
  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

export type PollOptions = {
  /** Endpoint to read from. Defaults to the built-in MINEGUARD ingest endpoint. */
  url?: string;
  /** Optional shared secret sent as x-mineguard-key (same value the device uses). */
  deviceKey?: string;
  onState?: (s: "OK" | "ERROR") => void;
};

/**
 * HTTP transport: poll the MINEGUARD telemetry endpoint that the ESP32 POSTs to.
 * Drop-in replaceable with the WebSocket / MQTT transport above.
 */
export function connectHttpPolling(intervalMs = 1000, opts: PollOptions = {}) {
  const url = opts.url || "/api/public/vehicle/telemetry";
  let stopped = false;
  const tick = async () => {
    try {
      const res = await fetch(url, {
        cache: "no-store",
        ...(opts.deviceKey ? { headers: { "x-mineguard-key": opts.deviceKey } } : {}),
      });
      if (res.ok) {
        const body = (await res.json()) as { vehicles?: unknown[] };
        const list = Array.isArray(body) ? body : (body.vehicles ?? []);
        for (const raw of list) {
          const packet = parseTelemetry(raw);
          if (packet) telemetryBus.publish(packet);
        }
        opts.onState?.("OK");
      } else {
        opts.onState?.("ERROR");
      }
    } catch {
      opts.onState?.("ERROR");
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
