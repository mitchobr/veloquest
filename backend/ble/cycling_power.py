"""
ble/cycling_power.py — Read-only BLE client for trainers with Cycling Power service.

Used for trainers that support BLE but not FTMS (e.g. Tacx Flow Smart T2240).
Reads power + cadence from Cycling Power (0x1818) and derives speed from
Cycling Speed and Cadence (0x1816) wheel revolution data.

Grade/resistance commands are silently ignored — the rider adjusts manually.
Matches the FTMSClient interface so main.py can swap it in without changes.
"""

from __future__ import annotations

import logging
import struct
from typing import Callable, Optional

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice

from backend.ble.ftms import BikeData

log = logging.getLogger(__name__)

CYCLING_POWER_SERVICE_UUID = "00001818-0000-1000-8000-00805f9b34fb"
CP_MEASUREMENT_UUID        = "00002a63-0000-1000-8000-00805f9b34fb"

CSC_SERVICE_UUID           = "00001816-0000-1000-8000-00805f9b34fb"
CSC_MEASUREMENT_UUID       = "00002a5b-0000-1000-8000-00805f9b34fb"

# 700c x 23mm road tire — standard assumption for wheel-on trainers
WHEEL_CIRCUMFERENCE_M = 2.096


class CyclingPowerClient:
    """
    Read-only trainer client for devices with Cycling Power but no FTMS.
    Grade commands are silently ignored; rider adjusts resistance manually.
    Matches the FTMSClient interface so main.py can use it interchangeably.
    """

    def __init__(self, address: str) -> None:
        self._address = address
        self._client: Optional[BleakClient] = None
        self._data_callback: Optional[Callable[[BikeData], None]] = None
        self._last_crank: Optional[tuple[int, int]] = None   # (cum_cranks, event_time)
        self._last_wheel: Optional[tuple[int, int]] = None   # (cum_wheels, event_time)
        self._latest = BikeData()

    async def __aenter__(self) -> "CyclingPowerClient":
        self._client = BleakClient(self._address)
        await self._client.connect()
        log.info("Connected to trainer (Cycling Power / read-only): %s", self._address)
        return self

    async def __aexit__(self, *_) -> None:
        if self._client and self._client.is_connected:
            await self._client.disconnect()
            log.info("Disconnected from trainer.")

    # ── Interface matching FTMSClient ─────────────────────────────────────────

    async def start_simulation_mode(self) -> None:
        log.info("Grade-based resistance not supported on this trainer — rider adjusts manually")

    async def set_grade(self, grade_percent: float) -> None:
        pass  # No-op: cannot send resistance commands without FTMS or proprietary protocol

    async def set_target_power(self, watts: int) -> None:
        pass

    async def reset(self) -> None:
        pass

    async def start_notify(self, callback: Callable[[BikeData], None]) -> None:
        self._data_callback = callback
        await self._client.start_notify(CP_MEASUREMENT_UUID, self._on_cp_data)
        log.info("Subscribed to Cycling Power notifications.")

        # Subscribe to CSC for speed/cadence if the service is present
        svc_uuids = {str(s.uuid) for s in self._client.services}
        if CSC_SERVICE_UUID in svc_uuids:
            await self._client.start_notify(CSC_MEASUREMENT_UUID, self._on_csc_data)
            log.info("Subscribed to CSC notifications (speed + cadence).")

    async def stop_notify(self) -> None:
        try:
            await self._client.stop_notify(CP_MEASUREMENT_UUID)
        except Exception:
            pass

    # ── Notification parsers ──────────────────────────────────────────────────

    def _on_cp_data(self, _sender: object, data: bytearray) -> None:
        """
        Parse Cycling Power Measurement (0x2A63).
        Layout: Flags (uint16) | Power (sint16) | [optional fields per flags]
        """
        parsed = BikeData(
            power_w=self._latest.power_w,
            cadence=self._latest.cadence,
            speed_kmh=self._latest.speed_kmh,
        )
        try:
            flags  = struct.unpack_from("<H", data, 0)[0]
            parsed.power_w = struct.unpack_from("<h", data, 2)[0]
            offset = 4

            if flags & (1 << 0): offset += 1   # Pedal Power Balance (uint8)
            if flags & (1 << 2): offset += 2   # Accumulated Torque (uint16)

            if flags & (1 << 4):               # Wheel Revolution Data
                cum_wheel  = struct.unpack_from("<I", data, offset)[0]     # uint32
                wheel_time = struct.unpack_from("<H", data, offset + 4)[0] # uint16
                offset += 6
                spd = self._speed_from_wheel(cum_wheel, wheel_time)
                if spd is not None:
                    parsed.speed_kmh = spd

            if flags & (1 << 5):               # Crank Revolution Data
                cum_crank  = struct.unpack_from("<H", data, offset)[0]     # uint16
                crank_time = struct.unpack_from("<H", data, offset + 2)[0] # uint16
                cad = self._cadence_from_crank(cum_crank, crank_time)
                if cad is not None:
                    parsed.cadence = cad

        except struct.error as e:
            log.warning("Failed to parse CP data: %s", e)

        self._latest = parsed
        if self._data_callback:
            self._data_callback(parsed)

    def _on_csc_data(self, _sender: object, data: bytearray) -> None:
        """
        Parse CSC Measurement (0x2A5B).
        Layout: Flags (uint8) | [Wheel: uint32 + uint16] | [Crank: uint16 + uint16]
        Provides speed and cadence when CP measurement doesn't include them.
        """
        parsed = BikeData(
            power_w=self._latest.power_w,
            cadence=self._latest.cadence,
            speed_kmh=self._latest.speed_kmh,
        )
        try:
            flags  = struct.unpack_from("<B", data, 0)[0]
            offset = 1

            if flags & 0x01:   # Wheel Revolution Data
                cum_wheel  = struct.unpack_from("<I", data, offset)[0]
                wheel_time = struct.unpack_from("<H", data, offset + 4)[0]
                offset += 6
                spd = self._speed_from_wheel(cum_wheel, wheel_time)
                if spd is not None:
                    parsed.speed_kmh = spd

            if flags & 0x02:   # Crank Revolution Data
                cum_crank  = struct.unpack_from("<H", data, offset)[0]
                crank_time = struct.unpack_from("<H", data, offset + 2)[0]
                cad = self._cadence_from_crank(cum_crank, crank_time)
                if cad is not None:
                    parsed.cadence = cad

        except struct.error as e:
            log.warning("Failed to parse CSC data: %s", e)

        self._latest = parsed
        if self._data_callback:
            self._data_callback(parsed)

    # ── Delta calculators ─────────────────────────────────────────────────────

    def _speed_from_wheel(self, cum_wheel: int, event_time: int) -> Optional[float]:
        """Derive km/h from cumulative wheel revolutions (uint32 rollover-safe)."""
        if self._last_wheel is None:
            self._last_wheel = (cum_wheel, event_time)
            return None
        dw = (cum_wheel - self._last_wheel[0]) & 0xFFFFFFFF
        dt = (event_time  - self._last_wheel[1]) & 0xFFFF
        self._last_wheel = (cum_wheel, event_time)
        if dt == 0 or dw == 0:
            return None
        speed_ms = (dw * WHEEL_CIRCUMFERENCE_M) / (dt / 1024.0)
        return round(speed_ms * 3.6, 1)

    def _cadence_from_crank(self, cum_crank: int, event_time: int) -> Optional[int]:
        """Derive RPM from cumulative crank revolutions (uint16 rollover-safe)."""
        if self._last_crank is None:
            self._last_crank = (cum_crank, event_time)
            return None
        dc = (cum_crank - self._last_crank[0]) & 0xFFFF
        dt = (event_time - self._last_crank[1]) & 0xFFFF
        self._last_crank = (cum_crank, event_time)
        if dt == 0 or dc == 0:
            return None
        return round(dc / (dt / 1024.0) * 60)


async def scan_for_cycling_power(timeout: float = 5.0) -> Optional[BLEDevice]:
    """Scan for trainers advertising Cycling Power (0x1818). Returns first match."""
    log.info("Scanning for Cycling Power trainers (%.0fs)...", timeout)
    devices = await BleakScanner.discover(
        timeout=timeout,
        service_uuids=[CYCLING_POWER_SERVICE_UUID],
    )
    if not devices:
        log.warning("No Cycling Power trainers found.")
        return None
    preferred = [d for d in devices if any(
        kw in (d.name or "").lower()
        for kw in ("tacx", "garmin", "flux", "neo", "kickr", "elite", "flow", "wahoo")
    )]
    chosen = preferred[0] if preferred else devices[0]
    log.info("Found trainer (CP): %s (%s)", chosen.name, chosen.address)
    return chosen
