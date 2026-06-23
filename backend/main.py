"""
main.py — Passage backend entry point

Wires together:
  - BLE/FTMS client (ble/ftms.py)
  - Route engine (engine/route.py)
  - WebSocket server (ws/server.py)

TODO: implement
"""

import asyncio
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("passage")


async def main() -> None:
    log.info("Passage backend starting...")

    # TODO: load ride definition
    # ride = await load_ride("../rides/paris-seine")

    # TODO: start BLE scanner and connect to trainer
    # async with FTMSClient() as trainer:

    # TODO: start WebSocket server
    # async with WebSocketServer(trainer=trainer, ride=ride) as server:

    # TODO: main loop — read BLE telemetry, compute grade, broadcast to frontend
    # await server.serve_forever()

    log.info("Backend placeholder — nothing connected yet.")
    await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(main())
