"""
tools/ble_info.py — BLE diagnostic: enumerate services and characteristics.

Usage:
    python tools/ble_info.py                    # scan and list nearby devices
    python tools/ble_info.py <address>          # connect and dump GATT table
    python tools/ble_info.py <address> --notify # also test CP/CSC notifications (30s)

Run from the repo root with the venv active:
    source backend/.venv/bin/activate
    python tools/ble_info.py
    python tools/ble_info.py D3:20:9C:ED:61:6F
"""

from __future__ import annotations

import asyncio
import struct
import sys

from bleak import BleakClient, BleakScanner

CP_MEASUREMENT_UUID  = "00002a63-0000-1000-8000-00805f9b34fb"
CSC_MEASUREMENT_UUID = "00002a5b-0000-1000-8000-00805f9b34fb"


async def scan() -> None:
    print("Scanning for BLE devices (10s)…")
    devices = await BleakScanner.discover(timeout=10.0)
    if not devices:
        print("  No devices found.")
        return
    for d in sorted(devices, key=lambda x: x.name or ""):
        print(f"  {d.address}  {d.name or '(unknown)'}")


async def dump_gatt(address: str, test_notify: bool) -> None:
    print(f"Connecting to {address}…")
    async with BleakClient(address) as client:
        print(f"Connected: {client.is_connected}\n")

        for svc in client.services:
            print(f"Service  {svc.uuid}  —  {svc.description or ''}")
            for ch in svc.characteristics:
                props = ", ".join(ch.properties)
                print(f"  Char   {ch.uuid}  [{props}]  —  {ch.description or ''}")
                for desc in ch.descriptors:
                    print(f"    Desc {desc.uuid}  —  {desc.description or ''}")

        if not test_notify:
            return

        print("\n─── Notification test (30s) ───")
        received: dict[str, int] = {}

        def on_cp(_, data: bytearray) -> None:
            received["cp"] = received.get("cp", 0) + 1
            flags = struct.unpack_from("<H", data, 0)[0]
            power = struct.unpack_from("<h", data, 2)[0]
            print(f"  CP  flags=0x{flags:04x}  power={power}W  raw={data.hex()}")

        def on_csc(_, data: bytearray) -> None:
            received["csc"] = received.get("csc", 0) + 1
            print(f"  CSC raw={data.hex()}")

        subscribed = []
        for uuid, handler, name in [
            (CP_MEASUREMENT_UUID,  on_cp,  "Cycling Power Measurement"),
            (CSC_MEASUREMENT_UUID, on_csc, "CSC Measurement"),
        ]:
            svc_chars = {str(c.uuid): c for s in client.services for c in s.characteristics}
            if uuid in svc_chars:
                ch = svc_chars[uuid]
                if "notify" in ch.properties or "indicate" in ch.properties:
                    await client.start_notify(uuid, handler)
                    subscribed.append((uuid, name))
                    print(f"Subscribed to {name} ({uuid})")
                else:
                    print(f"WARN: {name} ({uuid}) does not support notify/indicate — props: {ch.properties}")
            else:
                print(f"NOT FOUND: {name} ({uuid})")

        if subscribed:
            print("Waiting 30s for notifications… (pedal the trainer)")
            await asyncio.sleep(30)
            print(f"\nReceived: {received}")
        else:
            print("No notifiable characteristics found.")


async def main() -> None:
    args = sys.argv[1:]
    test_notify = "--notify" in args
    addrs = [a for a in args if not a.startswith("--")]

    if not addrs:
        await scan()
    else:
        await dump_gatt(addrs[0], test_notify)


asyncio.run(main())
