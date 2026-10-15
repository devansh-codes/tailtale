"""ADSB.lol daily history -> per-aircraft rolling 30-day flight history shards.

For one UTC day:
  1. discover the `prod` release in adsblol/globe_history_{YEAR} via the GitHub API
  2. stream every asset part, in order, as ONE byte stream into tarfile (never touches disk)
  3. keep US civil hex (A00001..ADF7C7); LADD/PIA aircraft only get a `blocked` stub
  4. segment each trace into flights (worker pool), assign airports with a KD-tree
  5. merge into hist/{first4hex}.json (30-day window), write stats/daily.json and a run report

Data is ODbL (ADSB.lol); derived shards are published under ODbL.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import http.client
import io
import math
import multiprocessing as mp
import os
import re
import statistics
import sys
import tarfile
import threading
import time
import urllib.error
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import orjson
from scipy.spatial import cKDTree

from common import (
    OUT_DIR,
    SITE_URL,
    US_HEX_MAX,
    US_HEX_MIN,
    http_get_json,
    http_open,
    log,
    read_json,
    write_json,
)
from ref_data import load_airports

WINDOW_DAYS = 30
EARTH_KM = 6371.0088
KM_PER_NM = 1.852

# Segmentation parameters (spec 4.2.4). Documented in SCHEMA.md and on the Data Quality page.
MAX_SPEED_KT = 700.0  # implied speed above this between two points = outlier
OUTLIER_RESET = 5  # after this many consecutive rejects, trust the new position (bad anchor)
GROUND_GS_KT = 50.0  # slower than this near an airport counts as on the ground
AIRPORT_RADIUS_KM = 8.0
LANDING_AGL_FT = 3000.0  # "below 3,000 ft" is applied above field elevation (AGL)
LANDING_GAP_S = 20 * 60  # low + near airport + silence longer than this = landed
SPLIT_GAP_S = 30 * 60  # airborne silence longer than this splits the trace (incomplete)
MIN_FLIGHT_S = 5 * 60
DBFLAG_PIA, DBFLAG_LADD = 4, 8

TRACE_RE = re.compile(r"(?:^|/)traces/[0-9a-f]{2}/trace_full_([0-9a-f]{6})\.json$")


# ------------------------------------------------------------------ geometry


def to_xyz(lat, lon):
    lat_r, lon_r = np.radians(lat), np.radians(lon)
    c = np.cos(lat_r)
    return np.stack([c * np.cos(lon_r), c * np.sin(lon_r), np.sin(lat_r)], axis=-1)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


class AirportIndex:
    """KD-tree over 3D unit vectors; chord distance threshold equals the great-circle radius."""

    def __init__(self, airports: list[dict], radius_km: float = AIRPORT_RADIUS_KM):
        self.airports = airports
        self.tree = cKDTree(to_xyz(np.array([a["lat"] for a in airports]), np.array([a["lon"] for a in airports])))
        self.chord = 2 * math.sin(radius_km / EARTH_KM / 2)

    def nearest(self, lat: float, lon: float) -> dict | None:
        d, i = self.tree.query(to_xyz(lat, lon), distance_upper_bound=self.chord)
        if not np.isfinite(d):
            return None
        return self.airports[int(i)]


# ------------------------------------------------------------------ parsing


@dataclass(slots=True)
class Pt:
    t: float
    lat: float
    lon: float
    alt: float | None  # feet, None if unknown
    ground: bool
    gs: float | None
    cs: str | None


def parse_trace(raw: bytes) -> dict:
    """Trace files are gzip-compressed JSON even without a .gz suffix; tolerate plain JSON too."""
    data = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    return orjson.loads(data)


def trace_points(doc: dict) -> list[Pt]:
    base = float(doc.get("timestamp") or 0)
    pts: list[Pt] = []
    cs = None
    for row in doc.get("trace") or []:
        if not isinstance(row, list) or len(row) < 5:
            continue
        try:
            t, lat, lon = base + float(row[0]), row[1], row[2]
        except (TypeError, ValueError):
            continue
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        a = row[3]
        ground = a == "ground"
        alt = float(a) if isinstance(a, (int, float)) and not isinstance(a, bool) else None
        gs = row[4] if isinstance(row[4], (int, float)) else None
        if len(row) > 8 and isinstance(row[8], dict):
            f = row[8].get("flight")
            if isinstance(f, str) and f.strip():
                cs = f.strip()
        pts.append(Pt(t, float(lat), float(lon), alt, ground, gs, cs))
    pts.sort(key=lambda p: p.t)
    return pts


def drop_outliers(pts: list[Pt]) -> tuple[list[Pt], int]:
    if not pts:
        return pts, 0
    kept = [pts[0]]
    dropped = 0
    rejects = 0
    for p in pts[1:]:
        q = kept[-1]
        dt_h = (p.t - q.t) / 3600.0
        dist_nm = haversine_km(q.lat, q.lon, p.lat, p.lon) / KM_PER_NM
        if dt_h <= 0:
            if dist_nm > 0.5:
                dropped += 1
                continue
            kept.append(p)
            continue
        if dist_nm / dt_h > MAX_SPEED_KT and dist_nm > 2:
            rejects += 1
            if rejects < OUTLIER_RESET:
                dropped += 1
                continue
            # A run of "impossible" points that agree with each other: the anchor was the bad one.
            dropped += 1
            kept[-1] = p
            rejects = 0
            continue
        rejects = 0
        kept.append(p)
    return kept, dropped


# ------------------------------------------------------------------ segmentation


@dataclass
class Seg:
    t_off: float
    t_on: float
    dep: str | None
    arr: str | None
    incomplete: bool
    max_alt: float
    cs: Counter = field(default_factory=Counter)


@dataclass
class TraceStats:
    points: int = 0
    outliers: int = 0
    split_gaps_s: list = field(default_factory=list)


def _agl(p: Pt, ap: dict | None) -> float | None:
    if p.alt is None:
        return None
    return p.alt - (ap["elev"] if ap else 0.0)


def _low_near_airport(p: Pt, idx: AirportIndex) -> dict | None:
    if p.ground:
        return idx.nearest(p.lat, p.lon)
    ap = idx.nearest(p.lat, p.lon)
    if ap is None:
        return None
    agl = _agl(p, ap)
    if agl is not None and agl < LANDING_AGL_FT:
        return ap
    if agl is None and p.gs is not None and p.gs < 160:
        return ap
    return None


def is_on_ground(p: Pt, idx: AirportIndex) -> bool:
    if p.ground:
        return True
    if p.gs is not None and p.gs < GROUND_GS_KT:
        ap = idx.nearest(p.lat, p.lon)
        if ap is not None:
            agl = _agl(p, ap)
            return agl is None or agl < 500
    return False


def segment(pts: list[Pt], idx: AirportIndex, day_end: float, stats: TraceStats | None = None) -> list[Seg]:
    """Split a sorted, outlier-free point list into flights.

    takeoff  = ground -> airborne transition (departure = airport nearest the last ground point)
    landing  = airborne -> ground, OR last airborne point low (AGL < 3000 ft) within 8 km of an airport
               followed by > 20 min of silence (or the end of the day's data)
    airborne silence > 30 min that is not a landing ends the segment as incomplete; the next data
    starts a new incomplete segment. We never guess what happened inside a gap.
    """
    segs: list[Seg] = []
    cur: Seg | None = None
    prev: Pt | None = None
    prev_ground: bool | None = None
    last_ground_pt: Pt | None = None

    def start(p: Pt, dep: str | None, incomplete: bool) -> Seg:
        s = Seg(p.t, p.t, dep, None, incomplete, p.alt or 0.0)
        if p.cs:
            s.cs[p.cs] += 1
        return s

    def close(s: Seg, arr: str | None, incomplete: bool) -> None:
        s.arr = arr
        s.incomplete = s.incomplete or incomplete
        segs.append(s)

    for p in pts:
        g = is_on_ground(p, idx)
        if prev is not None and cur is not None:
            gap = p.t - prev.t
            if gap > LANDING_GAP_S:
                ap = _low_near_airport(prev, idx)
                if ap is not None:
                    close(cur, ap["id"], False)
                    cur = None
                elif gap > SPLIT_GAP_S:
                    if stats is not None:
                        stats.split_gaps_s.append(gap)
                    close(cur, None, True)
                    cur = None
        if g:
            if cur is not None:
                ap = idx.nearest(p.lat, p.lon)
                close(cur, ap["id"] if ap else None, False)
                cur = None
            last_ground_pt = p
        else:
            if cur is None:
                if prev_ground and last_ground_pt is not None and p.t - last_ground_pt.t <= SPLIT_GAP_S:
                    ap = idx.nearest(last_ground_pt.lat, last_ground_pt.lon)
                    cur = start(p, ap["id"] if ap else None, False)
                else:
                    # First airborne point after nothing / after a gap: a takeoff only if it is low near a field.
                    ap = _low_near_airport(p, idx)
                    cur = start(p, ap["id"] if ap else None, ap is None)
            cur.t_on = p.t
            if p.alt is not None and p.alt > cur.max_alt:
                cur.max_alt = p.alt
            if p.cs:
                cur.cs[p.cs] += 1
        prev = p
        prev_ground = g

    if cur is not None and prev is not None:
        ap = _low_near_airport(prev, idx)
        if ap is not None and day_end - prev.t > LANDING_GAP_S:
            close(cur, ap["id"], False)
        else:
            close(cur, None, True)

    return [s for s in segs if s.t_on - s.t_off >= MIN_FLIGHT_S]


# ------------------------------------------------------------------ per-trace worker

_IDX: AirportIndex | None = None


def _init_worker(airports: list[dict]) -> None:
    global _IDX
    _IDX = AirportIndex(airports)


def summarize(doc: dict, idx: AirportIndex, day: str) -> dict:
    """Returns a per-aircraft result: either a daily summary, a blocked stub, or 'nothing flown'."""
    hex_ = str(doc.get("icao", "")).upper()
    flags = doc.get("dbFlags") or 0
    t = doc.get("t")
    res: dict = {"hex": hex_, "t": t if isinstance(t, str) else None}
    if isinstance(flags, int) and flags & (DBFLAG_LADD | DBFLAG_PIA):
        res["blocked"] = True
        return res
    pts = trace_points(doc)
    st = TraceStats(points=len(pts))
    pts, st.outliers = drop_outliers(pts)
    base = float(doc.get("timestamp") or 0)
    segs = segment(pts, idx, base + 86400, st)
    flights = []
    max_alt = 0.0
    for s in segs:
        f = {
            "dep": s.dep,
            "arr": s.arr,
            "t_off": int(s.t_off),
            "t_on": int(s.t_on),
            "mins": round((s.t_on - s.t_off) / 60),
            "incomplete": s.incomplete,
        }
        if s.cs:
            f["cs"] = s.cs.most_common(1)[0][0]
        flights.append(f)
        max_alt = max(max_alt, s.max_alt)
    res["stats"] = {"points": st.points, "outliers": st.outliers, "gaps": [round(g / 60) for g in st.split_gaps_s]}
    if flights:
        res["day"] = {
            "d": day,
            "flights": flights,
            "airborne_mins": sum(f["mins"] for f in flights),
            "max_alt": int(max_alt),
        }
    return res


def process_member(item: tuple[str, bytes, str]) -> dict | None:
    hex_, raw, day = item
    assert _IDX is not None
    try:
        doc = parse_trace(raw)
    except Exception:  # noqa: BLE001 - corrupt member: count it, don't crash the run
        return {"hex": hex_.upper(), "error": True}
    doc.setdefault("icao", hex_)
    return summarize(doc, _IDX, day)


# ------------------------------------------------------------------ release discovery & streaming


def gh_headers() -> dict[str, str]:
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


def find_release(day: dt.date) -> dict | None:
    """Return {'tag', 'assets':[{'name','url','size'}]} for the day's prod release, or None."""
    tag_re = re.compile("^" + re.escape(f"v{day:%Y.%m.%d}") + r"-planes-readsb-prod-(\d+)$")
    repos = [f"adsblol/globe_history_{day.year}"]
    try:
        org = http_get_json("https://api.github.com/orgs/adsblol/repos?per_page=100&sort=updated", headers=gh_headers())
        repos += [r["full_name"] for r in org if "globe_history" in r["name"] and r["full_name"] not in repos]
    except Exception as e:  # noqa: BLE001
        log(f"org repo listing failed ({e}); using {repos[0]} only")
    for repo in repos:
        for page in range(1, 6):
            try:
                rels = http_get_json(
                    f"https://api.github.com/repos/{repo}/releases?per_page=100&page={page}", headers=gh_headers()
                )
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    break
                raise
            if not rels:
                break
            matches = [(int(m.group(1)), r) for r in rels if (m := tag_re.match(r.get("tag_name", "")))]
            if matches:
                _, rel = max(matches, key=lambda x: x[0])
                assets = sorted(
                    (
                        {"name": a["name"], "url": a["browser_download_url"], "size": a["size"]}
                        for a in rel["assets"]
                        if a["name"].startswith(rel["tag_name"])
                    ),
                    key=lambda a: a["name"],
                )
                if assets:
                    return {"tag": rel["tag_name"], "repo": repo, "assets": assets}
            # releases are newest first; stop once we are older than the day we want
            oldest = rels[-1].get("tag_name", "")
            if oldest[:11] < f"v{day:%Y.%m.%d}":
                break
    return None


class ConcatStream(io.RawIOBase):
    """Concatenates HTTP downloads into one readable stream, resuming with Range on dropped connections."""

    def __init__(self, urls: list[str], retries: int = 6):
        self.urls = urls
        self.retries = retries
        self.i = -1
        self.pos = 0
        self.resp = None
        self.bytes = 0
        self._next()

    def _open(self):
        hdr = {"Range": f"bytes={self.pos}-"} if self.pos else {}
        self.resp = http_open(self.urls[self.i], headers=hdr, timeout=120, retries=self.retries)

    def _next(self) -> bool:
        if self.resp:
            self.resp.close()
        self.i += 1
        self.pos = 0
        if self.i >= len(self.urls):
            self.resp = None
            return False
        self._open()
        return True

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        while self.resp is not None:
            for attempt in range(self.retries + 1):
                try:
                    n = self.resp.readinto(b)
                    break
                except (OSError, http.client.HTTPException) as e:
                    if attempt == self.retries:
                        raise
                    log(f"stream error at part {self.i} byte {self.pos}: {e}; resuming")
                    time.sleep(2**attempt)
                    self._open()
            if n:
                self.pos += n
                self.bytes += n
                return n
            if not self._next():
                return 0
        return 0


def iter_trace_members(fileobj, day: str, counters: Counter):
    """Yield (hex, raw_bytes, day) for US trace members. Reads the tar strictly sequentially."""
    tf = tarfile.open(fileobj=fileobj, mode="r|*")
    for m in tf:
        if not m.isfile():
            continue
        mm = TRACE_RE.search(m.name)
        if not mm:
            counters["other_members"] += 1
            continue
        counters["traces_read"] += 1
        hex_ = mm.group(1)
        if not (US_HEX_MIN <= int(hex_, 16) <= US_HEX_MAX):
            continue
        f = tf.extractfile(m)
        if f is None:
            continue
        counters["us_traces"] += 1
        yield hex_, f.read(), day


# ------------------------------------------------------------------ merge & outputs


def day_cutoff(day: str) -> str:
    return (dt.date.fromisoformat(day) - dt.timedelta(days=WINDOW_DAYS - 1)).isoformat()


def merge_entry(prev: dict | None, new: dict | None, day: str, cutoff: str) -> dict | None:
    """Merge yesterday's result for one aircraft into its stored history entry."""
    entry = dict(prev) if prev else {}
    if new is not None and new.get("blocked"):
        # Opted out of tracking: drop all history, keep only a stub (spec 9.2).
        return {"blocked": day}
    if new is not None and "blocked" in entry:
        entry.pop("blocked")  # seen again without the LADD/PIA flag
    days = [d for d in entry.get("days", []) if d.get("d", "") >= cutoff and d.get("d") != day]
    if new is not None:
        if new.get("t"):
            entry["t"] = new["t"]
        if new.get("day"):
            days.append(new["day"])
    if "blocked" in entry:
        return entry
    days.sort(key=lambda d: d["d"])
    if not days:
        return None
    entry["days"] = days
    entry["last_seen"] = max(entry.get("last_seen", ""), days[-1]["d"])
    return entry


def shard_of(hex_: str) -> str:
    return hex_[:4].upper()


def load_prev_shard(prefix: str, local_root: Path, manifest: set[str] | None, counters: Counter) -> dict:
    p = local_root / "hist" / f"{prefix}.json"
    if p.exists():
        d = read_json(p)
        if isinstance(d, dict):
            counters["prev_local"] += 1
            return d
    if manifest is None or f"hist/{prefix}.json" not in manifest:
        return {}
    try:
        d = http_get_json(f"{SITE_URL}/data/hist/{prefix}.json", retries=2, timeout=30)
        counters["prev_fetched"] += 1
        return d if isinstance(d, dict) else {}
    except Exception as e:  # noqa: BLE001
        counters["prev_fetch_failed"] += 1
        log(f"could not fetch previous shard {prefix} ({e}); starting fresh")
        return {}


def fetch_manifest(local_root: Path) -> set[str] | None:
    """Files currently deployed. Empty set = nothing deployed yet (first run). None = unknown (allowed only
    with TAILTALE_ALLOW_FRESH); a site that is down must not be mistaken for an empty one."""
    m = read_json(local_root / "manifest.json")
    if not m:
        try:
            m = http_get_json(f"{SITE_URL}/data/manifest.json", retries=2, timeout=30)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                log("no manifest on the live site: first deploy, starting history fresh")
                return set()
            if os.environ.get("TAILTALE_ALLOW_FRESH"):
                return None
            raise RuntimeError(f"cannot read live manifest ({e}); not overwriting history") from e
        except Exception as e:  # noqa: BLE001
            if os.environ.get("TAILTALE_ALLOW_FRESH"):
                log(f"no manifest available ({e}); starting fresh")
                return None
            raise RuntimeError(f"cannot read live manifest ({e}); not overwriting history") from e
    return set(m.get("files", [])) if isinstance(m, dict) else set()


def merge_and_write(results: dict[str, dict], day: str, out: Path, counters: Counter) -> dict:
    cutoff = day_cutoff(day)
    manifest = fetch_manifest(out)
    prefixes = {shard_of(h) for h in results}
    if manifest:
        prefixes |= {Path(f).stem for f in manifest if f.startswith("hist/") and f.endswith(".json")}
    local = out / "hist"
    if local.exists():
        prefixes |= {p.stem for p in local.glob("*.json") if len(p.stem) == 4}
    by_shard: dict[str, dict[str, dict]] = defaultdict(dict)
    for h, r in results.items():
        by_shard[shard_of(h)][h] = r

    def work(prefix: str) -> tuple[str, dict]:
        prev = load_prev_shard(prefix, out, manifest, counters)
        new = by_shard.get(prefix, {})
        merged = {}
        for h in set(prev) | set(new):
            e = merge_entry(prev.get(h), new.get(h), day, cutoff)
            if e is not None:
                merged[h] = e
        return prefix, merged

    with ThreadPoolExecutor(16) as ex:
        shards = dict(ex.map(work, sorted(prefixes)))

    failed = counters["prev_fetch_failed"]
    if failed > max(20, 0.1 * len(prefixes)) and not os.environ.get("TAILTALE_ALLOW_FRESH"):
        # Mass failure means the site is down, not that the shards are gone: keep yesterday's data instead.
        raise RuntimeError(f"{failed}/{len(prefixes)} previous shards could not be fetched; not overwriting history")

    counters["hist_shards"] = 0
    for prefix, merged in shards.items():
        p = local / f"{prefix}.json"
        if merged:
            write_json(p, merged)
            counters["hist_shards"] += 1
        elif p.exists():
            p.unlink()
    return shards


def update_daily_stats(out: Path, day: str, results: dict[str, dict]) -> None:
    p = out / "stats" / "daily.json"
    cur = read_json(p) or {}
    if not cur:
        try:
            cur = http_get_json(f"{SITE_URL}/data/stats/daily.json", retries=1, timeout=30)
        except Exception:  # noqa: BLE001
            cur = {}
    types: dict[str, dict] = defaultdict(lambda: {"airframes": 0, "hours": 0.0})
    for r in results.values():
        if r.get("day") and r.get("t"):
            ty = types[r["t"]]
            ty["airframes"] += 1
            ty["hours"] += r["day"]["airborne_mins"] / 60
    entry = {
        "d": day,
        "airframes": sum(v["airframes"] for v in types.values()),
        "types": {k: {"airframes": v["airframes"], "hours": round(v["hours"], 1)} for k, v in types.items()},
    }
    cutoff = day_cutoff(day)
    days = [d for d in cur.get("days", []) if d.get("d", "") >= cutoff and d.get("d") != day] + [entry]
    days.sort(key=lambda d: d["d"])
    write_json(p, {"days": days})


def write_airports_ref(out: Path, shards: dict, airports: list[dict]) -> int:
    used: set[str] = set()
    for sh in shards.values():
        for e in sh.values():
            for d in e.get("days", []):
                for f in d["flights"]:
                    used.update(x for x in (f.get("dep"), f.get("arr")) if x)
    ref = {
        a["id"]: [a["iata"], a["name"], a["city"], a["cc"], round(a["lat"], 4), round(a["lon"], 4)]
        for a in airports
        if a["id"] in used
    }
    write_json(out / "ref" / "airports.json", ref)
    return len(ref)


# ------------------------------------------------------------------ driver


def run_day(day: dt.date, out: Path, workers: int, limit: int | None = None, source: Path | None = None) -> dict:
    t0 = time.time()
    dstr = day.isoformat()
    counters: Counter = Counter()
    airports = load_airports()
    if source is not None:
        stream = open(source, "rb")  # noqa: SIM115 - local tar for tests/dev
        rel = {"tag": source.name, "assets": []}
    else:
        rel = find_release(day)
        if rel is None:
            raise RuntimeError(f"no prod release found for {dstr}")
        log(f"release {rel['tag']}: {[(a['name'], a['size']) for a in rel['assets']]}")
        stream = ConcatStream([a["url"] for a in rel["assets"]])
    buffered = io.BufferedReader(stream, buffer_size=4 * 1024 * 1024)

    results: dict[str, dict] = {}
    outliers = points = 0
    gaps: list[int] = []
    # Backpressure: the pool's feeder thread would otherwise read the whole archive into memory.
    sem = threading.BoundedSemaphore(workers * 64)

    def gen():
        for n, item in enumerate(iter_trace_members(buffered, dstr, counters)):
            if limit is not None and n >= limit:
                return
            sem.acquire()
            yield item

    ctx = mp.get_context("fork" if sys.platform == "linux" else "spawn")
    with ctx.Pool(workers, initializer=_init_worker, initargs=(airports,)) as pool:
        for i, r in enumerate(pool.imap_unordered(process_member, gen(), chunksize=16), 1):
            sem.release()
            if r is None:
                continue
            if r.get("error"):
                counters["corrupt"] += 1
                continue
            st = r.pop("stats", None)
            if st:
                points += st["points"]
                outliers += st["outliers"]
                gaps += st["gaps"]
            if r.get("blocked"):
                counters["blocked"] += 1
            results[r["hex"]] = r
            if i % 5000 == 0:
                mb = getattr(stream, "bytes", 0) / 1e6
                log(f"{i} US traces processed, {mb:.0f} MB streamed, {time.time() - t0:.0f}s")
    buffered.close()
    t_stream = time.time() - t0

    # Only aircraft that flew (or are blocked) change history; the rest age out naturally.
    changed = {h: r for h, r in results.items() if r.get("day") or r.get("blocked")}
    shards = merge_and_write(changed, dstr, out, counters)
    n_airports = write_airports_ref(out, shards, airports)
    update_daily_stats(out, dstr, changed)

    flights = [f for r in changed.values() if r.get("day") for f in r["day"]["flights"]]
    both = sum(1 for f in flights if f["dep"] and f["arr"])
    inc = sum(1 for f in flights if f["incomplete"])
    report = {
        "d": dstr,
        "release": rel["tag"],
        "traces_read": counters["traces_read"],
        "us_traces": counters["us_traces"],
        "aircraft_flew": sum(1 for r in changed.values() if r.get("day")),
        "blocked": counters["blocked"],
        "corrupt": counters["corrupt"],
        "points": points,
        "outliers_dropped": outliers,
        "segments": len(flights),
        "both_airports_share": round(both / len(flights), 4) if flights else None,
        "dep_matched_share": round(sum(1 for f in flights if f["dep"]) / len(flights), 4) if flights else None,
        "arr_matched_share": round(sum(1 for f in flights if f["arr"]) / len(flights), 4) if flights else None,
        "incomplete_share": round(inc / len(flights), 4) if flights else None,
        "split_gaps": len(gaps),
        "median_gap_mins": statistics.median(gaps) if gaps else None,
        "gap_hist_mins": gap_histogram(gaps),
        "hist_shards": counters["hist_shards"],
        "prev_shards_local": counters["prev_local"],
        "prev_shards_fetched": counters["prev_fetched"],
        "prev_shard_fetch_failed": counters["prev_fetch_failed"],
        "airports_ref": n_airports,
        "bytes_streamed": getattr(stream, "bytes", None),
        "stream_s": round(t_stream, 1),
        "runtime_s": round(time.time() - t0, 1),
    }
    write_json(out / "quality" / "run.json", report)
    log("history done", {k: v for k, v in report.items() if k != "gap_hist_mins"})
    return report


def gap_histogram(gaps: list[int]) -> dict[str, int]:
    bins = [(30, 60), (60, 120), (120, 240), (240, 480), (480, 10**9)]
    labels = ["30-60", "60-120", "120-240", "240-480", "480+"]
    return {lab: sum(1 for g in gaps if lo <= g < hi) for lab, (lo, hi) in zip(labels, bins, strict=True)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--day", help="UTC day YYYY-MM-DD (default: yesterday)")
    ap.add_argument("--backfill", type=int, default=1, help="process this many days ending at --day, oldest first")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2)))
    ap.add_argument("--limit", type=int, help="stop after N US traces (dev)")
    ap.add_argument("--source", type=Path, help="read a local tar instead of the GitHub release (dev/tests)")
    a = ap.parse_args(argv)
    end = dt.date.fromisoformat(a.day) if a.day else dt.datetime.now(dt.UTC).date() - dt.timedelta(days=1)
    rc = 0
    for k in range(a.backfill - 1, -1, -1):
        day = end - dt.timedelta(days=k)
        try:
            run_day(day, a.out, a.workers, a.limit, a.source)
        except Exception as e:  # noqa: BLE001
            log(f"history for {day} failed: {e}")
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
