# Passage

An open-source indoor cycling trainer app for Linux (also portable to macOS and Windows).

Connect your smart trainer, load a real-world route, and ride it — with automatic resistance
for hills and cinematic landmark reveals as you pass through places along the way.

> Built as a subscription-free alternative to Tacx/Zwift for riders who own their experience.

---

## Status

🚧 **Early prototype** — milestone reveal mechanic approved, backend in progress

| Layer | Status |
|-------|--------|
| Milestone reveal UI | ✅ Prototype complete |
| HUD + elevation strip | ✅ Prototype complete |
| React → WebSocket hook | 🔲 TODO |
| Leaflet map integration | 🔲 TODO |
| Python BLE / FTMS client | 🔲 TODO |
| Route engine (GPX + elevation) | 🔲 TODO |
| WebSocket server | 🔲 TODO |
| Ride definition format | 🔲 TODO |

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
| **Frontend** | React 18 + Vite, Leaflet.js |
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
- A Bluetooth LE smart trainer with FTMS support
  - Tested: Tacx (Garmin) trainers
  - Should work: Wahoo, Elite, any FTMS device

### Install

```bash
git clone https://github.com/YOUR_USERNAME/passage.git
cd passage

# Frontend
cd frontend && npm install && cd ..

# Backend
pip install -r backend/requirements.txt
```

### Run (Prototype — No Trainer Needed)

```bash
cd frontend
npm run dev
# Visit http://localhost:5173
```

The prototype runs with simulated telemetry. Use the speed slider to
ride the route and trigger milestone reveals.

### Run (Full Stack)

```bash
# Terminal 1: start backend (connects to trainer via BLE)
cd backend && python main.py

# Terminal 2: start frontend
cd frontend && npm run dev
```

---

## Rides

Rides are defined by a GPX file plus a `milestones.json`. See `rides/paris-seine/` for an example.
Elevation data is fetched from OpenTopoData and cached locally the first time a ride is loaded.

---

## Roadmap

See [`NEXT_STEPS.md`](NEXT_STEPS.md) for the full feature backlog.

---

## Project Structure

```
passage/
├── frontend/          React + Vite app
├── backend/           Python BLE + route engine + WebSocket server
├── rides/             Ride definitions (GPX + milestones)
├── CLAUDE.md          AI assistant context (architecture decisions, git workflow)
├── NEXT_STEPS.md      Feature backlog
└── README.md          This file
```

---

## Contributing

This is a personal portfolio project but PRs are welcome. Open an issue first for anything substantial.

## License

MIT
