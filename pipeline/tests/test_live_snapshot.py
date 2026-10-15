import json
from pathlib import Path

import live_snapshot as ls

FIX = Path(__file__).parent / "fixtures" / "upstream"


def test_bucket_is_stable_and_matches_worker():
    # Same function as worker/src/snapshot.ts (sum of char codes mod 32).
    assert ls.bucket("A7197D") == sum(map(ord, "A7197D")) % 32
    assert ls.bucket("ual1711") == ls.bucket("UAL1711")
    assert 0 <= ls.bucket("SKW5123") < 32


def test_build_from_real_type_response():
    d = json.loads((FIX / "adsblol_type_B738.json").read_text())
    snap = ls.build(d["ac"], 0)
    recs = [r for b in snap["hex"].values() for r in b]
    assert snap["aircraft"] == len(recs) == sum(1 for a in d["ac"] if not a["hex"].startswith("~"))
    asa = next(r for r in recs if r[0] == "A7197D")
    assert asa[1] == "ASA73" and asa[2] == "N557AS" and asa[3] == "B738" and asa[12] == 0
    assert snap["cs"][ls.bucket("ASA73")]["ASA73"] == ["A7197D"]
    ground = sum(1 for a in d["ac"] if a.get("alt_baro") == "ground")
    assert snap["counts"]["B738"] == {"n": snap["counts"]["B738"]["total"] - ground, "total": len(d["ac"])}


def test_ladd_aircraft_keep_no_position_or_callsign():
    a = {
        "hex": "aaf29f",
        "flight": "VXP216 ",
        "r": "N804VL",
        "t": "B738",
        "dbFlags": 8,
        "lat": 33.8,
        "lon": -84.5,
        "alt_baro": 38000,
    }
    rec = ls.compact(a, 0)
    assert rec == ["AAF29F", None, None, "B738", None, None, None, None, None, None, None, None, 1]
    snap = ls.build([a], 0)
    assert all("VXP216" not in m for m in snap["cs"].values())


def test_compact_uses_last_position_and_skips_non_icao():
    rec = ls.compact(
        {"hex": "a00001", "lastPosition": {"lat": 1.23456, "lon": 2.5, "seen_pos": 70.4}, "alt_baro": "ground"}, 0
    )
    assert rec[4:7] == [1.2346, 2.5, "g"] and rec[11] == 70
    assert ls.compact({"hex": "~12ab34"}, 0) is None


def test_write_issues_bucket_and_count_statements(monkeypatch):
    calls = []

    class FakeD1:
        def query(self, sql, params=None):
            calls.append((sql, params))
            return {"success": True}

    snap = ls.build(json.loads((FIX / "adsblol_type_B738.json").read_text())["ac"], 0)
    n = ls.write(FakeD1(), snap, 1792080123)
    keys = [p[0] for s, p in calls if s.startswith("INSERT OR REPLACE INTO live_bucket")]
    assert len(keys) == 65 and "meta" in keys and "h00" in keys and "c31" in keys
    ins = [p for s, p in calls if s.startswith("INSERT INTO type_counts")]
    assert all(len(p) <= 100 for _, p in calls if p)  # D1 bound-parameter limit
    assert sum(len(p) for p in ins) == 4 * len(ls.TRACKED_TYPES) and ins[0][0] == 1792080000
    assert n == 65 + len(ls.TRACKED_TYPES)


def test_main_dry_run_from_file():
    assert ls.main(["--dry-run", "--source", str(FIX / "adsblol_type_B738.json")]) == 0
