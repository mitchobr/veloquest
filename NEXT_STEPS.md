# Next Steps & Feature Backlog

Captured from initial design session. Ordered by dependency — earlier items unlock later ones.

---

## 🔴 MVP — Core Loop

### Route System
- [ ] Decide final ride definition format (GPX + milestones.json — see CLAUDE.md for draft schema)
- [ ] GPX file loading and parsing (`gpxpy`)
- [ ] Pre-ride elevation fetch — query OpenTopoData for all route waypoints, paginated (max 100 pts/request)
- [ ] Elevation smoothing — apply Savitzky-Golay filter (`scipy.signal.savgol_filter`) to remove SRTM noise; window ~250m, poly order 2
- [ ] Grade calculation from smoothed elevation profile
- [ ] Grade capping at ±20% before sending to trainer (hardware limit)
- [ ] Cache elevation + grade profile as `[ride-name].elevation.json` — ride is fully offline after first load
- [ ] Milestone distance calculation from lat/lng (Haversine), not route-t

### BLE / Trainer
- [ ] BLE scanner — discover FTMS devices (service UUID `0x1826`), auto-connect to first Tacx/Garmin found, show picker if ambiguous
- [ ] FTMS reader — subscribe to Indoor Bike Data characteristic (`0x2AD2`): power, cadence, speed
- [ ] FTMS writer — send Simulation Parameter (slope/grade) via Control Point (`0x2AD9`)
- [ ] Heart rate monitor support (separate BLE device, HR Service `0x180D`)
- [ ] Graceful BLE reconnect on disconnect — retry with backoff, surface status to UI
- [ ] Trainer status indicator in HUD (connected / searching / disconnected)

### Frontend → Live Data
- [ ] `useWebSocket.js` hook — connect to backend, auto-reconnect, parse telemetry messages
- [ ] Replace simulated riderT + stats in `TrainerMap.jsx` with live WebSocket feed
- [ ] Replace SVG placeholder map with Leaflet + OSM tiles
- [ ] Rider position as real lat/lng marker on Leaflet map
- [ ] Route rendered as polyline on Leaflet map (completed = amber, upcoming = muted grey)
- [ ] Milestone positions as lat/lng markers on Leaflet map (not SVG coordinate system)

### Ride Loading UI
- [ ] Ride selection screen — list available rides from `rides/` directory
- [ ] Pre-load indicator — show elevation fetch progress before ride starts
- [ ] Route preview on load — map + elevation profile + milestone list

---

## 🟡 V1 Polish — Should-Have

### Map Enhancements
- [ ] **Gradient coloring on route ahead** — green → yellow → red by grade severity, so you can see pain coming
- [ ] **Lookahead bias** — map viewport sits slightly ahead of rider position (not centered on rider)
- [ ] Completed route rendered in amber, upcoming in muted grey (already in prototype — carry to Leaflet)
- [ ] Compass + scale indicator on map

### Milestone System
- [ ] Local image loading — milestone photos stored in ride directory, loaded at ride start (not remote URLs)
- [ ] Milestone proximity via real lat/lng distance (replaces route-t approximation)
- [ ] Configurable approach threshold (default 500m) and reveal duration (default 15s)

### End-of-Ride Experience
- [ ] Ride complete screen
- [ ] **Postcard wall** — all reached milestone photos arranged as a travel collage with route overlay
- [ ] Stats in a travel-journal aesthetic (distance, elevation gained, avg power, time)
- [ ] Export postcard as PNG image (shareable)
- [ ] Strava GPX export of the completed ride track

### Ride Definition Tooling
- [ ] CLI tool: `passage add-ride route.gpx` — scaffolds milestones.json with lat/lng waypoints from GPX
- [ ] Or: simple web-based route editor (Leaflet map — click to place milestones, add name/fact/photo)

---

## 🟢 V2 — Nice-to-Have

### Engagement & Motivation
- [ ] **Suffering index gauge** — composite of time at threshold + HR zone + current grade; shown as a readout that climbs when things get hard
- [ ] **Personal records per route** — honest, not gamified: "Your best: 58:42. Today: 61:14. Legs, huh."
- [ ] **Route library** — browse saved rides; "world tour" meta-goal
- [ ] **"Surprise me" mode** — random route from library; milestone reveals are genuinely unknown until you get there
- [ ] **Ambient sound design**:
  - Background audio matching route character (Parisian street noise, Alpine cowbells + wind)
  - Wind-speed effect tied to actual speed — visceral feedback when hammering
  - Audio crossfades as you approach a landmark
  - Landmark-specific audio during reveal (brief, 5–10s)

### Map
- [ ] Satellite / hybrid tile layer toggle (Mapbox or ESRI — requires API key, opt-in)
- [ ] Street View photo at milestone option (Google Street View Static API — paid, opt-in)
- [ ] Map zoom adapts — wider on long flat sections, tighter on technical climbs

### Milestone Reveals
- [ ] Dismiss animation — panel shrinks back into thumbnail (reverse of burst-out)
- [ ] "Passport stamp" — collectibles panel shows stamps for each completed milestone
- [ ] Ambient sound during reveal
- [ ] Micro-story text — 2-3 sentences of curated context per landmark

### Ride Modes
- [ ] **ERG mode** — hold fixed target wattage (ignore route grade); structured workout support
- [ ] **Free ride** — no route, manual grade/resistance control
- [ ] **Workout import** — ZWO format or simple interval CSV

### Weather Cosmetics
- [ ] Pull current weather at virtual route location via Open-Meteo (free API)
- [ ] Light rain overlay texture if raining at the real location today
- [ ] Temperature display ("It's 12°C in Paris right now")
- [ ] Silly, delightful, totally optional

---

## 🔵 Platform & Distribution

- [ ] **macOS port** — bleak + pywebview both support it; should need minimal code changes
- [ ] **Windows port** — same; bleak uses WinRT on Windows 10+
- [ ] pywebview packaging — proper desktop app, no terminal visible to end user
- [ ] GitHub release with pre-built binary (PyInstaller)
- [ ] **ANT+ support** — alternative to BLE for gym environments with RF congestion; requires USB dongle + `openant` library; same `FTMSClient` interface, different transport
- [ ] CI/CD — GitHub Actions: lint + type-check on push, test on PR

---

## Architecture Notes for Future Sessions

### Elevation pre-load sequence
1. User selects a ride
2. Parse GPX waypoints (`gpxpy`)
3. Batch-query OpenTopoData — max 100 points per request, paginate
4. Apply Savitzky-Golay smoothing to elevation array
5. Compute grade at each waypoint
6. Cache as `[ride-name].elevation.json` alongside the GPX
7. Compute milestone distances (Haversine from route start)
8. Mark ride as ready — show preview map with elevation profile and milestone list

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

### Milestone proximity (production)
- Use Haversine distance from rider's current lat/lng to each milestone lat/lng
- Approach threshold: 500m (configurable per ride)
- Arrival threshold: 100m (triggers reveal)
- After reveal dismissed: mark as done, never re-trigger

### Ride format notes
- Storing milestone images locally (not remote URLs) is important for offline use
- Consider a simple zip-based ride bundle format: `paris-seine.ride` = GPX + milestones.json + images/
- Elevation cache goes in `~/.config/passage/cache/` not in the ride bundle (regeneratable)
