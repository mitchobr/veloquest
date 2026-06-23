"""
main.py — Passage backend entry point

Wires together:
  - BLE/FTMS client (ble/ftms.py)
  - Route engine (engine/route.py)
  - Milestone proximity (engine/milestone.py)
  - WebSocket + HTTP API server (ws/server.py)
  - Ride history (history.py)

State machine:
  idle    → wait_for_load_ride → loading → ready (route_loaded sent)
  ready   → resume             → riding
  riding  → riderT >= 1.0      → complete → save session → idle (loop)

No-trainer mode: if no BLE trainer is found, runs with synthetic
telemetry (25 km/h × demo_speed multiplier) so the frontend can be
developed and tested without hardware.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from backend.ble.ftms import BikeData, FTMSClient, scan_for_trainer
from backend.engine.milestone import Milestone, check_by_route_dist, load_milestones
from backend.engine.route import RouteProfile, load_route
from backend.history import RideSession, save_session
from backend.ws.server import WebSocketServer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger("passage")

TELEMETRY_HZ = 4
TELEMETRY_INTERVAL = 1.0 / TELEMETRY_HZ
GRADE_DEBOUNCE = 0.1  # only send grade command if change > 0.1%


async def main() -> None:
    log.info("Passage backend starting...")

    async with WebSocketServer() as server:
        # BLE scan once at startup — independent of which ride is selected
        try:
            device = await scan_for_trainer(timeout=10.0)
        except Exception as e:
            log.warning("BLE scan failed (%s) — no-trainer mode", e)
            device = None

        if device is None:
            log.warning("No FTMS trainer found — running in no-trainer mode")

        await server.broadcast({"type": "trainer_status",
                                "status": "connected" if device else "disconnected"})

        while True:  # outer loop: one iteration per ride
            log.info("Idle — waiting for ride selection from frontend...")
            ride_id = await server.wait_for_load_ride()

            ride_dir = Path("rides") / ride_id
            if not ride_dir.exists() or not (ride_dir / "route.gpx").exists():
                log.warning("Unknown ride requested: %s", ride_id)
                await server.broadcast({"type": "error",
                                        "message": f"Ride not found: {ride_id}"})
                continue

            log.info("Loading ride: %s", ride_id)
            try:
                milestones = load_milestones(ride_dir / "milestones.json")
                profile = await load_route(
                    ride_dir / "route.gpx",
                    cache_path=ride_dir / "route.elevation.json",
                )
            except Exception as e:
                log.error("Failed to load ride %s: %s", ride_id, e)
                await server.broadcast({"type": "error", "message": str(e)})
                continue

            log.info("Route ready: %s (%.1f km, %d waypoints)",
                     profile.name, profile.total_km, len(profile.waypoints))
            server.cache_route(profile)
            await server.broadcast_route()  # send to clients already connected

            session = RideSession.new(ride_id)

            if device:
                try:
                    async with FTMSClient(device.address) as trainer:
                        await trainer.start_simulation_mode()
                        latest: BikeData = BikeData()

                        def on_bike_data(d: BikeData) -> None:
                            nonlocal latest
                            latest = d

                        await trainer.start_notify(on_bike_data)
                        await _run_loop(server, profile, milestones,
                                        trainer=trainer, session=session,
                                        latest_ref=[latest])
                except Exception as e:
                    log.error("Trainer error: %s — switching to no-trainer mode", e)
                    await _run_loop(server, profile, milestones,
                                    trainer=None, session=session)
            else:
                await _run_loop(server, profile, milestones,
                                trainer=None, session=session)

            # Persist and reset for the next ride
            save_session(session)
            server.clear_route()
            log.info("Ride ended (%s). Ready for next selection.", session.status)


async def _run_loop(
    server: WebSocketServer,
    profile: RouteProfile,
    milestones: list[Milestone],
    trainer: Optional[FTMSClient],
    session: RideSession,
    latest_ref: Optional[list[BikeData]] = None,
) -> None:
    """
    Core 4Hz telemetry loop.
    latest_ref: single-element list so the BLE callback can update it in-place.
    """
    rider_t: float = 0.0
    done_ids: set[int] = set()
    paused: bool = True   # start paused — frontend sends "resume" to begin
    last_grade: Optional[float] = None
    demo_speed: float = 1.0
    ride_started: bool = False

    # Running totals for session averages (accumulated while not paused)
    power_sum: float = 0.0
    cadence_sum: float = 0.0
    speed_sum: float = 0.0
    sample_count: int = 0
    elapsed_s: float = 0.0

    abandoned: bool = False

    async def on_pause() -> None:
        nonlocal paused
        paused = True
        log.info("Ride paused")

    async def on_resume() -> None:
        nonlocal paused, ride_started
        paused = False
        if not ride_started:
            ride_started = True
            session.started_at = datetime.now(timezone.utc).isoformat()
            log.info("Ride started")
        log.info("Ride resumed")

    async def on_abandon() -> None:
        nonlocal abandoned
        abandoned = True
        log.info("Ride abandoned by user")

    async def on_speed_change(multiplier: float) -> None:
        nonlocal demo_speed
        demo_speed = max(1.0, min(10.0, multiplier))

    server.on_pause = on_pause
    server.on_resume = on_resume
    server.on_abandon = on_abandon
    server.on_speed_change = on_speed_change

    log.info("Telemetry loop ready (%.0fHz)%s — waiting for resume",
             TELEMETRY_HZ, " [no-trainer]" if trainer is None else "")

    while rider_t < 1.0 and not abandoned:
        await asyncio.sleep(TELEMETRY_INTERVAL)

        lat, lng = profile.lat_lng_at_t(rider_t)
        grade = profile.grade_at_t(rider_t)

        if trainer is not None and latest_ref:
            data: BikeData = latest_ref[0]
            speed_kmh = data.speed_kmh or 0.0
            power_w   = data.power_w   or 0
            cadence   = data.cadence   or 0
        else:
            speed_kmh = 25.0 * demo_speed if not paused else 0.0
            power_w   = 180  if not paused else 0
            cadence   = 85   if not paused else 0

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

        # Advance rider and send grade command
        if trainer is not None and (last_grade is None or abs(grade - last_grade) > GRADE_DEBOUNCE):
            try:
                await trainer.set_grade(grade)
                last_grade = grade
            except Exception as e:
                log.warning("Failed to set grade: %s", e)

        speed_ms = speed_kmh / 3.6
        if speed_ms > 0:
            rider_t = min(1.0, rider_t + (speed_ms * TELEMETRY_INTERVAL) / (profile.total_km * 1000))

        # Accumulate session stats
        elapsed_s += TELEMETRY_INTERVAL
        power_sum   += power_w
        cadence_sum += cadence
        speed_sum   += speed_kmh
        sample_count += 1

        # Update live session fields
        session.distance_km = round(rider_t * profile.total_km, 3)
        session.duration_s  = round(elapsed_s, 1)

        # Milestone detection
        arrived = check_by_route_dist(rider_t, milestones, done_ids, profile.total_km)
        for mid in arrived:
            done_ids.add(mid)
            ms = next(m for m in milestones if m.id == mid)
            log.info("Milestone reached: %s", ms.name)
            session.milestones_reached.append(mid)
            await server.broadcast({"type": "milestone_reached", "milestoneId": mid})

    if sample_count > 0:
        session.avg_power_w   = round(power_sum   / sample_count, 1)
        session.avg_cadence   = round(cadence_sum  / sample_count, 1)
        session.avg_speed_kmh = round(speed_sum    / sample_count, 1)

    if abandoned:
        session.finish(status="abandoned")
        log.info("Ride abandoned at %.1f km", session.distance_km)
    else:
        session.finish(status="completed")
        await server.broadcast({
            "type":       "ride_complete",
            "distKm":     session.distance_km,
            "durationS":  session.duration_s,
            "avgPowerW":  session.avg_power_w,
            "avgCadence": session.avg_cadence,
            "avgSpeedKmh": session.avg_speed_kmh,
            "milestonesReached": session.milestones_reached,
        })
        log.info("Ride complete! %.1f km in %.0fs", session.distance_km, session.duration_s)


if __name__ == "__main__":
    asyncio.run(main())
