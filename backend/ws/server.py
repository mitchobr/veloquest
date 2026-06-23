"""
ws/server.py — aiohttp WebSocket + HTTP API server

Protocol (JSON over WebSocket):

  Backend → Frontend (telemetry, ~4Hz):
    { "type": "telemetry", "power": 218, "cadence": 88, "hr": 156,
      "speed": 29.4, "grade": 3.2, "riderT": 0.342, "distKm": 6.16 }

  Backend → Frontend (events):
    { "type": "ride_loading",    "rideId": "paris-seine" }
    { "type": "route_loaded",    "waypoints": [...], "totalKm": 16.1, "name": "..." }
    { "type": "milestone_reached", "milestoneId": 2 }
    { "type": "ride_complete" }
    { "type": "trainer_status",  "status": "connected" | "disconnected" | "searching" }
    { "type": "error",           "message": "..." }

  Frontend → Backend:
    { "type": "load_ride",        "rideId": "paris-seine" }
    { "type": "set_resistance_mode", "mode": "simulation" | "erg" }
    { "type": "set_target_power", "watts": 200 }
    { "type": "set_demo_speed",   "multiplier": 3.0 }
    { "type": "pause" }
    { "type": "resume" }

HTTP API (same port, proxied by Vite):
    GET /api/rides   → list of ride cards with history summary
    GET /rides/...   → static files (images, GPX, etc.)
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Callable, Coroutine, Optional, Set

from aiohttp import web

from backend.engine.route import RouteProfile
from backend.history import sessions_for_ride

log = logging.getLogger(__name__)

AsyncCallback = Callable[[], Coroutine]


class WebSocketServer:
    """
    Manages WebSocket connections, telemetry broadcast, and the /api/rides HTTP endpoint.
    Run as an async context manager.
    """

    def __init__(self, host: str = "localhost", port: int = 8765) -> None:
        self._host = host
        self._port = port
        self._clients: Set[web.WebSocketResponse] = set()
        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._route_payload: Optional[str] = None  # cached route_loaded JSON

        # Ride-loading coordination
        self._load_ride_event: asyncio.Event = asyncio.Event()
        self._pending_ride_id: Optional[str] = None

        # Callbacks wired by main.py after construction
        self.on_pause: Optional[AsyncCallback] = None
        self.on_resume: Optional[AsyncCallback] = None
        self.on_mode_change: Optional[Callable[[str], Coroutine]] = None
        self.on_speed_change: Optional[Callable[[float], Coroutine]] = None

    async def __aenter__(self) -> "WebSocketServer":
        self._app = web.Application()
        self._app.router.add_get("/ws", self._ws_handler)
        self._app.router.add_get("/api/rides", self._handle_get_rides)
        rides_dir = Path("rides")
        if rides_dir.exists():
            self._app.router.add_static("/rides", rides_dir)
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self._host, self._port)
        await site.start()
        log.info("Server listening on http://%s:%d (WS at /ws, API at /api)", self._host, self._port)
        return self

    async def __aexit__(self, *_) -> None:
        if self._runner:
            await self._runner.cleanup()

    # ── Public API ────────────────────────────────────────────────────────────

    async def broadcast(self, message: dict) -> None:
        """Send a JSON message to all connected frontend clients."""
        if not self._clients:
            return
        payload = json.dumps(message)
        disconnected = set()
        for ws in self._clients:
            try:
                await ws.send_str(payload)
            except Exception:
                disconnected.add(ws)
        self._clients -= disconnected

    def cache_route(self, profile: RouteProfile) -> None:
        """Pre-serialize route waypoints so they can be sent to each new client."""
        self._route_payload = json.dumps({
            "type": "route_loaded",
            "waypoints": [
                {"lat": w.lat, "lng": w.lng, "dist_m": w.dist_m, "elevation_m": w.elevation_m}
                for w in profile.waypoints
            ],
            "totalKm": profile.total_km,
            "name": profile.name,
        })

    def clear_route(self) -> None:
        """Clear cached route so new clients don't receive stale route_loaded."""
        self._route_payload = None

    async def wait_for_load_ride(self) -> str:
        """Block until the frontend sends a load_ride message; return the rideId."""
        self._load_ride_event.clear()
        self._pending_ride_id = None
        await self._load_ride_event.wait()
        return self._pending_ride_id  # type: ignore[return-value]

    # ── HTTP handlers ─────────────────────────────────────────────────────────

    async def _handle_get_rides(self, request: web.Request) -> web.Response:
        rides_dir = Path("rides")
        rides = []

        for ride_dir in sorted(rides_dir.iterdir()):
            if not ride_dir.is_dir() or not (ride_dir / "route.gpx").exists():
                continue

            ride_id = ride_dir.name

            # Display metadata
            meta_path = ride_dir / "metadata.json"
            if meta_path.exists():
                meta = json.loads(meta_path.read_text())
            else:
                meta = {"name": ride_id.replace("-", " ").title(), "description": "", "coverImage": ""}

            # Milestone count
            ms_path = ride_dir / "milestones.json"
            milestones = json.loads(ms_path.read_text()) if ms_path.exists() else []

            # Total km from elevation cache (fast; skip if not cached)
            total_km: Optional[float] = None
            elev_path = ride_dir / "route.elevation.json"
            if elev_path.exists():
                try:
                    total_km = json.loads(elev_path.read_text()).get("total_km")
                except Exception:
                    pass

            # History summary
            sessions = [s for s in sessions_for_ride(ride_id) if s.status == "completed"]
            best_time_s = min((s.duration_s for s in sessions), default=None)

            cover = meta.get("coverImage", "")
            cover_url = f"/rides/{ride_id}/{cover}" if cover else ""

            rides.append({
                "id": ride_id,
                "name": meta.get("name", ride_id),
                "description": meta.get("description", ""),
                "totalKm": total_km,
                "milestoneCount": len(milestones),
                "coverImage": cover_url,
                "completions": len(sessions),
                "bestTimeS": best_time_s,
            })

        return web.Response(
            text=json.dumps(rides),
            content_type="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )

    # ── WebSocket handler ─────────────────────────────────────────────────────

    async def _ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self._clients.add(ws)
        log.info("Frontend connected (%d clients)", len(self._clients))

        # Send cached route to newly connected clients (if a ride is already loaded)
        if self._route_payload:
            try:
                await ws.send_str(self._route_payload)
            except Exception:
                pass

        try:
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        await self._handle_message(data)
                    except json.JSONDecodeError:
                        log.warning("Invalid JSON from frontend: %s", msg.data)
        finally:
            self._clients.discard(ws)
            log.info("Frontend disconnected (%d clients)", len(self._clients))

        return ws

    async def _handle_message(self, msg: dict) -> None:
        """Dispatch incoming messages from the frontend."""
        match msg.get("type"):
            case "load_ride":
                ride_id = msg.get("rideId")
                if ride_id:
                    log.info("Frontend requested ride: %s", ride_id)
                    self._pending_ride_id = ride_id
                    self._load_ride_event.set()
                    await self.broadcast({"type": "ride_loading", "rideId": ride_id})
            case "pause":
                if self.on_pause:
                    await self.on_pause()
            case "resume":
                if self.on_resume:
                    await self.on_resume()
            case "set_resistance_mode":
                if self.on_mode_change:
                    await self.on_mode_change(msg.get("mode", "simulation"))
            case "set_demo_speed":
                if self.on_speed_change:
                    await self.on_speed_change(float(msg.get("multiplier", 1.0)))
            case other:
                log.debug("Unhandled frontend message type: %s", other)
