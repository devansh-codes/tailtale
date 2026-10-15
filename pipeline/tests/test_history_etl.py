import datetime as dt
import glob
import gzip
import io
import json
import tarfile
from pathlib import Path

import orjson
import pytest

import history_etl as h
import ref_data

FIX = Path(__file__).parent / "fixtures"
AIRPORTS_CSV = FIX / "ref" / "airports_subset.csv"
DAY = "2026-10-14"
BASE = dt.datetime(2026, 10, 14, tzinfo=dt.UTC).timestamp()

# Two synthetic airports 100 km apart (elevation 0 and 5,000 ft).
APTS = [
    {"id": "KAAA", "iata": "AAA", "name": "Alpha", "city": "A", "cc": "US", "lat": 40.0, "lon": -100.0, "elev": 0.0},
    {"id": "KBBB", "iata": "BBB", "name": "Bravo", "city": "B", "cc": "US", "lat": 40.0, "lon": -98.8, "elev": 5000.0},
]


@pytest.fixture(scope="module")
def idx():
    return h.AirportIndex(APTS)


@pytest.fixture(scope="module")
def real_idx():
    return h.AirportIndex(ref_data.load_airports(AIRPORTS_CSV))


def P(t_min, lat, lon, alt, gs=None, cs="TST1"):
    ground = alt == "ground"
    return h.Pt(BASE + t_min * 60, lat, lon, None if ground else alt, ground, gs, cs)


def flight(t0, a="A", b="B", cruise=20000):
    """A->B at 2 min resolution: taxi, climb, cruise, descend, taxi."""
    (lat1, lon1, e1), (lat2, lon2, e2) = (
        ((40.0, -100.0, 0), (40.0, -98.8, 5000)) if a == "A" else ((40.0, -98.8, 5000), (40.0, -100.0, 0))
    )
    pts = [P(t0, lat1, lon1, "ground", 5), P(t0 + 2, lat1, lon1 + 0.001, "ground", 20)]
    n = 30
    for i in range(1, n):
        f = i / n
        alt = e1 + 1500 if i in (1, n - 1) else cruise
        if i == n - 1:
            alt = e2 + 1500
        pts.append(P(t0 + 2 + i * 2, lat1 + (lat2 - lat1) * f, lon1 + (lon2 - lon1) * f, alt, 250))
    pts.append(P(t0 + 2 + n * 2, lat2, lon2, "ground", 40))
    pts.append(P(t0 + 4 + n * 2, lat2, lon2 + 0.001, "ground", 5))
    return pts


# ------------------------------------------------------------------ segmentation cases (spec 4.4)


def test_normal_flight(idx):
    segs = h.segment(flight(60), idx, BASE + 86400)
    assert len(segs) == 1
    s = segs[0]
    assert (s.dep, s.arr, s.incomplete) == ("KAAA", "KBBB", False)
    assert 55 <= (s.t_on - s.t_off) / 60 <= 62
    assert s.max_alt == 20000


def test_touch_and_go(idx):
    # A->B, a brief ground roll at B, then B->A: two flights.
    pts = flight(60) + flight(130, "B", "A")
    segs = h.segment(pts, idx, BASE + 86400)
    assert [(s.dep, s.arr) for s in segs] == [("KAAA", "KBBB"), ("KBBB", "KAAA")]
    # A touch-and-go with only one ground point still splits.
    pts = flight(60)[:-1] + flight(126, "B", "A")[1:]
    assert len(h.segment(pts, idx, BASE + 86400)) == 2


def test_midair_coverage_gap_is_incomplete(idx):
    pts = flight(60)
    # Remove 40 minutes of cruise points: silence while airborne at altitude.
    gapped = [p for p in pts if not (BASE + 75 * 60 <= p.t <= BASE + 112 * 60)]
    segs = h.segment(gapped, idx, BASE + 86400)
    assert [(s.dep, s.arr, s.incomplete) for s in segs] == [("KAAA", None, True), (None, "KBBB", True)]


def test_gap_then_ground_is_not_a_guessed_landing(idx):
    cruise = [P(60 + i * 2, 40.0, -100.0 + 0.02 * i, 30000, 450) for i in range(10)]
    ground_later = [P(300, 40.0, -98.8, "ground", 10)]
    segs = h.segment(cruise + ground_later, idx, BASE + 86400)
    assert len(segs) == 1 and segs[0].incomplete and segs[0].arr is None


