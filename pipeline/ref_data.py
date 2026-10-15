"""Reference data: OurAirports subset (for flight segmentation) and the IATA -> ICAO airline map.

uv run python ref_data.py airlines   # regenerate worker/src/generated/airlines.json (committed)
"""

from __future__ import annotations

import argparse
import csv
import io
import os
import sys
import time
from pathlib import Path

from common import CACHE_DIR, ROOT, http_get_bytes, log, write_json

AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
AIRLINES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat"
OVERRIDES = ROOT / "data" / "airline_overrides.json"
AIRLINES_OUT = ROOT / "worker" / "src" / "generated" / "airlines.json"


def cached_download(url: str, name: str, max_age_s: int = 20 * 3600) -> bytes:
    p = CACHE_DIR / name
    if p.exists() and time.time() - p.stat().st_mtime < max_age_s:
        return p.read_bytes()
    try:
        data = http_get_bytes(url, timeout=120)
    except Exception:
        if p.exists():  # stale copy beats nothing
            log(f"download of {url} failed; using cached copy")
            return p.read_bytes()
        raise
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return data


def parse_airports(text: str) -> list[dict]:
    """large_airport + medium_airport + anything with scheduled service (spec 2.6)."""
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        if not (r["type"] in ("large_airport", "medium_airport") or r["scheduled_service"] == "yes"):
            continue
        if r["type"] == "closed":
            continue
        try:
            lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
        except ValueError:
            continue
        elev = r.get("elevation_ft") or ""
        out.append(
            {
                "id": r["icao_code"] or r["gps_code"] or r["ident"],
                "iata": r["iata_code"] or None,
                "name": r["name"],
                "city": r["municipality"] or None,
                "cc": r["iso_country"],
                "lat": lat,
                "lon": lon,
                "elev": float(elev) if elev.lstrip("-").isdigit() else 0.0,
            }
        )
    return out


def load_airports(path: Path | None = None) -> list[dict]:
    env = os.environ.get("TAILTALE_AIRPORTS_CSV")
    path = path or (Path(env) if env else None)
    if path:
        return parse_airports(path.read_text(encoding="utf-8"))
    return parse_airports(cached_download(AIRPORTS_URL, "airports.csv").decode())


def parse_airlines(text: str, overrides: dict) -> dict:
    """OpenFlights airlines.dat (no header; id,name,alias,iata,icao,callsign,country,active)."""
    m: dict[str, dict] = {}
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 8:
            continue
        _, name, _, iata, icao, _, country, active = row[:8]
        iata, icao = iata.strip().upper(), icao.strip().upper()
        if active != "Y" or len(iata) != 2 or len(icao) != 3 or not icao.isalpha() or "\\N" in (iata, icao):
            continue
        cur = m.get(iata)
        # Ambiguous IATA codes: prefer US carriers, else first seen.
        if cur is None or (cur["country"] != "United States" and country == "United States"):
            m[iata] = {"icao": icao, "name": name, "country": country}
    out = {k: {"icao": v["icao"], "name": v["name"]} for k, v in m.items()}
    for iata, v in overrides.items():
        if iata.startswith("_"):
            continue
        out[iata] = {"icao": v["icao"], "name": v["name"], "partners": v.get("partners", [])}
    return dict(sorted(out.items()))


def build_airlines() -> dict:
    import json

    overrides = json.loads(OVERRIDES.read_text())
    text = cached_download(AIRLINES_URL, "airlines.dat").decode("utf-8", "replace")
    data = parse_airlines(text, overrides)
    write_json(AIRLINES_OUT, data)
    log(f"wrote {len(data)} airlines to {AIRLINES_OUT}")
    return data


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["airlines", "airports"])
    a = ap.parse_args(argv)
    if a.what == "airlines":
        build_airlines()
    else:
        log(f"{len(load_airports())} airports in subset")
    return 0


if __name__ == "__main__":
    sys.exit(main())
