/**
 * MINEGUARD roadside unit (RSU) telemetry endpoint.
 *
 * POST /api/public/rsu/telemetry
 *   Called by a physical RSU (ESP32 / edge node at the mast) with its status
 *   and the vehicles it currently detects over V2V / radar.
 *
 * GET /api/public/rsu/telemetry
 *   Returns the latest report per RSU for the MINEGUARD client to poll.
 *
 * Reports are held in edge memory only (no database) so the endpoint works on
 * an offline mine network. An optional shared secret can be enforced with the
 * MINEGUARD_TELEMETRY_KEY environment variable.
 */

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const detectionSchema = z.object({
  vehicleId: z.string().min(1).max(24),
  distance: z.number().optional(),
  speed: z.number().optional(),
  rssi: z.number().optional(),
});

const reportSchema = z.object({
  rsuId: z.string().min(1).max(24),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  online: z.boolean().optional(),
  rangeMetres: z.number().optional(),
  vehiclesDetected: z.union([z.array(detectionSchema), z.number()]).optional(),
  message: z.string().max(200).optional(),
  timestamp: z.number().optional(),
});

type Report = z.infer<typeof reportSchema> & { receivedAt: number };

const latest = new Map<string, Report>();
const MAX_AGE_MS = 120_000;

function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [k, v] of latest) if (v.receivedAt < cutoff) latest.delete(k);
}

export const Route = createFileRoute("/api/public/rsu/telemetry")({
  server: {
    handlers: {
      GET: async () => {
        prune();
        return Response.json(
          { rsus: Array.from(latest.values()), serverTime: Date.now() },
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
          const parsed = reportSchema.safeParse(raw);
          if (!parsed.success) continue;
          latest.set(parsed.data.rsuId, { ...parsed.data, receivedAt: Date.now() });
          accepted.push(parsed.data.rsuId);
        }
        if (!accepted.length) {
          return Response.json({ ok: false, error: "No valid RSU reports" }, { status: 400 });
        }
        prune();
        return Response.json({ ok: true, accepted, serverTime: Date.now() });
      },
    },
  },
});