def test_low_near_airport_then_silence_is_a_landing(idx):
    pts = flight(60)
    # Drop the ground points at the destination: last point is 1,500 ft AGL near KBBB, then nothing.
    no_ground = [p for p in pts if not (p.ground and p.lon > -99)]
    segs = h.segment(no_ground, idx, BASE + 86400)
    assert len(segs) == 1 and segs[0].arr == "KBBB" and not segs[0].incomplete


def test_landing_rule_uses_field_elevation(idx):
    # 6,000 ft MSL over a 5,000 ft field is 1,000 ft AGL: low enough to count as a landing.
    pts = [P(10 + i, 40.0, -99.5 + i * 0.05, 9000, 200) for i in range(12)] + [P(23, 40.0, -98.8, 6000, 140)]
    segs = h.segment(pts, idx, BASE + 86400)
    assert segs and segs[-1].arr == "KBBB"


def test_plane_that_never_moves(idx):
    pts = [P(i * 5, 40.0, -100.0, "ground", 0) for i in range(100)]
    assert h.segment(pts, idx, BASE + 86400) == []


def test_short_hops_discarded(idx):
    pts = [P(0, 40.0, -100.0, "ground", 10)] + [P(1 + i * 0.5, 40.0, -100.0 + i * 0.002, 1000, 90) for i in range(6)]
    pts += [P(5, 40.0, -99.99, "ground", 20)]
    assert h.segment(pts, idx, BASE + 86400) == []


def test_slow_near_airport_counts_as_ground(idx):
    p = P(0, 40.0, -100.0, 300, 30)
    assert h.is_on_ground(p, idx)
    assert not h.is_on_ground(P(0, 45.0, -100.0, 300, 30), idx)  # slow but nowhere near a field
    assert not h.is_on_ground(P(0, 40.0, -100.0, 3000, 30), idx)  # slow but high


def test_airborne_at_midnight_starts_incomplete(idx):
    pts = [P(i * 2, 40.0, -100.5 + i * 0.03, 35000, 450) for i in range(20)]
    segs = h.segment(pts, idx, BASE + 86400)
    assert len(segs) == 1 and segs[0].dep is None and segs[0].incomplete


def test_drop_outliers():
    pts = [P(i, 40.0, -100.0 + i * 0.05, 30000, 450) for i in range(10)]
    pts.insert(5, P(5.5, 10.0, 10.0, 30000, 450))  # teleport
    kept, dropped = h.drop_outliers(pts)
    assert dropped == 1 and len(kept) == 10
    # Bad first point: a run of consistent points wins.
    pts = [P(0, 10.0, 10.0, 30000, 450)] + [P(1 + i, 40.0, -100.0 + i * 0.05, 30000, 450) for i in range(10)]
    kept, dropped = h.drop_outliers(pts)
    assert kept[0].lat == 40.0 and dropped >= 1
    assert h.drop_outliers([]) == ([], 0)
    # Duplicate timestamps: same place is kept, far away is dropped.
    kept, dropped = h.drop_outliers([P(0, 40, -100, 1000), P(0, 40, -100, 1000), P(0, 41, -100, 1000)])
    assert len(kept) == 2 and dropped == 1


def test_airport_index_radius(idx):
    assert idx.nearest(40.0, -100.0)["id"] == "KAAA"
    assert idx.nearest(40.05, -100.0)["id"] == "KAAA"  # ~5.6 km
    assert idx.nearest(40.1, -100.0) is None  # ~11 km


# ------------------------------------------------------------------ parser on real files


def test_parse_real_trace_rows():
    doc = h.parse_trace((FIX / "traces" / "trace_full_a5cf41.json").read_bytes())
    assert doc["icao"] == "a5cf41" and doc["t"] == "B38M"
    pts = h.trace_points(doc)
    assert len(pts) == len(doc["trace"])
    assert pts[0].ground and pts[0].t >= doc["timestamp"]
    assert all(a.t <= b.t for a, b in zip(pts, pts[1:], strict=False))
    assert any(p.cs == "UAL655" for p in pts)


