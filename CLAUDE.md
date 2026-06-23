# CLAUDE.md — Project Context for Claude Code

## What This Is

**VeloQuest** — a Linux-native (portable to macOS/Windows) open-source cycling trainer app.
Connects to a smart trainer via Bluetooth LE, guides the rider along a real-world GPX route
with automatic grade simulation, and reveals landmark photos as milestones are reached.

Think: Tacx app, but open source, subscription-free, and with cinematic milestone moments.

## Architecture

```
BLE Trainer (FTMS)
        │
        ▼
Python Backend  (asyncio + aiohttp)
  ├── ble/ftms.py       — bleak FTMS client
  ├── engine/route.py   — GPX + elevation + grade
  └── ws/server.py      — WebSocket broadcast
        │
        │  ws://localhost:8765
        ▼
React Frontend  (Vite)
  └── components/TrainerMap.jsx  ← PROTOTYPE (start here)
        │
        ▼
pywebview  (optional native window — GTK/WebKit on Linux)
```

## Key Decisions Already Made — Don't Revisit Without Discussion

- **BLE via `bleak`** — asyncio-native, same API on Linux/macOS/Windows
- **Simulation mode, not ERG** — sends grade% to trainer (not fixed watts); rider effort varies naturally
- **OSM + Leaflet** for maps — free, no API key required
- **OpenTopoData** for elevation — free, SRTM data, no key, queried in batch before ride starts
- **Routes are pre-loaded** — full elevation profile fetched and cached as JSON sidecar before riding; no live API calls mid-ride
- **GPX** as the route file format
- **pywebview** as the native window shell — ~10MB, uses OS WebView (not Electron)
- **WebSocket** between Python and React — thin JSON protocol, ~4Hz telemetry

## The Milestone Mechanic (Core UI — Approved)

`frontend/src/components/TrainerMap.jsx` is the locked prototype. The interaction is:

1. Milestone thumbnails sit on the map at their route positions
2. As rider approaches (within ~12% of route), thumbnail grows smoothly
3. On arrival, the panel **scales out from the thumbnail position** (not a slide)
4. Full-bleed landmark photo fills the panel, dark overlay at bottom with name + fact + countdown
5. Auto-dismisses after 15s, or tap to dismiss early
6. Thumbnail stays on map, marked completed (greyscale + ✓)

Do not replace this mechanic. Iterate on it.

## Directory Structure

```
veloquest/
├── CLAUDE.md                  ← you are here
├── README.md
├── NEXT_STEPS.md
├── .gitignore
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── components/
│       │   └── TrainerMap.jsx     ← main UI: map, HUD, milestone reveals
│       └── hooks/
│           ├── useWebSocket.js    ← WebSocket connection + telemetry parsing
│           └── useRoute.js        ← route state management
├── backend/
│   ├── main.py                    ← asyncio entry point
│   ├── requirements.txt
│   ├── ble/
│   │   └── ftms.py                ← FTMS client (bleak)
│   ├── engine/
│   │   ├── route.py               ← GPX loading, elevation, grade
│   │   └── milestone.py           ← milestone proximity (check_by_route_dist)
│   └── ws/
│       └── server.py              ← aiohttp WebSocket server
├── rides/
│   └── paris-seine/
│       ├── route.gpx
│       ├── route.elevation.json   ← generated at first ride load; delete to refresh
│       └── milestones.json        ← landmark definitions with distKm values
└── tools/
    └── update_ride.py             ← recalculate milestone distances after route change
```

## Running the Frontend (Prototype / No Backend Needed)

```bash
cd frontend
npm install
npm run dev
# Visit http://localhost:5173
# Uses simulated telemetry — no BLE, no backend required
```

## Running the Full Stack

```bash
# Terminal 1 — backend (auto-discovers BLE trainer; falls back to no-trainer mode)
source backend/.venv/bin/activate
python -m backend.main

# Terminal 2 — frontend
cd frontend && npm run dev
```

## Updating a Ride Route

Run this after dropping in a new `route.gpx`:

```bash
source backend/.venv/bin/activate
python tools/update_ride.py rides/<ride-name>
```

What it does:
1. Reads `route.gpx` and computes cumulative waypoint distances
2. Finds the nearest route point for each milestone in `milestones.json`
3. Updates `distKm` in `milestones.json`
4. Warns if any landmark is >200m from the route (proximity trigger risk)
5. Deletes the stale `route.elevation.json` (backend regenerates on next start)

After running, copy the printed `distKm` values into the `MILESTONES` constant in
`frontend/src/components/TrainerMap.jsx` and update the `totalKm` fallback.

## WebSocket Protocol

```json
// Backend → Frontend, ~4Hz
{ "type": "telemetry", "power": 218, "cadence": 88, "hr": 156,
  "speed": 29.4, "grade": 3.2, "riderT": 0.342, "distKm": 6.16 }

// Frontend → Backend
{ "type": "set_resistance_mode", "mode": "simulation" }

// Backend → Frontend (event)
{ "type": "milestone_reached", "milestoneId": 2 }
```

## Ride Definition Format

`milestones.json` — one per landmark, distKm computed by `tools/update_ride.py`:

```json
[
  {
    "id": 1,
    "lat": 48.8584, "lng": 2.2945,
    "name": "Eiffel Tower",
    "distKm": 6.176,
    "image": "eiffel.jpg",
    "image_credit": "© Photographer / Wikimedia Commons, CC BY-SA 3.0",
    "image_license": "CC BY-SA 3.0",
    "fact": "Built as a temporary structure for the 1889 World's Fair..."
  }
]
```

## Git Workflow

Commit after every working milestone. Push to GitHub after every commit.

```bash
git add -A
git commit -m "type: short description"
git push origin main
```

Commit types: `feat`, `fix`, `refactor`, `style`, `docs`, `chore`

Examples:
```
feat: add WebSocket hook with auto-reconnect
feat: replace simulated telemetry with live backend feed
feat: swap SVG placeholder map for Leaflet + OSM tiles
fix: milestone reveal not dismissing on timer expiry
refactor: extract grade calculation to pure function
docs: add ride definition format to CLAUDE.md
chore: add .gitignore
```

**Commit often.** Every time a feature works end-to-end, commit before moving on.
Never commit broken code to main. If mid-feature, use a branch.

## Coding Standards

- **Python**: asyncio throughout — no threading. Type hints on all function signatures.
- **React**: functional components + hooks only. No class components.
- **State ownership**: BLE/route/grade state lives in the backend. UI animation/display state lives in React.
- **No hardcoded secrets**: any API keys go in `.env`, never committed. Add `.env` to `.gitignore`.
- **Error handling**: BLE disconnects happen. Handle them gracefully — log, surface to UI, retry.
