"""Spot-check segmented flights against published routes (Phase 3 acceptance / notebook input).

For N random airliners that flew on the latest day, compare every completed flight with:
  * adsbdb  /v0/callsign/{cs}  (one origin/destination per callsign)
  * ADSB.lol /api/0/route/{cs} (multi-leg airport list, e.g. KDFW-KMSY-KDFW)
and report strict and lenient agreement plus leg continuity (arr of leg k == dep of leg k+1).

  uv run python spot_check.py --hist out/data/hist --n 10 --out out/spot_check.json
"""

from __future__ import annotations

import argparse
import random
import sys
import time
from pathlib import Path

import orjson

from common import http_get_json, log, write_json

AIRLINER_TYPES = {
    "A319", "A320", "A321", "A20N", "A21N", "BCS1", "BCS3", "B737", "B738", "B739", "B38M", "B39M",
    "B752", "B763", "B772", "B77W", "B788", "B789", "E170", "E75L", "E75S", "CRJ7", "CRJ9", "A332", "A333",
}  # fmt: skip


def candidates(hist_dir: Path) -> list[tuple[str, str, list[dict]]]:
    out = []
    for p in sorted(hist_dir.glob("*.json")):
        for hex_, e in orjson.loads(p.read_bytes()).items():
            if e.get("t") not in AIRLINER_TYPES or not e.get("days"):
                continue
            fl = [
                f
                for f in e["days"][-1]["flights"]
                if not f["incomplete"] and f.get("cs") and f["dep"] and f["arr"] and f["cs"][:3].isalpha()
            ]
            if len(fl) >= 2:
                out.append((hex_, e["t"], fl))
    return out


def legs_of(codes: str | None) -> set[tuple[str, str]]:
    parts = [c for c in (codes or "").split("-") if c]
    return set(zip(parts, parts[1:], strict=False))


def check(cands, n: int, seed: int, pause: float = 0.4) -> dict:
    random.seed(seed)
    pick = random.sample(cands, min(n, len(cands)))
    rows = []
    for hex_, t, flights in pick:
        for i, f in enumerate(flights):
            cs = f["cs"]
            try:
                r = http_get_json(f"https://api.adsbdb.com/v0/callsign/{cs}", retries=1)["response"]["flightroute"]
                db = (r["origin"]["icao_code"], r["destination"]["icao_code"])
            except Exception:  # noqa: BLE001 - unknown callsign
                db = None
            time.sleep(pause)
            try:
                lol = legs_of(http_get_json(f"https://api.adsb.lol/api/0/route/{cs}", retries=1).get("airport_codes"))
            except Exception:  # noqa: BLE001
                lol = set()
            time.sleep(pause)
            ours = (f["dep"], f["arr"])
            nxt = flights[i + 1]["dep"] if i + 1 < len(flights) else None
            rows.append(
                {
                    "hex": hex_,
                    "t": t,
                    "cs": cs,
                    "ours": "-".join(ours),
                    "adsbdb": "-".join(db) if db else None,
                    "adsblol_legs": sorted("-".join(x) for x in lol),
                    "adsbdb_match": db == ours if db else None,
                    "either_match": (db == ours) or (ours in lol) if (db or lol) else None,
                    "continuous": (nxt == f["arr"]) if nxt else None,
                }
            )

    def share(key):
        vals = [r[key] for r in rows if r[key] is not None]
        return (round(sum(vals) / len(vals), 3), len(vals)) if vals else (None, 0)

    return {
        "aircraft": len(pick),
        "flights": len(rows),
        "adsbdb_strict": share("adsbdb_match"),
        "either_source": share("either_match"),
        "continuity": share("continuous"),
        "rows": rows,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hist", type=Path, required=True)
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    rep = check(candidates(a.hist), a.n, a.seed)
    for r in rep["rows"]:
        print(r["hex"], r["t"], r["cs"], r["ours"], "adsbdb:", r["adsbdb"], "lol:", ",".join(r["adsblol_legs"]),
              "OK" if r["either_match"] else "--")  # fmt: skip
    log({k: v for k, v in rep.items() if k != "rows"})
    if a.out:
        rep["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json(a.out, rep)
    return 0


if __name__ == "__main__":
    sys.exit(main())
