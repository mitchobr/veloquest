"""
ws/server.py — aiohttp WebSocket server

Broadcasts trainer telemetry to the React frontend at ~4Hz.
Receives control messages from the frontend (e.g. pause, resume).

Protocol (JSON over WebSocket):

  Backend → Frontend (telemetry, ~4Hz):
    { "type": "telemetry", "power": 218, "cadence": 88, "hr": 156,
      "speed": 29.4, "grade": 3.2, "riderT": 0.342, "distKm": 6.16 }

  Backend → Frontend (event):
    { "type": "milestone_reached", "milestoneId": 2 }
    { "type": "ride_complete" }
    { "type": "trainer_status", "status": "connected" | "disconnected" | "searching" }
    { "type": "route_loaded", "waypoints": [{"lat": ..., "lng": ...}, ...] }

  Frontend → Backend:
    { "type": "set_resistance_mode", "mode": "simulation" | "erg" }
    { "type": "set_target_power", "watts": 200 }
    { "type": "pause" }
    { "type": "resume" }
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Callable, Coroutine, Optional, Set

from aiohttp import web

from backend.engine.route import RouteProfile

log = logging.getLogger(__name__)

AsyncCallback = Callable[[], Coroutine]


class WebSocketServer:
    """
    Manages WebSocket connections and telemetry broadcast.
    Run as an async context manager.
    """

    def __init__(self, host: str = "localhost", port: int = 8765) -> None:
        self._host = host
        self._port = port
        self._clients: Set[web.WebSocketResponse] = set()
        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._route_payload: Optional[str] = None  # cached route_loaded JSON

        # Callbacks wired by main.py after construction
        self.on_pause: Optional[AsyncCallback] = None
        self.on_resume: Optional[AsyncCallback] = None
        self.on_mode_change: Optional[Callable[[str], Coroutine]] = None
        self.on_speed_change: Optional[Callable[[float], Coroutine]] = None

    async def __aenter__(self) -> "WebSocketServer":
        self._app = web.Application()
        self._app.router.add_get("/ws", self._ws_handler)
        rides_dir = Path("rides")
        if rides_dir.exists():
            self._app.router.add_static("/rides", rides_dir)
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self._host, self._port)
        await site.start()
        log.info("WebSocket server listening on ws://%s:%d/ws", self._host, self._port)
        return self

    async def __aexit__(self, *_) -> None:
        if self._runner:
            await self._runner.cleanup()

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

    async def _ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self._clients.add(ws)
        log.info("Frontend connected (%d clients)", len(self._clients))

        # Send route to newly connected client immediately
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
