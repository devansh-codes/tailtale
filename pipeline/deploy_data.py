"""Deploy helpers for the daily job.

  deploy_data.py mirror   [--out DIR]       download the live site's /data (per its manifest) into DIR for files we lack
  deploy_data.py manifest [--out DIR]       write DIR/manifest.json listing every data file
  deploy_data.py validate DIST              fail if DIST breaks Cloudflare Pages limits (< 19,000 files, each < 24 MiB)

The deployed site is the data store (generated data is never committed), so when the Actions cache is gone the
mirror step is what lets a failed ETL still redeploy yesterday's data instead of nothing.
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import OUT_DIR, SITE_URL, http_get_bytes, http_get_json, iter_files, log, write_json

MAX_FILES = 19_000
MAX_BYTES = 24 * 1024 * 1024


def build_manifest(out: Path) -> dict:
    files = sorted(
        str(p.relative_to(out)).replace("\\", "/")
        for p in iter_files(out)
        if p.name != "manifest.json" and not p.name.endswith(".tmp")
    )
    m = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": files}
    write_json(out / "manifest.json", m)
    return m


def mirror(out: Path, workers: int = 24) -> dict:
    try:
        manifest = http_get_json(f"{SITE_URL}/data/manifest.json", retries=3, timeout=60)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            log("live site has no manifest yet (first deploy); nothing to mirror")
            return {"fetched": 0, "skipped": 0, "failed": 0}
        raise
    files = [f for f in manifest.get("files", []) if ".." not in f and not f.startswith("/")]
    todo = [f for f in files if not (out / f).exists()]
    stats = {"fetched": 0, "skipped": len(files) - len(todo), "failed": 0}

    def get(rel: str) -> None:
        try:
            data = http_get_bytes(f"{SITE_URL}/data/{rel}", retries=3, timeout=60)
            if data[:15].lstrip().lower().startswith(b"<!doctype"):
                raise ValueError("got the SPA fallback page")
            p = out / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            stats["fetched"] += 1
        except Exception as e:  # noqa: BLE001
            stats["failed"] += 1
            log(f"mirror failed for {rel}: {e}")

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(get, todo))
    log("mirror", stats)
    if stats["failed"] > max(10, 0.01 * len(files)):
        raise RuntimeError(f"mirror incomplete: {stats}")
    return stats


def validate(dist: Path) -> list[str]:
    problems = []
    files = list(iter_files(dist))
    if len(files) >= MAX_FILES:
        problems.append(f"{len(files)} files (limit {MAX_FILES})")
    for p in files:
        if p.stat().st_size >= MAX_BYTES:
            problems.append(f"{p.relative_to(dist)} is {p.stat().st_size / 1e6:.1f} MB")
    log(f"validate: {len(files)} files, largest {max((p.stat().st_size for p in files), default=0) / 1e6:.1f} MB")
    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("mirror", "manifest"):
        s = sub.add_parser(name)
        s.add_argument("--out", type=Path, default=OUT_DIR)
    v = sub.add_parser("validate")
    v.add_argument("dist", type=Path)
    a = ap.parse_args(argv)
    if a.cmd == "mirror":
        mirror(a.out)
    elif a.cmd == "manifest":
        log(f"manifest: {len(build_manifest(a.out)['files'])} files")
    else:
        problems = validate(a.dist)
        for p in problems:
            log("LIMIT:", p)
        return 1 if problems else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
