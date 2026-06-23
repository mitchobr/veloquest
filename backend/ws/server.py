"""
ws/server.py — aiohttp WebSocket server

Broadcasts trainer telemetry to the React frontend at ~4Hz.
Receives control messages from the frontend (e.g. pause, speed override).

Protocol (JSON over WebSocket):

  Backend → Frontend (telemetry, ~4Hz):
    { "type": "telemetry", "power": 218, "cadence": 88, "hr": 156,
      "speed": 29.4, "grade": 3.2, "riderT": 0.342, "distKm": 6.16 }

  Backend → Frontend (event):
    { "type": "milestone_reached", "milestoneId": 2 }
    { "type": "ride_complete" }
    { "type": "trainer_status", "status": "connected" | "disconnected" | "searching" }

  Frontend → Backend:
    { "type": "set_resistance_mode", "mode": "simulation" | "erg" }
    { "type": "set_target_power", "watts": 200 }
    { "type": "pause" }
    { "type": "resume" }

TODO: implement
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional, Set

from aiohttp import web

log = logging.getLogger(__name__)


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

    async def __aenter__(self) -> "WebSocketServer":
        self._app = web.Application()
        self._app.router.add_get("/ws", self._ws_handler)
        # TODO: serve built frontend from frontend/dist/
        # self._app.router.add_static("/", path="../frontend/dist", show_index=True)
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

    async def _ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self._clients.add(ws)
        log.info("Frontend connected (%d clients)", len(self._clients))

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
        """Handle incoming messages from the frontend."""
        msg_type = msg.get("type")
        log.debug("Frontend message: %s", msg_type)
        # TODO: dispatch to trainer/route engine
        # e.g. msg_type == "pause" → trainer.stop()
        # e.g. msg_type == "set_target_power" → trainer.set_target_power(msg["watts"])
