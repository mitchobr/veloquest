# Next Steps & Feature Backlog

Ordered by dependency — earlier items unlock later ones.

---

## ✅ Done — Core Infrastructure

- [x] Ride definition format (GPX + milestones.json — see CLAUDE.md)
- [x] GPX file loading and parsing (`gpxpy`)
- [x] Pre-ride elevation fetch — OpenTopoData, paginated (max 100 pts/request)
- [x] Elevation smoothing — Savitzky-Golay filter, ~250m window
- [x] Grade calculation from smoothed elevation profile
- [x] Grade capping at ±20% before sending to trainer
- [x] Elevation + grade cache as `route.elevation.json`
- [x] Milestone `distKm` calculation — `tools/update_ride.py` (run after any route change)
- [x] BLE scanner — FTMS service UUID discovery, Tacx/Garmin preference
- [x] FTMS reader — Indoor Bike Data (`0x2AD2`): power, cadence, speed
- [x] FTMS writer — Simulation Parameter (grade) via Control Point (`0x2AD9`)
- [x] `useWebSocket.js` hook — connect to backend, auto-reconnect, parse telemetry
- [x] Leaflet + OSM map — replaced SVG placeholder
- [x] Route polyline (completed = amber, upcoming = muted grey)
- [x] Rider position — 60fps interpolated Leaflet marker with smooth pan
- [x] Milestone thumbnails — lat/lng markers, grow on approach, greyscale+✓ when done
- [x] Milestone reveal — full-viewport modal, scales out from thumbnail, auto-dismisses 15s
- [x] Milestone detection — route-distance comparison (robust for off-path landmarks)
- [x] WebSocket server — aiohttp, 4Hz telemetry, milestone events
- [x] No-trainer mode — synthetic telemetry with speed multiplier

---

## 🔴 MVP — Remaining

### BLE / Trainer
- [ ] Heart rate monitor support (separate BLE device, HR Service `0x180D`)
- [ ] Graceful BLE reconnect on disconnect — retry with backoff, surface status to UI
- [ ] Trainer status indicator in HUD (connected / searching / disconnected)

### Ride Loading UI
- [ ] Ride selection screen — list available rides from `rides/` directory
- [ ] Pre-load indicator — show elevation fetch progress before ride starts
- [ ] Route preview on load — map + elevation profile + milestone list

