"""
engine/route.py — GPX loading, elevation fetch, grade calculation

Pre-load sequence (run once before a ride):
  1. Parse GPX waypoints
  2. Batch-query OpenTopoData for elevation at each point (max 100/request)
  3. Smooth elevation profile (Savitzky-Golay)
  4. Compute grade at each waypoint
  5. Cache as [ride-name].elevation.json

During a ride:
  - Given riderT (0.0–1.0, fraction of route), return grade_percent
  - Grade is interpolated from the precomputed profile

TODO: implement
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import gpxpy
import httpx

log = logging.getLogger(__name__)
import numpy as np
from scipy.signal import savgol_filter


@dataclass
class Waypoint:
    lat: float
    lng: float
    dist_m: float       # cumulative distance from route start (meters)
    elevation_m: float  # metres above sea level
    grade_pct: float    # grade at this point (%)


@dataclass
class RouteProfile:
    name: str
    total_km: float
    waypoints: list[Waypoint] = field(default_factory=list)

    def grade_at_t(self, t: float) -> float:
        """Return interpolated grade (%) for a position t (0.0–1.0)."""
        if not self.waypoints:
            return 0.0
        dist_m = t * self.total_km * 1000
        # Binary search for surrounding waypoints
        lo, hi = 0, len(self.waypoints) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if self.waypoints[mid].dist_m <= dist_m:
                lo = mid
            else:
                hi = mid
        wp0, wp1 = self.waypoints[lo], self.waypoints[hi]
        if wp1.dist_m == wp0.dist_m:
            return wp0.grade_pct
        frac = (dist_m - wp0.dist_m) / (wp1.dist_m - wp0.dist_m)
        return wp0.grade_pct + (wp1.grade_pct - wp0.grade_pct) * frac

    def lat_lng_at_t(self, t: float) -> tuple[float, float]:
        """Return (lat, lng) for a position t (0.0–1.0)."""
        if not self.waypoints:
            return 0.0, 0.0
        dist_m = t * self.total_km * 1000
        lo, hi = 0, len(self.waypoints) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if self.waypoints[mid].dist_m <= dist_m:
                lo = mid
            else:
                hi = mid
        wp0, wp1 = self.waypoints[lo], self.waypoints[hi]
        if wp1.dist_m == wp0.dist_m:
            return wp0.lat, wp0.lng
        frac = (dist_m - wp0.dist_m) / (wp1.dist_m - wp0.dist_m)
        lat = wp0.lat + (wp1.lat - wp0.lat) * frac
        lng = wp0.lng + (wp1.lng - wp0.lng) * frac
        return lat, lng


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two lat/lng points, in metres."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi  = math.radians(lat2 - lat1)
    dlam  = math.radians(lng2 - lng1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


async def fetch_elevation(latlngs: list[tuple[float, float]]) -> list[float]:
    """
    Query OpenTopoData for SRTM elevation at a list of (lat, lng) points.
    Paginates automatically (max 100 points per request).
    Returns elevation in metres for each input point.
    Free, no API key required. https://www.opentopodata.org/
    """
    BATCH_SIZE = 100
    BASE_URL = "https://api.opentopodata.org/v1/srtm30m"
    # OpenTopoData free tier: 1 req/s sustained. Sleep between batches to avoid 429.
    BATCH_DELAY = 1.1
    elevations: list[float] = []
    batches = [latlngs[i:i + BATCH_SIZE] for i in range(0, len(latlngs), BATCH_SIZE)]

    async with httpx.AsyncClient(timeout=30.0) as client:
        for idx, batch in enumerate(batches):
            if idx > 0:
                await asyncio.sleep(BATCH_DELAY)
            locations = "|".join(f"{lat},{lng}" for lat, lng in batch)
            log.info("Fetching elevation batch %d/%d (%d points)...", idx + 1, len(batches), len(batch))
            resp = await client.get(BASE_URL, params={"locations": locations})
            resp.raise_for_status()
            data = resp.json()
            elevations.extend(r["elevation"] or 0.0 for r in data["results"])

    return elevations


def smooth_elevation(elevations: list[float], window_m: float = 250, total_km: float = 1.0) -> np.ndarray:
    """
    Apply Savitzky-Golay filter to remove SRTM noise.
    window_m: smoothing window in metres (default 250m)
    """
    n = len(elevations)
    pts_per_km = n / total_km
    window_pts = max(5, int(window_m / 1000 * pts_per_km))
    if window_pts % 2 == 0:
        window_pts += 1
    window_pts = min(window_pts, n if n % 2 == 1 else n - 1)
    return savgol_filter(elevations, window_pts, polyorder=2)


def compute_grades(waypoints_raw: list[tuple[float, float]], elevations: np.ndarray) -> list[float]:
    """
    Compute grade (%) at each waypoint from elevation differences.
    Caps at ±20% to stay within trainer hardware limits.
    """
    grades: list[float] = [0.0]
    for i in range(1, len(waypoints_raw)):
        lat0, lng0 = waypoints_raw[i-1]
        lat1, lng1 = waypoints_raw[i]
        dist_m = haversine_m(lat0, lng0, lat1, lng1)
        elev_delta = float(elevations[i] - elevations[i-1])
        if dist_m > 0:
            grade = (elev_delta / dist_m) * 100
            grade = max(-20.0, min(20.0, grade))  # cap at ±20%
        else:
            grade = 0.0
        grades.append(grade)
    return grades


async def load_route(gpx_path: Path, cache_path: Optional[Path] = None) -> RouteProfile:
    """
    Load a GPX file and return a RouteProfile with elevation + grade.
    If cache_path exists, loads from cache (skip elevation API call).
    """
    # Load from cache if available
    if cache_path and cache_path.exists():
        return _load_from_cache(cache_path)

    # Parse GPX
    with open(gpx_path) as f:
        gpx = gpxpy.parse(f)

    raw_points: list[tuple[float, float]] = []
    for track in gpx.tracks:
        for segment in track.segments:
            for point in segment.points:
                raw_points.append((point.latitude, point.longitude))

    if not raw_points:
        raise ValueError(f"No track points found in {gpx_path}")

    # Fetch and smooth elevation
    elevations_raw = await fetch_elevation(raw_points)
    total_km = sum(
        haversine_m(raw_points[i][0], raw_points[i][1], raw_points[i+1][0], raw_points[i+1][1])
        for i in range(len(raw_points) - 1)
    ) / 1000
    elevations = smooth_elevation(elevations_raw, window_m=250, total_km=total_km)

    # Build waypoints
    grades = compute_grades(raw_points, elevations)
    waypoints: list[Waypoint] = []
    cumulative_m = 0.0
    for i, (lat, lng) in enumerate(raw_points):
        if i > 0:
            cumulative_m += haversine_m(
                raw_points[i-1][0], raw_points[i-1][1], lat, lng
            )
        waypoints.append(Waypoint(
            lat=lat, lng=lng,
            dist_m=cumulative_m,
            elevation_m=float(elevations[i]),
            grade_pct=grades[i],
        ))

    profile = RouteProfile(
        name=gpx_path.stem,
        total_km=total_km,
        waypoints=waypoints,
    )

    # Cache to disk
    if cache_path:
        _save_to_cache(profile, cache_path)

    return profile


def _save_to_cache(profile: RouteProfile, path: Path) -> None:
    data = {
        "name": profile.name,
        "total_km": profile.total_km,
        "waypoints": [
            {"lat": w.lat, "lng": w.lng, "dist_m": w.dist_m,
             "elevation_m": w.elevation_m, "grade_pct": w.grade_pct}
            for w in profile.waypoints
        ],
    }
    path.write_text(json.dumps(data, indent=2))


def _load_from_cache(path: Path) -> RouteProfile:
    data = json.loads(path.read_text())
    waypoints = [Waypoint(**w) for w in data["waypoints"]]
    return RouteProfile(name=data["name"], total_km=data["total_km"], waypoints=waypoints)
