"""
main.py — Passage backend entry point

Wires together:
  - BLE/FTMS client (ble/ftms.py)
  - Route engine (engine/route.py)
  - Milestone proximity (engine/milestone.py)
  - WebSocket server (ws/server.py)

No-trainer mode: if no BLE trainer is found, runs with synthetic
telemetry (25 km/h, 180W, 85 rpm) so the frontend can be developed
and tested without hardware.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Optional

from backend.ble.ftms import BikeData, FTMSClient, scan_for_trainer
from backend.engine.milestone import Milestone, check_by_route_dist, load_milestones
from backend.engine.route import RouteProfile, load_route
from backend.ws.server import WebSocketServer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger("passage")

RIDE_DIR = Path("rides/paris-seine")
TELEMETRY_HZ = 4
TELEMETRY_INTERVAL = 1.0 / TELEMETRY_HZ
GRADE_DEBOUNCE = 0.1  # only send grade command if change > 0.1%


async def main() -> None:
    log.info("Passage backend starting...")

    milestones = load_milestones(RIDE_DIR / "milestones.json")
    log.info("Loaded %d milestones", len(milestones))

    profile = await load_route(
        RIDE_DIR / "route.gpx",
        cache_path=RIDE_DIR / "route.elevation.json",
    )
    log.info("Route loaded: %s (%.1f km, %d waypoints)",
             profile.name, profile.total_km, len(profile.waypoints))

    async with WebSocketServer() as server:
        server.cache_route(profile)

        try:
            device = await scan_for_trainer(timeout=10.0)
        except Exception as e:
            log.warning("BLE scan failed (%s) — running in no-trainer mode", e)
            device = None

        if device is None:
            log.warning("No FTMS trainer found — running in no-trainer mode")
            await server.broadcast({"type": "trainer_status", "status": "disconnected"})
            await _run_loop(server, profile, milestones, trainer=None)
        else:
            await server.broadcast({"type": "trainer_status", "status": "searching"})
            async with FTMSClient(device.address) as trainer:
                await server.broadcast({"type": "trainer_status", "status": "connected"})
                await trainer.start_simulation_mode()

                latest: BikeData = BikeData()

                def on_bike_data(d: BikeData) -> None:
                    nonlocal latest
                    latest = d

                await trainer.start_notify(on_bike_data)
                await _run_loop(server, profile, milestones, trainer=trainer, latest_ref=[latest])


async def _run_loop(
    server: WebSocketServer,
    profile: RouteProfile,
    milestones: list[Milestone],
    trainer: Optional[FTMSClient],
    latest_ref: Optional[list[BikeData]] = None,
) -> None:
    """
    Core 4Hz telemetry loop.
    latest_ref: single-element list so the BLE callback can update it in-place.
    """
    rider_t: float = 0.0
    done_ids: set[int] = set()
    paused: bool = True   # start paused — frontend sends "resume" to begin the ride
    last_grade: Optional[float] = None
    demo_speed: float = 1.0  # no-trainer speed multiplier (1–10×), set via set_demo_speed message

    async def on_pause() -> None:
        nonlocal paused
        paused = True
        log.info("Ride paused")

    async def on_resume() -> None:
        nonlocal paused
        paused = False
        log.info("Ride resumed")

    async def on_speed_change(multiplier: float) -> None:
        nonlocal demo_speed
        demo_speed = max(1.0, min(10.0, multiplier))
        log.info("Demo speed set to %.1f×", demo_speed)

    server.on_pause = on_pause
    server.on_resume = on_resume
    server.on_speed_change = on_speed_change

    log.info("Starting telemetry loop (%.0fHz)%s — waiting for resume",
             TELEMETRY_HZ, " [no-trainer mode]" if trainer is None else "")

    while rider_t < 1.0:
        await asyncio.sleep(TELEMETRY_INTERVAL)

        lat, lng = profile.lat_lng_at_t(rider_t)
        grade = profile.grade_at_t(rider_t)

        if trainer is not None:
            data: BikeData = latest_ref[0] if latest_ref else BikeData()
            speed_kmh = data.speed_kmh or 0.0
            power_w   = data.power_w   or 0
            cadence   = data.cadence   or 0
        else:
            speed_kmh = 25.0 * demo_speed if not paused else 0.0
            power_w   = 180  if not paused else 0
            cadence   = 85   if not paused else 0

        # Always broadcast telemetry so the frontend knows we're connected
        await server.broadcast({
            "type":    "telemetry",
            "power":   power_w,
            "cadence": cadence,
            "hr":      0,
            "speed":   round(speed_kmh, 1),
            "grade":   round(grade, 2),
            "riderT":  round(rider_t, 5),
            "distKm":  round(rider_t * profile.total_km, 3),
        })

        if paused:
            continue

        # Advance rider position and send grade command only when riding
        if trainer is not None and (last_grade is None or abs(grade - last_grade) > GRADE_DEBOUNCE):
            try:
                await trainer.set_grade(grade)
                last_grade = grade
            except Exception as e:
                log.warning("Failed to set grade: %s", e)

        speed_ms = speed_kmh / 3.6
        if speed_ms > 0:
            rider_t = min(1.0, rider_t + (speed_ms * TELEMETRY_INTERVAL) / (profile.total_km * 1000))

        # Check milestone proximity by route distance — robust even when the
        # landmark is not directly on the path (e.g., Louvre is 310m off-route)
        arrived = check_by_route_dist(rider_t, milestones, done_ids, profile.total_km)
        for mid in arrived:
            done_ids.add(mid)
            ms = next(m for m in milestones if m.id == mid)
            log.info("Milestone reached: %s", ms.name)
            await server.broadcast({"type": "milestone_reached", "milestoneId": mid})

    await server.broadcast({"type": "ride_complete"})
    log.info("Ride complete!")


if __name__ == "__main__":
    asyncio.run(main())
