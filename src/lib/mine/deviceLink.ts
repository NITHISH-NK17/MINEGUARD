/**
 * MINEGUARD device link.
 *
 * Owns the connection to the physical prototype vehicle:
 *
 *   RTK GNSS + IMU + wheel encoder (+ radar / camera)
 *      -> ESP32 / edge device
 *      -> HTTP POST  /api/public/vehicle/telemetry   (MINEGUARD ingest, polled)
 *         or WebSocket  ws://<device-or-gateway>/telemetry  (direct stream)
 *      -> telemetry bus -> live fleet -> mine map + risk engine
 *
 * Only the transport lives here. Nothing in this module invents movement:
 * if the device stops transmitting, the link simply reports no packets.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { connectEsp32WebSocket, connectHttpPolling, telemetryBus } from "./telemetry";

export type Transport = "HTTP" | "WS";

export type DeviceConfig = {
  transport: Transport;
  /** Endpoint polled for HTTP transport (the MINEGUARD ingest endpoint by default). */
  httpUrl: string;
  /** WebSocket URL of the ESP32 or the mine-network gateway. */
  wsUrl: string;
  pollMs: number;
  /** Optional shared secret, matching MINEGUARD_TELEMETRY_KEY on the server. */
  deviceKey: string;
};

export const DEFAULT_DEVICE_CONFIG: DeviceConfig = {
  transport: "HTTP",
  httpUrl: "/api/public/vehicle/telemetry",
  wsUrl: "ws://192.168.4.1:81",
  pollMs: 1000,
  deviceKey: "",
};

const CFG_KEY = "mineguard.device.v1";

export function loadDeviceConfig(): DeviceConfig {
  if (typeof window === "undefined") return DEFAULT_DEVICE_CONFIG;
  try {
    const raw = window.localStorage.getItem(CFG_KEY);
    return raw ? { ...DEFAULT_DEVICE_CONFIG, ...(JSON.parse(raw) as Partial<DeviceConfig>) } : DEFAULT_DEVICE_CONFIG;
  } catch {
    return DEFAULT_DEVICE_CONFIG;
  }
}

export function saveDeviceConfig(cfg: DeviceConfig) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* storage unavailable — config stays in memory for this session */
  }
}

export type LinkState = "IDLE" | "CONNECTING" | "RECEIVING" | "NO_DATA" | "ERROR";

/**
 * Starts the configured transport while `enabled` is true and reports link
 * health: packets received, packet rate, and time since the last packet.
 */
export function useDeviceLink(enabled: boolean, cfg: DeviceConfig) {
  const [packets, setPackets] = useState(0);
  const [lastAt, setLastAt] = useState(0);
  const [transportOk, setTransportOk] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const recent = useRef<number[]>([]);
  const [rate, setRate] = useState(0);

  // Count only packets received from the live transport.
  useEffect(() => {
    if (!enabled) return;
    return telemetryBus.subscribe((p) => {
      if (p.source === "SIMULATION") return;
      setPackets((n) => n + 1);
      setLastAt(Date.now());
      recent.current.push(Date.now());
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setTransportOk(null);
      return;
    }
    if (cfg.transport === "WS") {
      if (!cfg.wsUrl) return;
      return connectEsp32WebSocket(cfg.wsUrl, (s) => setTransportOk(s === "OPEN"));
    }
    return connectHttpPolling(Math.max(200, cfg.pollMs), {
      url: cfg.httpUrl || DEFAULT_DEVICE_CONFIG.httpUrl,
      ...(cfg.deviceKey ? { deviceKey: cfg.deviceKey } : {}),
      onState: (s) => setTransportOk(s === "OK"),
    });
  }, [enabled, cfg.transport, cfg.wsUrl, cfg.httpUrl, cfg.pollMs, cfg.deviceKey]);

  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      recent.current = recent.current.filter((x) => t - x < 5000);
      setRate(recent.current.length / 5);
      setNow(t);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const secondsSince = lastAt ? (now - lastAt) / 1000 : null;

  const state: LinkState = useMemo(() => {
    if (!enabled) return "IDLE";
    if (transportOk === false) return "ERROR";
    if (secondsSince === null) return "CONNECTING";
    return secondsSince < 5 ? "RECEIVING" : "NO_DATA";
  }, [enabled, transportOk, secondsSince]);

  const reset = () => {
    setPackets(0);
    setLastAt(0);
    recent.current = [];
  };

  return { state, packets, rate, secondsSince, reset };
}

/** Ready-to-flash reference sketch for the prototype vehicle's ESP32. */
export function esp32Sketch(endpoint: string, deviceKey: string) {
  return `// MINEGUARD vehicle node - ESP32 reference sketch
// RTK GNSS (UART) + IMU + wheel encoder -> MINEGUARD telemetry endpoint
#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "MINE-NETWORK";
const char* WIFI_PASS = "********";
const char* ENDPOINT  = "${endpoint}";
const char* DEVICE_KEY = "${deviceKey || ""}";   // must match MINEGUARD_TELEMETRY_KEY
const char* VEHICLE_ID = "V01";

void postTelemetry(double lat, double lon, double alt, double speedKmh,
                   double heading, double accuracyM, const char* fixType,
                   int sats, double encoderM,
                   float ax, float ay, float az, float gx, float gy, float gz) {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.begin(ENDPOINT);
  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_KEY)) http.addHeader("x-mineguard-key", DEVICE_KEY);

  char body[512];
  snprintf(body, sizeof(body),
    "{\\"vehicleId\\":\\"%s\\",\\"latitude\\":%.7f,\\"longitude\\":%.7f,"
    "\\"altitude\\":%.2f,\\"speed\\":%.2f,\\"heading\\":%.1f,"
    "\\"gpsAccuracy\\":%.3f,\\"fixType\\":\\"%s\\",\\"satellites\\":%d,"
    "\\"encoderDistance\\":%.2f,\\"connectionStatus\\":\\"ONLINE\\","
    "\\"imu\\":{\\"ax\\":%.3f,\\"ay\\":%.3f,\\"az\\":%.3f,\\"gx\\":%.3f,\\"gy\\":%.3f,\\"gz\\":%.3f}}",
    VEHICLE_ID, lat, lon, alt, speedKmh, heading, accuracyM, fixType, sats,
    encoderM, ax, ay, az, gx, gy, gz);

  http.POST((uint8_t*)body, strlen(body));
  http.end();
}

// gpsAccuracy is reported in METRES, exactly as the RTK receiver reports it
// (e.g. 0.02 = 2 cm). fixType: RTK_FIXED | RTK_FLOAT | DGPS | SINGLE | NO_FIX.
// Send at 2-5 Hz while moving.
`;
}
