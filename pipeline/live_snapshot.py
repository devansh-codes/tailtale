"""Live airliner snapshot -> D1, run every ~10 minutes from GitHub Actions.

Why: ADSB.lol (and adsb.fi) refuse most requests from Cloudflare's shared egress IPs, so the Worker cannot fetch
live data itself. From a GitHub runner a single combined request works: `/v2/type/A319,A320,...` returns every
aircraft of the 40 tracked airliner types (~7,000 aircraft, ~4 MB) in one call, which is also the politest option.

Writes to D1 through the Cloudflare REST API:
  live_bucket(k, ts, data)   32 buckets by hex ("h00".."h31") + 32 by callsign ("c00".."c31"), compact JSON
  type_counts(ts, type, n, total)   airborne/total per tracked type for the siblings count + 7-day trend
That is ~65 + ~80 row writes per run, i.e. well under D1's 100k/day free cap even at one run every 10 minutes.

LADD/PIA aircraft (dbFlags & 12) are stored as a type-only stub: no callsign, no position, never in callsign buckets.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import USER_AGENT, http_open, log

TRACKED_TYPES = [
    "A319", "A320", "A321", "A20N", "A21N", "BCS1", "BCS3", "A332", "A333", "A339", "A359", "A35K", "A388",
    "B737", "B738", "B739", "B38M", "B39M", "B752", "B763", "B764", "B772", "B77W", "B77L", "B788", "B789",
    "B78X", "B744", "B748", "E170", "E75L", "E75S", "E190", "E195", "E290", "CRJ2", "CRJ7", "CRJ9", "AT76", "DH8D",
]  # fmt: skip
BUCKETS = 32
TEN_MIN = 600
RETENTION_S = 8 * 86400
CALLSIGN_RE = re.compile(r"^[A-Z]{3}[0-9]{1,4}[A-Z]{0,2}$")
ROOT = Path(__file__).resolve().parent.parent


def bucket(key: str) -> int:
    """Shared with worker/src/snapshot.ts: sum of character codes of the upper-cased key, mod 32."""
    return sum(ord(c) for c in key.upper()) % BUCKETS


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def compact(a: dict, now_s: float) -> list | None:
    """[hex, callsign, reg, type, lat, lon, alt|"g"|null, gs, track, vrate, category, posAge, blocked]."""
    hex_ = str(a.get("hex", "")).upper()
    if not re.fullmatch(r"[0-9A-F]{6}", hex_):
        return None  # non-ICAO (~) addresses
    flags = a.get("dbFlags") or 0
    t = a.get("t")
    cat = a.get("category")
    if isinstance(flags, int) and flags & 12:
        return [hex_, None, None, t, None, None, None, None, None, None, cat, None, 1]
    lat, lon, age = num(a.get("lat")), num(a.get("lon")), num(a.get("seen_pos"))
    lp = a.get("lastPosition")
    if lat is None and isinstance(lp, dict):
        lat, lon, age = num(lp.get("lat")), num(lp.get("lon")), num(lp.get("seen_pos"))
    alt = a.get("alt_baro")
    alt = "g" if alt == "ground" else num(alt)
    cs = (a.get("flight") or "").strip() or None
    r = lambda v, n: round(v, n) if v is not None else None  # noqa: E731
    return [
        hex_, cs, a.get("r"), t, r(lat, 4), r(lon, 4), alt, r(num(a.get("gs")), 1), r(num(a.get("track")), 0),
        num(a.get("baro_rate")) if num(a.get("baro_rate")) is not None else num(a.get("geom_rate")), cat,
        r(age, 0), 0,
    ]  # fmt: skip


def build(ac: list[dict], now_s: float) -> dict:
    hex_b: dict[int, list] = {i: [] for i in range(BUCKETS)}
    cs_b: dict[int, dict] = {i: {} for i in range(BUCKETS)}
    counts = {t: {"n": 0, "total": 0} for t in TRACKED_TYPES}
    for a in ac:
        rec = compact(a, now_s)
        if rec is None:
            continue
        hex_b[bucket(rec[0])].append(rec)
        if rec[12] == 0 and rec[1] and CALLSIGN_RE.match(rec[1]):
            cs_b[bucket(rec[1])].setdefault(rec[1], []).append(rec[0])
        t = rec[3]
        if t in counts:
            counts[t]["total"] += 1
            if rec[6] != "g":
                counts[t]["n"] += 1
    return {"hex": hex_b, "cs": cs_b, "counts": counts, "aircraft": sum(len(v) for v in hex_b.values())}


def fetch(retries: int = 2) -> dict:
    url = "https://api.adsb.lol/v2/type/" + ",".join(TRACKED_TYPES)
    last = None
    for attempt in range(retries + 1):
        try:
            with http_open(url, timeout=90, retries=0) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001 - throttled connections stall or reset; wait and retry
            last = e
            log(f"fetch attempt {attempt + 1} failed: {e}")
            if attempt < retries:
                time.sleep(30)
    raise RuntimeError(f"ADSB.lol snapshot failed: {last}")


def d1_database_id() -> str:
    m = re.search(r'database_id = "([0-9a-f-]{36})"', (ROOT / "worker" / "wrangler.toml").read_text())
    if not m:
        raise RuntimeError("database_id not found in worker/wrangler.toml")
    return m.group(1)


class D1:
    def __init__(self, account: str, token: str, db: str):
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{db}/query"
        self.token = token

    def query(self, sql: str, params: list | None = None) -> dict:
        body = json.dumps({"sql": sql, "params": params or []}).encode()
        req = urllib.request.Request(
            self.url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    out = json.loads(r.read())
                if not out.get("success"):
                    raise RuntimeError(out.get("errors"))
                return out
            except urllib.error.HTTPError as e:
                detail = e.read()[:300].decode("utf-8", "replace")
                if e.code < 500 or attempt == 2:
                    raise RuntimeError(f"D1 HTTP {e.code}: {detail}") from e
                log(f"D1 retry ({e.code})")
                time.sleep(2 * (attempt + 1))
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == 2:
                    raise
                log(f"D1 retry ({e})")
                time.sleep(2 * (attempt + 1))
        raise RuntimeError("unreachable")


def write(d1: D1, snap: dict, ts: int) -> int:
    slot = ts // TEN_MIN * TEN_MIN
    stmts: list[tuple[str, list]] = []
    for i, recs in snap["hex"].items():
        stmts.append(
            (
                "INSERT OR REPLACE INTO live_bucket (k, ts, data) VALUES (?, ?, ?)",
                [f"h{i:02d}", ts, json.dumps(recs, separators=(",", ":"))],
            )
        )
    for i, m in snap["cs"].items():
        stmts.append(
            (
                "INSERT OR REPLACE INTO live_bucket (k, ts, data) VALUES (?, ?, ?)",
                [f"c{i:02d}", ts, json.dumps(m, separators=(",", ":"))],
            )
        )
    meta = {"ts": ts, "aircraft": snap["aircraft"], "types": len(TRACKED_TYPES)}
    stmts.append(("INSERT OR REPLACE INTO live_bucket (k, ts, data) VALUES (?, ?, ?)", ["meta", ts, json.dumps(meta)]))
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda s: d1.query(*s), stmts))
    # Type counts: one multi-row insert (replacing any rows already in this 10-minute slot), then prune.
    rows = [(slot, t, c["n"], c["total"]) for t, c in snap["counts"].items()]
    d1.query("DELETE FROM type_counts WHERE ts = ?", [slot])
    for i in range(0, len(rows), 25):  # D1 allows at most 100 bound parameters per query
        chunk = rows[i : i + 25]
        d1.query(
            "INSERT INTO type_counts (ts, type, n, total) VALUES " + ",".join(["(?, ?, ?, ?)"] * len(chunk)),
            [v for r in chunk for v in r],
        )
    d1.query("DELETE FROM type_counts WHERE ts < ?", [slot - RETENTION_S])
    d1.query(
        "INSERT OR REPLACE INTO cron_runs (ts, grp, ok, types, errors, ms) VALUES (?, ?, ?, ?, ?, ?)",
        [ts, "github-snapshot", 1, len(rows), 0, 0],
    )
    d1.query("DELETE FROM cron_runs WHERE ts < ?", [slot - RETENTION_S])
    return len(stmts) + len(rows)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="fetch and build, but don't write to D1")
    ap.add_argument("--source", type=Path, help="read an ADSB.lol /v2/type response from a file (tests)")
    a = ap.parse_args(argv)
    t0 = time.time()
    data = json.loads(a.source.read_text()) if a.source else fetch()
    ts = int(time.time())
    snap = build(data.get("ac") or [], ts)
    airborne = sum(c["n"] for c in snap["counts"].values())
    log(f"snapshot: {snap['aircraft']} aircraft, {airborne} airborne, fetched in {time.time() - t0:.1f}s")
    if snap["aircraft"] < 100 and not a.source:
        log("suspiciously small snapshot; not writing")
        return 1
    if a.dry_run:
        return 0
    d1 = D1(os.environ["CLOUDFLARE_ACCOUNT_ID"], os.environ["CLOUDFLARE_API_TOKEN"], d1_database_id())
    n = write(d1, snap, ts)
    log(f"wrote {n} rows to D1 in {time.time() - t0:.1f}s total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