def test_parser_is_defensive():
    doc = {
        "icao": "a00001",
        "timestamp": BASE,
        "trace": [
            [1, 40.0, -100.0, "ground", 0, 0, 0],
            "garbage",
            [2, None, -100.0, 100, 10],
            [3, 95.0, -100.0, 100, 10],
            ["x", 40, -100, 100, 10],
            [4, 40.0, -100.0, None, None, None, 0, None, {"flight": "  "}],
            [5, 40.0, -100.0, True, 10],
            [0.5, 40.0, -100.0, 200, 60],
        ],
    }
    pts = h.trace_points(doc)
    assert [p.t - BASE for p in pts] == [0.5, 1, 4, 5]
    assert pts[3].alt is None  # bool is not an altitude
    plain = orjson.dumps(doc)
    assert h.parse_trace(plain)["icao"] == "a00001"


def test_real_traces_summaries(real_idx):
    out = {}
    for f in glob.glob(str(FIX / "traces" / "*.json")):
        doc = h.parse_trace(Path(f).read_bytes())
        r = h.summarize(doc, real_idx, DAY)
        out[r["hex"]] = r
    ual = out["A5CF41"]["day"]["flights"]
    assert [(f["dep"], f["arr"]) for f in ual[:5]] == [
        ("KDEN", "KLAS"),
        ("KLAS", "KEWR"),
        ("KEWR", "KATL"),
        ("KATL", "KEWR"),
        ("KEWR", "KBNA"),
    ]
    assert ual[0]["cs"] == "UAL655" and not ual[0]["incomplete"]
    assert ual[-1]["incomplete"]  # still airborne at midnight
    assert "day" not in out["A09741"]  # never moved
    assert out["A53341"] == {"hex": "A53341", "t": "GA6C", "blocked": True}  # LADD
    for r in out.values():
        assert "ownOp" not in json.dumps(r) and "REDACTED" not in json.dumps(r)


# ------------------------------------------------------------------ merge


def test_merge_entry_window_and_replace():
    prev = {
        "t": "B738",
        "days": [{"d": "2026-09-01", "flights": []}, {"d": "2026-10-13", "flights": [1]}, {"d": DAY, "flights": [0]}],
    }
    new = {"t": "B738", "day": {"d": DAY, "flights": [9], "airborne_mins": 1, "max_alt": 1}}
    e = h.merge_entry(prev, new, DAY, h.day_cutoff(DAY))
    assert [d["d"] for d in e["days"]] == ["2026-10-13", DAY]
    assert e["days"][-1]["flights"] == [9] and e["last_seen"] == DAY


def test_merge_entry_blocked_and_aging():
    cutoff = h.day_cutoff(DAY)
    assert h.merge_entry({"days": [{"d": DAY, "flights": []}]}, {"blocked": True}, DAY, cutoff) == {"blocked": DAY}
    assert h.merge_entry({"blocked": "2026-01-01"}, None, DAY, cutoff) == {"blocked": "2026-01-01"}
    unblocked = h.merge_entry({"blocked": "2026-01-01"}, {"t": "C172", "day": {"d": DAY, "flights": []}}, DAY, cutoff)
    assert "blocked" not in unblocked and unblocked["days"][0]["d"] == DAY
    assert h.merge_entry({"days": [{"d": "2026-08-01", "flights": []}]}, None, DAY, cutoff) is None
    assert cutoff == "2026-09-15"


# ------------------------------------------------------------------ end to end on a local tar


def make_tar(path: Path) -> None:
    with tarfile.open(path, "w") as tf:
        lic = b"ODbL"
        ti = tarfile.TarInfo("./LICENSE-ODbL.txt")
        ti.size = len(lic)
        tf.addfile(ti, io.BytesIO(lic))
        for f in sorted(glob.glob(str(FIX / "traces" / "*.json"))):
            name = Path(f).name
            tf.add(f, arcname=f"./traces/{name[-7:-5]}/{name}")
        # A non-US trace and a non-ICAO (~) trace must be skipped.
        raw = gzip.compress(orjson.dumps({"icao": "4ca7b5", "timestamp": BASE, "trace": []}))
        for nm in ("./traces/b5/trace_full_4ca7b5.json", "./traces/41/trace_full_~298441.json"):
            ti = tarfile.TarInfo(nm)
            ti.size = len(raw)
            tf.addfile(ti, io.BytesIO(raw))
        bad = b"\x1f\x8bnot really gzip"
        ti = tarfile.TarInfo("./traces/01/trace_full_a00001.json")
        ti.size = len(bad)
        tf.addfile(ti, io.BytesIO(bad))


