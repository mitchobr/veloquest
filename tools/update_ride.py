#!/usr/bin/env python3
"""
tools/update_ride.py — Recalculate milestone distances after a route change.

Usage:
    python tools/update_ride.py rides/<ride-name>

What it does:
  1. Reads <ride-dir>/route.gpx and computes cumulative waypoint distances.
  2. For each milestone in <ride-dir>/milestones.json, finds the nearest GPX
     waypoint and sets distKm to its cumulative distance.
  3. Warns if a milestone is more than 200m from the route (the landmark may
     not be reachable and could miss the proximity trigger — consider raising
     arrival_m in backend/engine/milestone.py or adjusting the lat/lng).
  4. Writes the updated milestones.json in-place.
  5. Deletes <ride-dir>/route.elevation.json so the backend will re-fetch
     elevation data on next start.

Run this whenever route.gpx changes.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

try:
    import gpxpy
except ImportError:
    sys.exit("gpxpy not found — activate the backend venv first:\n  source backend/.venv/bin/activate")


WARN_DISTANCE_M = 200   # warn if milestone is this far from the route


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def main(ride_dir: Path) -> None:
    gpx_path       = ride_dir / "route.gpx"
    milestones_path = ride_dir / "milestones.json"
    elevation_path  = ride_dir / "route.elevation.json"

    if not gpx_path.exists():
        sys.exit(f"route.gpx not found in {ride_dir}")
    if not milestones_path.exists():
        sys.exit(f"milestones.json not found in {ride_dir}")

    # Parse GPX
    with open(gpx_path) as f:
        gpx = gpxpy.parse(f)
    pts = [
        (p.latitude, p.longitude)
        for track in gpx.tracks
        for segment in track.segments
        for p in segment.points
    ]
    if len(pts) < 2:
        sys.exit("GPX has fewer than 2 track points — nothing to process.")

    # Cumulative distances
    cum: list[float] = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + haversine_m(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]))
    total_km = cum[-1] / 1000

    print(f"\nRoute: {gpx_path}")
    print(f"  {len(pts)} waypoints,  total = {total_km:.3f} km\n")

    # Load milestones
    milestones: list[dict] = json.loads(milestones_path.read_text())

    warnings: list[str] = []

    for m in milestones:
        # Nearest GPX waypoint by haversine
        dists = [haversine_m(m["lat"], m["lng"], lat, lng) for lat, lng in pts]
        idx   = min(range(len(dists)), key=lambda i: dists[i])
        nearest_m  = dists[idx]
        new_dist_km = round(cum[idx] / 1000, 3)
        old_dist_km = m.get("distKm", "?")

        status = "  OK " if nearest_m <= WARN_DISTANCE_M else "WARN"
        print(f"  [{status}] {m['name']}")
        print(f"         nearest waypoint {nearest_m:.0f}m away  →  distKm: {old_dist_km} → {new_dist_km}")

        if nearest_m > WARN_DISTANCE_M:
            warnings.append(
                f"{m['name']}: {nearest_m:.0f}m from route. "
                "Proximity trigger may not fire — check the route or increase arrival_m "
                "in the check_proximity call in backend/main.py."
            )

        m["distKm"] = new_dist_km

    # Write updated milestones.json
    milestones_path.write_text(json.dumps(milestones, indent=2, ensure_ascii=False))
    print(f"\n✓  Updated {milestones_path}")

    # Invalidate elevation cache
    if elevation_path.exists():
        elevation_path.unlink()
        print(f"✓  Deleted {elevation_path}  (will be regenerated on next backend start)")
    else:
        print(f"   No elevation cache to delete.")

    # Summary for TrainerMap.jsx
    print(f"\n── TrainerMap.jsx MILESTONES — paste these distKm values ──")
    for m in milestones:
        print(f"   id={m['id']}  {m['name']:<25s}  distKm: {m['distKm']}")
    print(f"\n   Also update: const totalKm = routeTotalKm || {total_km:.3f}")

    if warnings:
        print("\n⚠  Warnings:")
        for w in warnings:
            print(f"   • {w}")

    print()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(f"Usage: python {sys.argv[0]} <ride-dir>\nExample: python {sys.argv[0]} rides/paris-seine")
    main(Path(sys.argv[1]))
