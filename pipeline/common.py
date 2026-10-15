"""Shared helpers for the TailTale pipeline: paths, HTTP with backoff, JSON writing."""

from __future__ import annotations

import os
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import orjson

REPO_URL = os.environ.get("TAILTALE_REPO_URL", "https://github.com/devansh-codes/tailtale")
USER_AGENT = f"TailTale/1.0 (+{REPO_URL})"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
)

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = Path(os.environ.get("TAILTALE_OUT", ROOT / "out" / "data"))
CACHE_DIR = Path(os.environ.get("TAILTALE_CACHE", ROOT / "out" / "cache"))
SITE_URL = os.environ.get("TAILTALE_SITE_URL", "https://tailtale.pages.dev").rstrip("/")

# US civil ICAO 24-bit address block assigned to N-numbers.
US_HEX_MIN = 0xA00001
US_HEX_MAX = 0xADF7C7


def log(*args: object) -> None:
    print(time.strftime("%H:%M:%S"), *args, file=sys.stderr, flush=True)


def is_us_hex(hex_str: str) -> bool:
    try:
        v = int(hex_str, 16)
    except (TypeError, ValueError):
        return False
    return len(hex_str) == 6 and US_HEX_MIN <= v <= US_HEX_MAX


def http_open(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    user_agent: str = USER_AGENT,
    retries: int = 4,
    timeout: float = 60,
    data: bytes | None = None,
):
    """Open a URL with an identifying User-Agent and exponential backoff on 429/5xx/network errors.

    Returns the response object (caller reads/streams it). 404 raises immediately.
    """
    h = {"User-Agent": user_agent}
    if headers:
        h.update(headers)
    delay = 2.0
    last: Exception | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers=h, data=data)
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise
            retry_after = e.headers.get("Retry-After")
            wait = float(retry_after) if retry_after and retry_after.isdigit() else delay
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            if attempt == retries:
                raise
            wait = delay
        log(f"retry {attempt + 1}/{retries} for {url} in {wait:.0f}s ({last})")
        time.sleep(wait)
        delay *= 2
    raise RuntimeError(f"unreachable: {last}")


def http_get_bytes(url: str, **kw) -> bytes:
    with http_open(url, **kw) as r:
        return r.read()


def http_get_json(url: str, **kw):
    return orjson.loads(http_get_bytes(url, **kw))


def dumps(obj) -> bytes:
    """Minified JSON with sorted keys so output is deterministic."""
    return orjson.dumps(obj, option=orjson.OPT_SORT_KEYS | orjson.OPT_NON_STR_KEYS)


def write_json(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = dumps(obj)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    return len(data)


def read_json(path: Path, default=None):
    try:
        return orjson.loads(path.read_bytes())
    except (FileNotFoundError, orjson.JSONDecodeError):
        return default


def iter_files(root: Path) -> Iterator[Path]:
    for p in root.rglob("*"):
        if p.is_file():
            yield p