@pytest.fixture
def offline(monkeypatch):
    monkeypatch.setenv("TAILTALE_AIRPORTS_CSV", str(AIRPORTS_CSV))
    monkeypatch.setenv("TAILTALE_ALLOW_FRESH", "1")

    def no_network(*a, **k):
        raise OSError("offline test")

    monkeypatch.setattr(h, "http_get_json", no_network)


def test_end_to_end_local_tar(tmp_path, offline):
    tar = tmp_path / "day.tar"
    make_tar(tar)
    out = tmp_path / "out"
    # Pre-existing shard with an old day and a stale aircraft that must age out.
    (out / "hist").mkdir(parents=True)
    (out / "hist" / "A5CF.json").write_text(
        json.dumps(
            {
                "A5CF41": {"t": "B38M", "days": [{"d": "2026-10-13", "flights": [], "airborne_mins": 0, "max_alt": 0}]},
                "A5CF00": {"t": "C172", "days": [{"d": "2026-08-01", "flights": []}]},
            }
        )
    )
    rep = h.run_day(dt.date(2026, 10, 14), out, workers=2, source=tar)
    assert rep["traces_read"] == 14 and rep["us_traces"] == 13 and rep["corrupt"] == 1
    assert rep["blocked"] == 1 and rep["segments"] > 20
    assert 0 < rep["both_airports_share"] <= 1 and rep["prev_shards_local"] >= 1
    shard = json.loads((out / "hist" / "A5CF.json").read_text())
    assert [d["d"] for d in shard["A5CF41"]["days"]] == ["2026-10-13", DAY]
    assert "A5CF00" not in shard
    assert json.loads((out / "hist" / "A533.json").read_text())["A53341"] == {"blocked": DAY}
    assert not (out / "hist" / "A097.json").exists()  # never moved -> no history
    stats = json.loads((out / "stats" / "daily.json").read_text())
    assert stats["days"][-1]["d"] == DAY and stats["days"][-1]["types"]["B38M"]["airframes"] == 2
    ref = json.loads((out / "ref" / "airports.json").read_text())
    assert ref["KDEN"][0] == "DEN"
    assert json.loads((out / "quality" / "run.json").read_text())["d"] == DAY
    # Re-running the same day is idempotent.
    h.run_day(dt.date(2026, 10, 14), out, workers=1, source=tar)
    shard2 = json.loads((out / "hist" / "A5CF.json").read_text())
    assert [d["d"] for d in shard2["A5CF41"]["days"]] == ["2026-10-13", DAY]


def test_limit_and_main(tmp_path, offline):
    tar = tmp_path / "day.tar"
    make_tar(tar)
    rc = h.main(["--day", DAY, "--out", str(tmp_path / "o"), "--source", str(tar), "--limit", "3", "--workers", "1"])
    assert rc == 0
    assert json.loads((tmp_path / "o" / "quality" / "run.json").read_text())["us_traces"] <= 4


def test_main_reports_failure(tmp_path, offline, monkeypatch):
    monkeypatch.setattr(h, "find_release", lambda day: None)
    assert h.main(["--day", DAY, "--out", str(tmp_path / "o")]) == 1


# ------------------------------------------------------------------ discovery & streaming (network mocked)


def test_find_release_uses_prod_and_sorts_parts(monkeypatch):
    rels = json.loads((FIX / "upstream" / "github_releases_2026.json").read_text())

    def fake(url, **kw):
        if "/orgs/" in url:
            return [{"name": "globe_history_2026", "full_name": "adsblol/globe_history_2026"}]
        return rels if "page=1" in url else []

    monkeypatch.setattr(h, "http_get_json", fake)
    rel = h.find_release(dt.date(2026, 10, 13))
    assert rel["tag"] == "v2026.10.13-planes-readsb-prod-0"
    assert [a["name"][-2:] for a in rel["assets"]] == ["aa", "ab"]
    assert h.find_release(dt.date(2025, 1, 1)) is None


