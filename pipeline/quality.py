"""Data quality report: quality/latest.json and a rolling 30-day quality/history.json.

Reads the run report written by history_etl.py (quality/run.json) and the registry meta (reg/meta.json).
If today's history run did not happen, latest.json says so instead of silently showing old numbers.
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
import time
from pathlib import Path

from common import OUT_DIR, SITE_URL, http_get_json, log, read_json, write_json

WINDOW_DAYS = 30
FIELDS = [
    "traces_read",
    "us_traces",
    "aircraft_flew",
    "blocked",
    "corrupt",
    "points",
    "outliers_dropped",
    "segments",
    "both_airports_share",
    "dep_matched_share",
    "arr_matched_share",
    "incomplete_share",
    "split_gaps",
    "median_gap_mins",
    "gap_hist_mins",
    "hist_shards",
    "prev_shard_fetch_failed",
    "stream_s",
    "runtime_s",
]


def load_history(out: Path) -> dict:
    cur = read_json(out / "quality" / "history.json")
    if cur is None:
        try:
            cur = http_get_json(f"{SITE_URL}/data/quality/history.json", retries=1, timeout=30)
        except Exception:  # noqa: BLE001 - first run or site down: start a new history
            cur = None
    return cur if isinstance(cur, dict) else {"days": []}


def build(out: Path, day: str, now: str | None = None) -> dict:
    run = read_json(out / "quality" / "run.json") or {}
    reg = read_json(out / "reg" / "meta.json") or {}
    ok = run.get("d") == day
    entry = {"d": day, "status": "ok" if ok else "missing"}
    if ok:
        entry.update({k: run.get(k) for k in FIELDS})
    latest = {
        "generated_at": now or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "history": entry,
        "history_last_ok": run.get("d"),
        "registry": {k: reg.get(k) for k in ("built_at", "records", "hex_shards", "n_shards", "models")},
        "params": {
            "max_speed_kt": 700,
            "airport_radius_km": 8,
            "landing_agl_ft": 3000,
            "landing_gap_min": 20,
            "split_gap_min": 30,
            "min_flight_min": 5,
            "window_days": WINDOW_DAYS,
        },
    }
    hist = load_history(out)
    cutoff = (dt.date.fromisoformat(day) - dt.timedelta(days=WINDOW_DAYS - 1)).isoformat()
    days = [d for d in hist.get("days", []) if d.get("d", "") >= cutoff and d.get("d") != day]
    days.append(entry)
    days.sort(key=lambda d: d["d"])
    write_json(out / "quality" / "latest.json", latest)
    write_json(out / "quality" / "history.json", {"days": days})
    return latest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--day", help="UTC day the history step was meant to process (default: yesterday)")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    a = ap.parse_args(argv)
    day = a.day or (dt.datetime.now(dt.UTC).date() - dt.timedelta(days=1)).isoformat()
    latest = build(a.out, day)
    log("quality", latest["history"].get("status"), latest["history"].get("segments"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
