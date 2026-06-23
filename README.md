# Passage

An open-source indoor cycling trainer app for Linux (also portable to macOS and Windows).

Connect your smart trainer, load a real-world GPX route, and ride it — with automatic resistance
for hills and cinematic landmark reveals as you pass through places along the way.

> Built as a subscription-free alternative to Tacx/Zwift for riders who own their experience.

---

## Status

Early development — core loop working end-to-end in no-trainer mode.

| Layer | Status |
|-------|--------|
| Milestone reveal UI | ✅ Complete |
| HUD + elevation strip | ✅ Complete |
| Leaflet OSM map | ✅ Complete |
| Route engine (GPX + elevation + grade) | ✅ Complete |
| WebSocket server | ✅ Complete |
| Python BLE / FTMS client | ✅ Complete |
| Ride definition format | ✅ Complete |
| React → WebSocket hook | ✅ Complete |
| Live BLE trainer integration | 🔲 TODO |
| Ride selection screen | 🔲 TODO |
| End-of-ride / postcard wall | 🔲 TODO |

---

## What It Does

- Loads a GPX route and pre-fetches elevation data (OpenTopoData / SRTM)
- Connects to any FTMS-compatible smart trainer via Bluetooth LE
- Sends grade commands to the trainer as you climb and descend the route
- Shows your position on a live OSM map with your route overlaid
- Milestone thumbnails appear on the map and grow as you approach
- On arrival, the landmark photo bursts from the thumbnail into a full reveal panel
- Tracks power, cadence, heart rate, speed, grade, distance, and time

---

## Tech Stack

| | |
|--|--|
| **Frontend** | React 18 + Vite, react-leaflet / Leaflet.js |
| **Backend** | Python 3.11+, asyncio, aiohttp |
| **BLE** | bleak (Linux/macOS/Windows) |
| **Protocol** | Bluetooth LE / FTMS (Fitness Machine Service, UUID 0x1826) |
| **Maps** | OpenStreetMap + Leaflet (no API key) |
| **Elevation** | OpenTopoData — SRTM, free, no key |
| **Route format** | GPX |
| **Native shell** | pywebview (optional — GTK/WebKit on Linux) |

---

## Getting Started

### Prerequisites

- Linux (Ubuntu 22.04+ recommended), macOS, or Windows
- Python 3.11+
- Node.js 20+
- A Bluetooth LE smart trainer with FTMS support (optional — no-trainer mode available)
  - Tested: Tacx (Garmin) trainers
  - Should work: Wahoo, Elite, any FTMS device

### Install

```bash
git clone https://github.com/mitchobr/veloquest.git
cd veloquest

# Frontend
cd frontend && npm install && cd ..

# Backend
python -m venv backend/.venv
source backend/.venv/bin/activate   # Windows: backend\.venv\Scripts\activate
pip install -r backend/requirements.txt
```

### Run (Prototype — No Backend Needed)

```bash
cd frontend && npm run dev
# Visit http://localhost:5173
# Uses simulated telemetry. Use the speed slider to ride the route.
```

### Run (Full Stack — No Trainer)

```bash
# Terminal 1: backend (no-trainer mode — synthetic telemetry at 25 km/h)
source backend/.venv/bin/activate
python backend/main.py

# Terminal 2: frontend
cd frontend && npm run dev
# Visit http://localhost:5173 — connect to backend, use the speed multiplier slider
```

### Run (Full Stack — With Trainer)

```bash
# Power on your FTMS trainer first, then:
source backend/.venv/bin/activate
python backend/main.py   # auto-discovers trainer via BLE scan

cd frontend && npm run dev
```

---

## Rides

Rides live in `rides/<ride-name>/`:

```
rides/paris-seine/
├── route.gpx            — GPX track (from Brouter-web, Komoot, Strava, etc.)
├── milestones.json      — landmark definitions with distKm positions
└── route.elevation.json — elevation + grade cache (auto-generated on first start)
```

Elevation data is fetched from OpenTopoData and cached locally on the first backend start.
Delete `route.elevation.json` to force a re-fetch (e.g., after swapping in a new GPX).

### Updating a Ride Route

After dropping in a new `route.gpx`, run:

```bash
source backend/.venv/bin/activate
python tools/update_ride.py rides/<ride-name>
```

This recalculates each milestone's `distKm` from the new route, warns if any landmark is more
than 200m from the path, writes the updated `milestones.json`, and deletes the stale elevation
cache so it regenerates on the next backend start.

Copy the printed `distKm` values into the `MILESTONES` constant in
`frontend/src/components/TrainerMap.jsx` and update the `totalKm` fallback.

### Getting Routes

Use a real cycling route planner to ensure the path follows actual roads and paths:

- **[Brouter-web](https://brouter.de/brouter-web/)** — free, exports GPX, no account needed
- **[Komoot](https://www.komoot.com/)** — good turn-by-turn directions
- **[Strava Route Builder](https://www.strava.com/routes/new)** — requires free account

---

## Roadmap

See [`NEXT_STEPS.md`](NEXT_STEPS.md) for the full feature backlog.

---

## Project Structure

```
veloquest/
├── frontend/              React + Vite app
│   └── src/
│       ├── components/
│       │   └── TrainerMap.jsx     — main UI (map, HUD, milestone reveals)
│       └── hooks/
│           ├── useWebSocket.js    — WebSocket connection + telemetry
│           └── useRoute.js        — route state management
├── backend/               Python BLE + route engine + WebSocket server
│   ├── main.py            — asyncio entry point
│   ├── ble/ftms.py        — FTMS client (bleak)
│   ├── engine/
│   │   ├── route.py       — GPX loading, elevation fetch, grade calculation
│   │   └── milestone.py   — milestone proximity detection
│   └── ws/server.py       — aiohttp WebSocket server
├── rides/                 Ride definitions (GPX + milestones + elevation cache)
│   └── paris-seine/
├── tools/
│   └── update_ride.py     — recalculate milestone distances after route change
├── CLAUDE.md              AI assistant context (architecture decisions)
├── NEXT_STEPS.md          Feature backlog
└── README.md              This file
```

---

## Contributing

This is a personal portfolio project but PRs are welcome. Open an issue first for anything substantial.

## License

MIT
