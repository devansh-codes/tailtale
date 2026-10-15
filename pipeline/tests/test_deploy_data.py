import json
import urllib.error

import pytest

import deploy_data as site
from common import write_json


def test_manifest_lists_every_data_file(tmp_path):
    write_json(tmp_path / "reg" / "hex" / "A00.json", {})
    write_json(tmp_path / "hist" / "A000.json", {})
    m = site.build_manifest(tmp_path)
    assert m["files"] == ["hist/A000.json", "reg/hex/A00.json"]
    assert json.loads((tmp_path / "manifest.json").read_text())["files"] == m["files"]
    assert site.main(["manifest", "--out", str(tmp_path)]) == 0


def test_validate_limits(tmp_path, monkeypatch):
    (tmp_path / "a.json").write_text("x")
    assert site.validate(tmp_path) == []
    assert site.main(["validate", str(tmp_path)]) == 0
    monkeypatch.setattr(site, "MAX_BYTES", 0)
    assert site.validate(tmp_path)
    monkeypatch.setattr(site, "MAX_FILES", 1)
    assert any("files" in p for p in site.validate(tmp_path))
    assert site.main(["validate", str(tmp_path)]) == 1


def test_mirror_fetches_missing_files_and_rejects_spa_fallback(tmp_path, monkeypatch):
    write_json(tmp_path / "reg" / "hex" / "A00.json", {"keep": 1})
    monkeypatch.setattr(
        site, "http_get_json", lambda *a, **k: {"files": ["reg/hex/A00.json", "hist/A000.json", "../evil"]}
    )
    monkeypatch.setattr(site, "http_get_bytes", lambda url, **k: b'{"A00001":{}}')
    st = site.mirror(tmp_path)
    assert st == {"fetched": 1, "skipped": 1, "failed": 0}
    assert json.loads((tmp_path / "reg" / "hex" / "A00.json").read_text()) == {"keep": 1}
    assert (tmp_path / "hist" / "A000.json").exists()
    monkeypatch.setattr(site, "http_get_json", lambda *a, **k: {"files": [f"hist/B{i}.json" for i in range(20)]})
    monkeypatch.setattr(site, "http_get_bytes", lambda url, **k: b"<!DOCTYPE html><html>")
    with pytest.raises(RuntimeError):
        site.mirror(tmp_path)


def test_mirror_first_deploy(tmp_path, monkeypatch):
    def nf(*a, **k):
        raise urllib.error.HTTPError("u", 404, "nf", {}, None)

    monkeypatch.setattr(site, "http_get_json", nf)
    assert site.mirror(tmp_path) == {"fetched": 0, "skipped": 0, "failed": 0}
