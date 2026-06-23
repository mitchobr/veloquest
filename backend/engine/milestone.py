"""
engine/milestone.py — Milestone proximity detection
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from backend.engine.route import haversine_m


@dataclass
class Milestone:
    id: int
    lat: float
    lng: float
    name: str
    dist_km: float
    image: str
    fact: str


def load_milestones(path: Path) -> list[Milestone]:
    """Parse milestones.json → list[Milestone]."""
    items = json.loads(path.read_text())
    return [
        Milestone(
            id=m["id"],
            lat=m["lat"],
            lng=m["lng"],
            name=m["name"],
            dist_km=m["distKm"],
            image=m["image"],
            fact=m["fact"],
        )
        for m in items
    ]


def check_proximity(
    rider_lat: float,
    rider_lng: float,
    milestones: list[Milestone],
    done_ids: set[int],
    approach_m: float = 500.0,
    arrival_m: float = 100.0,
) -> tuple[list[int], list[int]]:
    """
    Return (approaching_ids, arrived_ids) for milestones near the rider.

    approaching: within approach_m but outside arrival_m
    arrived:     within arrival_m
    Milestones in done_ids are skipped.
    """
    approaching: list[int] = []
    arrived: list[int] = []

    for m in milestones:
        if m.id in done_ids:
            continue
        dist = haversine_m(rider_lat, rider_lng, m.lat, m.lng)
        if dist <= arrival_m:
            arrived.append(m.id)
        elif dist <= approach_m:
            approaching.append(m.id)

    return approaching, arrived
