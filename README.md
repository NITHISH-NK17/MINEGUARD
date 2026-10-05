# MINEGUARD — Mine Safety Control Room

MINEGUARD is a mine-vehicle safety dashboard for low-visibility open-cast mining environments.

## Features

- Live vehicle telemetry from ESP32 / edge devices
- RTK GNSS position and accuracy display
- IMU telemetry
- Vehicle breadcrumb trails
- V2V / proximity risk evaluation
- Blind-curve and hazard warnings
- Offline-first mine map support
- QGIS/GeoJSON map import
- RSU telemetry support
- Live telemetry export as JSON/CSV

## Tech stack

- React + TypeScript
- TanStack Start / Router
- Tailwind CSS
- Leaflet / React Leaflet
- Three.js / React Three Fiber
- Vite

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite.

## Production build

```bash
npm run build
npm run preview
```

## Live vehicle telemetry

The dashboard can receive vehicle telemetry through:

- WebSocket from an ESP32/gateway
- HTTP telemetry endpoint

The expected payload contains fields such as:

```json
{
  "vehicleId": "V01",
  "latitude": 18.676,
  "longitude": 81.214,
  "altitude": 1042,
  "speed": 24,
  "heading": 135,
  "gpsAccuracy": 0.02,
  "fixType": "RTK_FIXED",
  "satellites": 21,
  "connectionStatus": "ONLINE",
  "imu": {
    "ax": 0,
    "ay": 0,
    "az": 9.81,
    "gx": 0,
    "gy": 0,
    "gz": 0
  }
}
```

Do not put real Wi-Fi passwords, API keys, private credentials, or device secrets into the repository.

## GitHub

This repository is source code only. Do not commit `node_modules`, build output, local environment files, or private credentials.
