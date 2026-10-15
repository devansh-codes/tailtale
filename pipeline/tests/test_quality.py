import json

import quality
from common import write_json


def test_quality_ok_and_window(tmp_path, monkeypatch):
    monkeypatch.setattr(quality, "http_get_json", lambda *a, **k: (_ for _ in ()).throw(OSError("offline")))
    write_json(tmp_path / "quality" / "run.json", {"d": "2026-10-14", "segments": 10, "incomplete_share": 0.2})
    write_json(tmp_path / "reg" / "meta.json", {"records": 5, "built_at": "x"})
    write_json(
        tmp_path / "quality" / "history.json",
        {"days": [{"d": "2026-08-01", "status": "ok"}, {"d": "2026-10-13", "status": "ok"}]},
    )
    latest = quality.build(tmp_path, "2026-10-14", now="T")
    assert latest["history"]["status"] == "ok" and latest["history"]["segments"] == 10
    assert latest["registry"]["records"] == 5
    hist = json.loads((tmp_path / "quality" / "history.json").read_text())
    assert [d["d"] for d in hist["days"]] == ["2026-10-13", "2026-10-14"]


def test_quality_marks_missing_run(tmp_path, monkeypatch):
    monkeypatch.setattr(quality, "http_get_json", lambda *a, **k: {"days": [{"d": "2026-10-13", "status": "ok"}]})
    write_json(tmp_path / "quality" / "run.json", {"d": "2026-10-13", "segments": 10})
    latest = quality.build(tmp_path, "2026-10-14")
    assert latest["history"] == {"d": "2026-10-14", "status": "missing"}
    assert latest["history_last_ok"] == "2026-10-13"
    assert quality.main(["--day", "2026-10-14", "--out", str(tmp_path)]) == 0
