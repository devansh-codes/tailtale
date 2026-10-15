import json
import zipfile
from pathlib import Path

import pytest

import faa_registry as fr

FIX = Path(__file__).parent / "fixtures" / "faa"
PRIVATE_TOKENS = ["PRIVATE PERSON", "PRIVATE COOWNER", "PRIVATE STREET", "PRIVATECITY"]


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("faa")
    z = tmp / "ReleasableAircraft.zip"
    with zipfile.ZipFile(z, "w") as zf:
        for name in ("MASTER.txt", "ACFTREF.txt", "ENGINE.txt"):
            zf.write(FIX / name, name)
    out = tmp / "out"
    meta = fr.run(out, z, min_records=0)
    return out, meta


def load_all(out: Path) -> dict:
    recs = {}
    for p in (out / "reg" / "hex").glob("*.json"):
        recs.update(json.loads(p.read_text()))
    return recs


def test_parses_every_fixture_row(built):
    out, meta = built
    assert meta["records"] == 1000
    assert len(load_all(out)) == 1000


def test_known_airline_tail(built):
    """N557AS is an Alaska Airlines 737-890 seen live during the probe (hex a7197d)."""
    out, _ = built
    assert json.loads((out / "reg" / "n" / "557.json").read_text())["N557AS"] == "A7197D"
    rec = json.loads((out / "reg" / "hex" / "A71.json").read_text())["A7197D"]
    assert rec["year"] == 2006
    assert rec["mfr"] == "Boeing" and rec["model"] == "737-800" and rec["fmodel"] == "737-890"
    assert rec["engines"] == 2 and rec["engine_model"] == "CFM56-7B27" and rec["engine_mfr"] == "CFM INTL"
    assert rec["owner_kind"] == "corporation" and rec["owner_org"] == "ALASKA AIRLINES INC"
    assert rec["cert_issued"] == "2006-08-08" and rec["airworthy_since"] == "2006-08-06"
    assert rec["status"] == "V" and rec["serial"] == "35176"


def test_privacy_no_private_names_or_addresses_anywhere(built):
    out, _ = built
    for p in (out / "reg").rglob("*.json"):
        text = p.read_text()
        for tok in PRIVATE_TOKENS:
            assert tok not in text, f"{tok} leaked into {p}"


def test_privacy_owner_org_only_for_organizations(built):
    out, _ = built
    allowed = {"corporation", "government", "llc", "non-citizen corporation"}
    recs = load_all(out)
    private = [r for r in recs.values() if r["owner_kind"] not in allowed]
    assert private, "fixture should contain individual / co-owned registrations"
    for r in recs.values():
        assert not ({"street", "city", "zip", "state", "name", "other_names"} & r.keys())
        if r["owner_kind"] not in allowed:
            assert "owner_org" not in r


def test_privacy_filter_blanks_names_before_records_exist():
    import polars as pl

    df = pl.DataFrame(
        {
            "type_registrant": ["1", "3", "4", "7", None],
            "name": ["JANE DOE", "ACME AIR INC", "JOHN ROE", "SKY LLC", "NOBODY"],
            "street": ["1 A ST"] * 5,
            "city": ["X"] * 5,
            "zip": ["1"] * 5,
            "other_name_1": ["Z"] * 5,
        }
    )
    f = fr.apply_privacy_filter(df)
    assert f["name"].to_list() == [None, "ACME AIR INC", None, "SKY LLC", None]
    assert not ({"street", "city", "zip", "other_name_1"} & set(f.columns))


def test_models_histogram(built):
    out, _ = built
    models = json.loads((out / "reg" / "models.json").read_text())
    total = sum(m["n"] for m in models.values())
    assert 0 < total <= 1000
    for m in models.values():
        assert sum(m["years"].values()) <= m["n"]


def test_shard_names(built):
    out, _ = built
    for p in (out / "reg" / "hex").glob("*.json"):
        assert len(p.stem) == 3 and all(k.startswith(p.stem) for k in json.loads(p.read_text()))
    for p in (out / "reg" / "n").glob("*.json"):
        assert all(k[1:].startswith(p.stem) for k in json.loads(p.read_text()))


@pytest.mark.parametrize(
    "mfr,model,expected",
    [
        ("BOEING", "737-890", ("Boeing", "737-800")),
        ("BOEING", "737-924ER", ("Boeing", "737-900ER")),
        ("BOEING", "737-8", ("Boeing", "737 MAX 8")),
        ("BOEING", "737-9", ("Boeing", "737 MAX 9")),
        ("BOEING", "787-9", ("Boeing", "787-9")),
        ("BOEING", "777-322ER", ("Boeing", "777-300ER")),
        ("BOEING", "757-24APF", ("Boeing", "757-200PF")),
        ("BOEING", "767-300F", ("Boeing", "767-300F")),
        ("AIRBUS S A S", "A321-271NX", ("Airbus", "A321neo")),
        ("AIRBUS INDUSTRIE", "A320-232", ("Airbus", "A320-200")),
        ("AIRBUS", "A330-243", ("Airbus", "A330-200")),
        ("AIRBUS CANADA LP", "BD-500-1A11", ("Airbus", "A220-300")),
        ("EMBRAER S A", "ERJ 170-200 LR", ("Embraer", "E175")),
        ("BOMBARDIER INC", "CL-600-2D24", ("Bombardier", "CRJ900")),
        ("CANADAIR LTD", "CL-600-2B19", ("Bombardier", "CRJ200")),
        ("CESSNA", "172S", ("Cessna", "172S")),
        ("ZIPLINE INTERNATIONAL INC", "P2 ZIP", ("Zipline International", "P2 ZIP")),
        (None, None, ("Unknown", "Unknown")),
    ],
)
def test_display_model(mfr, model, expected):
    assert fr.display_model(mfr, model) == expected


def test_refuses_to_publish_tiny_registry(tmp_path):
    z = tmp_path / "r.zip"
    with zipfile.ZipFile(z, "w") as zf:
        for name in ("MASTER.txt", "ACFTREF.txt", "ENGINE.txt"):
            zf.write(FIX / name, name)
    with pytest.raises(RuntimeError):
        fr.run(tmp_path / "out", z, min_records=5000)
    assert not (tmp_path / "out" / "reg").exists()


def test_main_returns_nonzero_and_keeps_existing(tmp_path):
    reg = tmp_path / "out" / "reg"
    reg.mkdir(parents=True)
    (reg / "keep.json").write_text("{}")
    rc = fr.main(["--out", str(tmp_path / "out"), "--zip", str(tmp_path / "missing.zip")])
    assert rc == 1
    assert (reg / "keep.json").exists()


def test_age_percentile_is_precomputed():
    recs = [
        {"hex": f"A0000{i}", "n": f"N{i}", "mfr": "Boeing", "model": "737-800", "year": y, "status": "V"}
        for i, y in enumerate([2000, 2005, 2010, 2015])
    ]
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        fr.write_shards(recs, Path(td))
    assert [r["pct"] for r in recs] == [75, 50, 25, 0]
    assert all(r["model_n"] == 4 for r in recs)
