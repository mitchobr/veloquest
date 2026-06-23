"""
ble/ftms.py — Fitness Machine Service (FTMS) client

Wraps bleak to provide a clean, OS-agnostic interface to a smart trainer.
bleak handles the platform differences: BlueZ on Linux, CoreBluetooth on macOS,
WinRT on Windows. Same API everywhere.

FTMS spec: Bluetooth SIG, Fitness Machine Service 1.0
Key characteristics:
  0x2AD2  Indoor Bike Data       (notify)  — power, cadence, speed
  0x2AD9  Fitness Machine Control Point (write) — grade, ERG target, reset
  0x2ADA  Fitness Machine Status (notify)  — machine state

TODO: implement
"""

from __future__ import annotations

import asyncio
import logging
import struct
from dataclasses import dataclass
from typing import Callable, Optional

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice

log = logging.getLogger(__name__)

# FTMS service and characteristic UUIDs
FTMS_SERVICE_UUID           = "00001826-0000-1000-8000-00805f9b34fb"
INDOOR_BIKE_DATA_UUID       = "00002ad2-0000-1000-8000-00805f9b34fb"
CONTROL_POINT_UUID          = "00002ad9-0000-1000-8000-00805f9b34fb"
MACHINE_STATUS_UUID         = "00002ada-0000-1000-8000-00805f9b34fb"

# Control Point opcodes
OP_REQUEST_CONTROL          = 0x00
OP_RESET                    = 0x01
OP_SET_TARGET_RESISTANCE    = 0x04
OP_SET_TARGET_POWER         = 0x05
OP_START_RESUME             = 0x07
OP_STOP_PAUSE               = 0x08
OP_SET_INDOOR_BIKE_SIMULATION = 0x11  # includes wind speed, grade, crr, cw


@dataclass
class BikeData:
    """Parsed Indoor Bike Data notification."""
    power_w:   Optional[int]   = None   # instantaneous power (watts)
    cadence:   Optional[int]   = None   # instantaneous cadence (rpm)
    speed_kmh: Optional[float] = None   # instantaneous speed (km/h)


class FTMSClient:
    """
    Asyncio context manager for an FTMS smart trainer.

    Usage:
        async with FTMSClient(address) as trainer:
            await trainer.start_simulation_mode()
            await trainer.set_grade(3.5)
            # ...
    """

    def __init__(self, address: str) -> None:
        self._address = address
        self._client: Optional[BleakClient] = None
        self._data_callback: Optional[Callable[[BikeData], None]] = None

    # ── Context manager ───────────────────────────────────────────────────────

    async def __aenter__(self) -> "FTMSClient":
        self._client = BleakClient(self._address)
        await self._client.connect()
        log.info("Connected to trainer: %s", self._address)
        await self._request_control()
        return self

    async def __aexit__(self, *_) -> None:
        if self._client and self._client.is_connected:
            await self._client.disconnect()
            log.info("Disconnected from trainer.")

    # ── Public API ────────────────────────────────────────────────────────────

    async def start_notify(self, callback: Callable[[BikeData], None]) -> None:
        """Subscribe to Indoor Bike Data notifications."""
        self._data_callback = callback
        await self._client.start_notify(INDOOR_BIKE_DATA_UUID, self._on_bike_data)
        log.info("Subscribed to Indoor Bike Data notifications.")

    async def stop_notify(self) -> None:
        await self._client.stop_notify(INDOOR_BIKE_DATA_UUID)

    async def start_simulation_mode(self) -> None:
        """Put trainer into simulation mode (grade-based resistance)."""
        await self._write_control_point(bytes([OP_START_RESUME]))
        log.info("Trainer in simulation mode.")

    async def set_grade(self, grade_percent: float) -> None:
        """
        Send a grade (slope) to the trainer.
        grade_percent: -40.0 to +40.0 (trainer will cap at its hardware limit)
        The trainer adjusts resistance to simulate climbing/descending.
        """
        # FTMS Indoor Bike Simulation: sint16, unit 0.01%, range -40% to +40%
        grade_clamped = max(-40.0, min(40.0, grade_percent))
        grade_int = int(grade_clamped * 100)
        # Wind speed (0), grade, crr (0), cw (0)
        payload = struct.pack("<hhhh", 0, grade_int, 0, 0)
        await self._write_control_point(bytes([OP_SET_INDOOR_BIKE_SIMULATION]) + payload)

    async def set_target_power(self, watts: int) -> None:
        """ERG mode: hold a fixed wattage target."""
        payload = struct.pack("<Bh", OP_SET_TARGET_POWER, watts)
        await self._write_control_point(payload)

    async def reset(self) -> None:
        await self._write_control_point(bytes([OP_RESET]))

    # ── Private ───────────────────────────────────────────────────────────────

    async def _request_control(self) -> None:
        await self._write_control_point(bytes([OP_REQUEST_CONTROL]))

    async def _write_control_point(self, data: bytes) -> None:
        assert self._client, "Not connected"
        await self._client.write_gatt_char(CONTROL_POINT_UUID, data, response=True)

    def _on_bike_data(self, _sender: int, data: bytearray) -> None:
        """Parse Indoor Bike Data characteristic notification."""
        # TODO: implement full flag-based parser per FTMS spec section 4.9
        # Flags are a 16-bit field; each bit indicates which fields are present.
        # For now, extract power from a known Tacx byte layout.
        parsed = BikeData()
        try:
            flags = struct.unpack_from("<H", data, 0)[0]
            offset = 2
            # Bit 1: More Data (skip instantaneous speed if set — present regardless)
            speed_raw = struct.unpack_from("<H", data, offset)[0]
            parsed.speed_kmh = speed_raw * 0.01
            offset += 2
            # Bit 2: Average Speed — skip if present
            if flags & (1 << 1): offset += 2
            # Bit 3: Instantaneous Cadence
            if flags & (1 << 2):
                parsed.cadence = struct.unpack_from("<H", data, offset)[0] // 2
                offset += 2
            # Bit 4: Average Cadence — skip
            if flags & (1 << 3): offset += 2
            # Bit 5: Total Distance — skip
            if flags & (1 << 4): offset += 3
            # Bit 6: Resistance Level — skip
            if flags & (1 << 5): offset += 2
            # Bit 7: Instantaneous Power
            if flags & (1 << 6):
                parsed.power_w = struct.unpack_from("<h", data, offset)[0]
        except struct.error as e:
            log.warning("Failed to parse bike data: %s", e)

        if self._data_callback:
            self._data_callback(parsed)


async def scan_for_trainer(timeout: float = 10.0) -> Optional[BLEDevice]:
    """
    Scan for FTMS-compatible trainers. Auto-selects Tacx/Garmin devices;
    returns None and logs alternatives if multiple are found.
    """
    log.info("Scanning for FTMS trainers (%.0fs)...", timeout)
    devices = await BleakScanner.discover(timeout=timeout, service_uuids=[FTMS_SERVICE_UUID])

    if not devices:
        log.warning("No FTMS trainers found. Is the trainer powered on and in range?")
        return None

    preferred = [d for d in devices if any(
        kw in (d.name or "").lower() for kw in ("tacx", "garmin", "flux", "neo", "kickr", "elite")
    )]

    chosen = preferred[0] if preferred else devices[0]
    log.info("Found trainer: %s (%s)", chosen.name, chosen.address)
    return chosen
