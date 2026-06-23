"""
history.py — Persistent ride session storage.

Sessions are stored as a JSON array at:
  ~/.local/share/passage/history.json  (production)
  ./history/history.json               (fallback for dev/repo environments)

Each entry is a RideSession serialised to dict.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


def _history_path() -> Path:
    xdg = os.environ.get("XDG_DATA_HOME", "")
    if xdg:
        base = Path(xdg)
    else:
        base = Path.home() / ".local" / "share"
    p = base / "passage"
    p.mkdir(parents=True, exist_ok=True)
    return p / "history.json"


@dataclass
class RideSession:
    id: str
    ride_id: str
    started_at: str                        # ISO8601 UTC — set on first resume
    completed_at: Optional[str] = None
    status: str = "in_progress"            # "completed" | "abandoned"
    milestones_reached: list[int] = field(default_factory=list)
    distance_km: float = 0.0
    duration_s: float = 0.0
    avg_power_w: Optional[float] = None
    avg_cadence: Optional[float] = None
    avg_speed_kmh: Optional[float] = None

    @classmethod
    def new(cls, ride_id: str) -> "RideSession":
        return cls(
            id=str(uuid.uuid4()),
            ride_id=ride_id,
            started_at=datetime.now(timezone.utc).isoformat(),
        )

    def finish(self, *, status: str = "completed") -> None:
        self.status = status
        self.completed_at = datetime.now(timezone.utc).isoformat()


def load_history() -> list[RideSession]:
    path = _history_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
        return [RideSession(**entry) for entry in data]
    except Exception as e:
        log.warning("Could not load history: %s", e)
        return []


def save_session(session: RideSession) -> None:
    path = _history_path()
    history = load_history()
    existing_ids = {s.id for s in history}
    if session.id in existing_ids:
        history = [session if s.id == session.id else s for s in history]
    else:
        history.append(session)
    try:
        path.write_text(json.dumps([asdict(s) for s in history], indent=2))
        log.info("Session saved: %s (%s, %.1f km)", session.id, session.status, session.distance_km)
    except Exception as e:
        log.error("Could not save session: %s", e)


def sessions_for_ride(ride_id: str) -> list[RideSession]:
    return [s for s in load_history() if s.ride_id == ride_id]