def test_find_release_survives_org_listing_failure(monkeypatch):
    import urllib.error

    def fake(url, **kw):
        if "/orgs/" in url:
            raise OSError("down")
        raise urllib.error.HTTPError(url, 404, "nf", {}, None)

    monkeypatch.setattr(h, "http_get_json", fake)
    assert h.find_release(dt.date(2027, 1, 1)) is None


class FakeResp:
    def __init__(self, data: bytes, fail_at: int | None = None):
        self.buf = io.BytesIO(data)
        self.fail_at = fail_at

    def readinto(self, b):
        if self.fail_at is not None and self.buf.tell() >= self.fail_at:
            self.fail_at = None
            raise ConnectionResetError("reset")
        n = min(len(b), 1000)
        chunk = self.buf.read(n)
        b[: len(chunk)] = chunk
        return len(chunk)

    def close(self):
        pass


def test_concat_stream_joins_parts_and_resumes(monkeypatch):
    tar = io.BytesIO()
    with tarfile.open(fileobj=tar, mode="w") as tf:
        for f in sorted(glob.glob(str(FIX / "traces" / "*.json")))[:4]:
            tf.add(f, arcname=f"./traces/{Path(f).name[-7:-5]}/{Path(f).name}")
    data = tar.getvalue()
    cut = len(data) // 2 + 123  # split mid-member like the real .aa/.ab
    parts = {"u1": data[:cut], "u2": data[cut:]}
    opened = []

    def fake_open(url, headers=None, **kw):
        start = int(headers["Range"].split("=")[1].rstrip("-")) if headers and "Range" in headers else 0
        opened.append((url, start))
        fail = 5000 if (url == "u1" and start == 0) else None
        return FakeResp(parts[url][start:], fail)

    monkeypatch.setattr(h, "http_open", fake_open)
    monkeypatch.setattr(h.time, "sleep", lambda s: None)
    s = h.ConcatStream(["u1", "u2"])
    got = io.BufferedReader(s).read()
    assert got == data and s.bytes == len(data)
    assert ("u1", 5000) in opened
    from collections import Counter

    c = Counter()
    items = list(h.iter_trace_members(io.BytesIO(data), DAY, c))
    assert len(items) == 4 and c["us_traces"] == 4


def test_gh_headers(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "abc")
    assert h.gh_headers()["Authorization"] == "Bearer abc"
    monkeypatch.delenv("GITHUB_TOKEN")
    monkeypatch.delenv("GH_TOKEN", raising=False)
    assert "Authorization" not in h.gh_headers()


def test_gap_histogram():
    assert h.gap_histogram([31, 61, 500, 1000]) == {"30-60": 1, "60-120": 1, "120-240": 0, "240-480": 0, "480+": 2}


def test_mass_fetch_failure_aborts(tmp_path, offline, monkeypatch):
    monkeypatch.delenv("TAILTALE_ALLOW_FRESH")
    monkeypatch.setattr(h, "fetch_manifest", lambda out: {f"hist/A{i:03X}.json" for i in range(100)})
    from collections import Counter

    with pytest.raises(RuntimeError):
        h.merge_and_write({}, DAY, tmp_path, Counter())
    assert not (tmp_path / "hist").exists()


def test_manifest_semantics(tmp_path, monkeypatch):
    import urllib.error

    monkeypatch.delenv("TAILTALE_ALLOW_FRESH", raising=False)

    def nf(*a, **k):
        raise urllib.error.HTTPError("u", 404, "nf", {}, None)

    monkeypatch.setattr(h, "http_get_json", nf)
    assert h.fetch_manifest(tmp_path) == set()  # first deploy

    def down(*a, **k):
        raise OSError("site down")

    monkeypatch.setattr(h, "http_get_json", down)
    with pytest.raises(RuntimeError):
        h.fetch_manifest(tmp_path)
    monkeypatch.setattr(
        h, "http_get_json", lambda *a, **k: (_ for _ in ()).throw(urllib.error.HTTPError("u", 500, "x", {}, None))
    )
    with pytest.raises(RuntimeError):
        h.fetch_manifest(tmp_path)
    (tmp_path / "manifest.json").write_text('{"files": ["hist/A000.json"]}')
    assert h.fetch_manifest(tmp_path) == {"hist/A000.json"}
