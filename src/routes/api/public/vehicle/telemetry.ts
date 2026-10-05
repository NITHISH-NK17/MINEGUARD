/**
 * MINEGUARD vehicle telemetry endpoint.
 *
 * POST /api/public/vehicle/telemetry
 *   Called by the ESP32 / edge device on the mine network with one JSON
 *   telemetry packet (or an array of packets).
 *
 * GET /api/public/vehicle/telemetry
 *   Returns the latest packet per vehicle, which the MINEGUARD client polls.
 *   This is the HTTP transport; a WebSocket or MQTT bridge can publish onto
 *   the same client-side telemetry bus later without any UI change.
 *
 * Packets are held in edge memory only (no PII, no database) so the endpoint
 * stays usable offline in the pit. An optional shared secret can be enforced
 * with the MINEGUARD_TELEMETRY_KEY environment variable.
 */

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const imuSchema = z.object({
  ax: z.number(),
  ay: z.number(),
  az: z.number(),
  gx: z.number(),
  gy: z.number(),
  gz: z.number(),
});

const packetSchema = z.object({
  vehicleId: z.string().min(1).max(24),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().optional(),
  speed: z.number().optional(),
  heading: z.number().optional(),
  distanceTravelled: z.number().optional(),
  timestamp: z.number().optional(),
  gpsAccuracy: z.number().optional(),
  fixType: z.enum(["RTK_FIXED", "RTK_FLOAT", "DGPS", "SINGLE", "NO_FIX"]).optional(),
  satellites: z.number().optional(),
  connectionStatus: z.enum(["ONLINE", "DEGRADED", "OFFLINE"]).optional(),
  imu: imuSchema.nullable().optional(),
  encoderDistance: z.number().optional(),
});

type Packet = z.infer<typeof packetSchema> & { receivedAt: number; source: "LIVE" };

const latest = new Map<string, Packet>();
const MAX_AGE_MS = 60_000;

function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [k, v] of latest) if (v.receivedAt < cutoff) latest.delete(k);
}

export const Route = createFileRoute("/api/public/vehicle/telemetry")({
  server: {
    handlers: {
      GET: async () => {
        prune();
        return Response.json(
          { vehicles: Array.from(latest.values()), serverTime: Date.now() },
          { headers: { "cache-control": "no-store" } },
        );
      },
      POST: async ({ request }) => {
        const key = process.env["MINEGUARD_TELEMETRY_KEY"];
        if (key && request.headers.get("x-mineguard-key") !== key) {
          return new Response("Unauthorized", { status: 401 });
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
        }
        const list = Array.isArray(body) ? body : [body];
        const accepted: string[] = [];
        for (const raw of list) {
          const parsed = packetSchema.safeParse(raw);
          if (!parsed.success) continue;
          latest.set(parsed.data.vehicleId, { ...parsed.data, receivedAt: Date.now(), source: "LIVE" });
          accepted.push(parsed.data.vehicleId);
        }
        if (!accepted.length) {
          return Response.json({ ok: false, error: "No valid telemetry packets" }, { status: 400 });
        }
        prune();
        return Response.json({ ok: true, accepted, serverTime: Date.now() });
      },
    },
  },
});