### Known UI Bugs
- [ ] Milestone reveal countdown not ticking in live mode (RAF `r.playing` doesn't track `livePlaying`)
- [ ] Interface capped at ~680px — `maxWidth: MW` needs to fill viewport

---

## 🟡 V1 Polish — Should-Have

### Map Enhancements
- [ ] **Gradient coloring on route ahead** — green → yellow → red by grade severity
- [ ] **Lookahead bias** — map viewport sits slightly ahead of rider position
- [ ] Compass + scale indicator on map

### Milestone System
- [ ] Local image loading — photos in `rides/<name>/images/`, served via aiohttp static + Vite proxy
- [ ] Image attribution in reveal panel — `image_credit` field from milestones.json (field already defined)
- [ ] Configurable approach threshold (default ~12% of route) and reveal duration (default 15s)
- [ ] Dismiss animation — panel shrinks back into thumbnail (reverse of burst-out)

### End-of-Ride Experience
- [ ] Ride complete screen
- [ ] **Postcard wall** — all reached milestone photos arranged as a travel collage with route overlay
- [ ] Stats in a travel-journal aesthetic (distance, elevation gained, avg power, time)
- [ ] Export postcard as PNG image (shareable)

### Ride Definition Tooling
- [x] `tools/update_ride.py` — recalculates milestone distKm after route change; warns on off-path landmarks
- [ ] Simple web-based route editor (Leaflet map — click to place milestones, add name/fact/photo)

---

## 🟢 V2 — Nice-to-Have

### Engagement & Motivation
- [ ] **Suffering index gauge** — composite of time at threshold + HR zone + current grade
- [ ] **Personal records per route** — honest, not gamified
- [ ] **Route library** — browse saved rides; "world tour" meta-goal
- [ ] **"Surprise me" mode** — random route from library
- [ ] **Ambient sound design** — background audio matching route character, wind-speed effect

### Map
- [ ] Satellite / hybrid tile layer toggle (Mapbox or ESRI — requires API key, opt-in)
- [ ] Map zoom adapts — wider on long flat sections, tighter on technical climbs

### Milestone Reveals
- [ ] "Passport stamp" collectibles panel
- [ ] Ambient sound during reveal
- [ ] Micro-story text — 2-3 curated sentences per landmark

### Ride Modes
- [ ] **ERG mode** — hold fixed target wattage; structured workout support
- [ ] **Free ride** — no route, manual grade/resistance control
- [ ] **Workout import** — ZWO format or simple interval CSV

### Weather Cosmetics
- [ ] Pull current weather via Open-Meteo (free API)
- [ ] Light rain overlay if raining at the real location
- [ ] Temperature display ("It's 12°C in Paris right now")

---

## 🔵 Platform & Distribution

- [ ] **macOS port** — bleak + pywebview both support it; minimal code changes expected
- [ ] **Windows port** — bleak uses WinRT on Windows 10+
- [ ] pywebview packaging — proper desktop app, no terminal visible
- [ ] GitHub release with pre-built binary (PyInstaller)
- [ ] **ANT+ support** — USB dongle + `openant`; same `FTMSClient` interface, different transport
- [ ] CI/CD — GitHub Actions: lint + type-check on push, test on PR

---

## Architecture Notes

### Elevation pre-load sequence
1. User selects a ride
2. Parse GPX waypoints (`gpxpy`)
3. Batch-query OpenTopoData — max 100 points per request, paginate
4. Apply Savitzky-Golay smoothing to elevation array
5. Compute grade at each waypoint, cap at ±20%
6. Cache as `route.elevation.json` alongside the GPX
7. Mark ride as ready — show preview map with elevation profile and milestone list

### BLE scan strategy (Linux / BlueZ)
- Trainer must be powered on and in broadcast mode
- Scan for devices advertising FTMS service UUID `00001826-0000-1000-8000-00805f9b34fb`
- First match on known manufacturer (Garmin/Tacx) → auto-connect
- Multiple matches → show picker with device name + signal strength
- On connection: subscribe to Indoor Bike Data notify, send Fitness Machine Control Point to request control

### WebSocket cadence
- Telemetry: 4Hz (every 250ms) — sufficient for smooth UI
- Grade commands to trainer: send only on change, debounced, threshold Δ > 0.1%
- Milestone events: fire-once when crossing proximity threshold

### Milestone proximity
- Uses route-distance comparison: `|rider_t − milestone.distKm / total_km| < arrival_frac`
- Default `arrival_frac = 0.025` — roughly ±400m on a 16km route
- Chosen over haversine because landmarks may be 200-400m off the actual path
  (e.g., Louvre is 311m from the nearest waypoint on the Paris route)
- After reveal dismissed: mark as done, never re-trigger
- Implemented in `backend/engine/milestone.py` → `check_by_route_dist()`

### Ride format
- Milestone images should be stored locally (not remote URLs) for offline use
- Consider a zip-based ride bundle format: `paris-seine.ride` = GPX + milestones.json + images/
- Elevation cache sits alongside the GPX in the ride directory (delete to force refresh)

### Route update workflow
When a new `route.gpx` is dropped in:
1. `source backend/.venv/bin/activate`
2. `python tools/update_ride.py rides/<ride-name>`
3. Review output — check nearest-waypoint distances, investigate any WARN entries
4. Copy the printed `distKm` values into `TrainerMap.jsx` MILESTONES and update `totalKm` fallback
5. Restart the backend — elevation cache was deleted and will re-fetch on start
