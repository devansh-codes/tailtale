"""FAA Releasable Aircraft Database -> static JSON shards.

Outputs (under OUT_DIR):
  reg/hex/{first3hex}.json   hex -> airframe record
  reg/n/{first3_after_N}.json N-number -> hex
  reg/models.json            model -> {n, years histogram} for age percentiles
  reg/meta.json              build info

Privacy (spec 9.1): registrant names are kept only for organizations; no addresses for anyone.
The filter runs on the parsed frame before any record is built, so private data never reaches a shard.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import tempfile
import time
import zipfile
from collections import defaultdict
from pathlib import Path

import polars as pl

from common import BROWSER_UA, OUT_DIR, http_get_bytes, log, write_json

# Overridable so the daily workflow can simulate an upstream outage.
FAA_URL = os.environ.get("TAILTALE_FAA_URL", "https://registry.faa.gov/database/ReleasableAircraft.zip")
FAA_PAGE = os.environ.get(
    "TAILTALE_FAA_PAGE",
    "https://www.faa.gov/licenses_certificates/aircraft_certification/aircraft_registry/releasable_aircraft_download",
)

MASTER_COLS = [
    "n_number",
    "serial",
    "mfr_mdl_code",
    "eng_mfr_mdl",
    "year_mfr",
    "type_registrant",
    "name",
    "street",
    "street2",
    "city",
    "state",
    "zip",
    "region",
    "county",
    "country",
    "last_action_date",
    "cert_issue_date",
    "certification",
    "type_aircraft",
    "type_engine",
    "status_code",
    "mode_s_code",
    "fract_owner",
    "air_worth_date",
    "other_name_1",
    "other_name_2",
    "other_name_3",
    "other_name_4",
    "other_name_5",
    "expiration_date",
    "unique_id",
    "kit_mfr",
    "kit_model",
    "mode_s_code_hex",
]
ACFTREF_COLS = [
    "code",
    "mfr",
    "model",
    "type_acft",
    "type_eng",
    "ac_cat",
    "build_cert_ind",
    "no_eng",
    "no_seats",
    "ac_weight",
    "speed",
    "tc_data_sheet",
    "tc_data_holder",
]
ENGINE_COLS = ["code", "mfr", "model", "type", "horsepower", "thrust"]

# Columns that may hold personal data. Dropped from the frame right after parsing.
PRIVATE_COLS = [
    "street",
    "street2",
    "city",
    "state",
    "zip",
    "county",
    "region",
    "country",
    "other_name_1",
    "other_name_2",
    "other_name_3",
    "other_name_4",
    "other_name_5",
    "unique_id",
]

REGISTRANT = {
    "1": "individual",
    "2": "partnership",
    "3": "corporation",
    "4": "co-owned",
    "5": "government",
    "7": "llc",
    "8": "non-citizen corporation",
    "9": "non-citizen co-owned",
}
# Only these registrant types may expose a name (spec 9.1).
ORG_REGISTRANT = {"3", "5", "7", "8"}

AIRCRAFT_TYPE = {
    "1": "Glider",
    "2": "Balloon",
    "3": "Blimp/Dirigible",
    "4": "Fixed wing single engine",
    "5": "Fixed wing multi engine",
    "6": "Rotorcraft",
    "7": "Weight-shift-control",
    "8": "Powered parachute",
    "9": "Gyroplane",
    "H": "Hybrid lift",
    "O": "Other",
}
ENGINE_TYPE = {
    "0": "None",
    "1": "Reciprocating",
    "2": "Turboprop",
    "3": "Turboshaft",
    "4": "Turbojet",
    "5": "Turbofan",
    "6": "Ramjet",
    "7": "2 cycle",
    "8": "4 cycle",
    "9": "Unknown",
    "10": "Electric",
    "11": "Rotary",
}
# Status codes that mean the registration is currently valid.
ACTIVE_STATUS = {"V", "T", "M"}


def read_faa_csv(path: Path, cols: list[str]) -> pl.DataFrame:
    """FAA files: UTF-8 with BOM, CRLF, comma delimited, space padded, trailing comma, one header row."""
    df = pl.read_csv(
        path,
        has_header=False,
        skip_rows=1,
        infer_schema=False,
        quote_char=None,
        truncate_ragged_lines=True,
        encoding="utf8-lossy",
        new_columns=[*cols, "_trailing"],
    )
    df = df.select(cols)
    return df.with_columns([pl.col(c).str.strip_chars() for c in cols]).with_columns(
        [pl.when(pl.col(c) == "").then(None).otherwise(pl.col(c)).alias(c) for c in cols]
    )


def iso_date(col: str) -> pl.Expr:
    return pl.col(col).str.strptime(pl.Date, "%Y%m%d", strict=False).dt.strftime("%Y-%m-%d").alias(col)


def apply_privacy_filter(master: pl.DataFrame) -> pl.DataFrame:
    """Drop every address and co-owner column, and blank NAME unless the registrant is an organization."""
    master = master.drop([c for c in PRIVATE_COLS if c in master.columns])
    return master.with_columns(
        pl.when(pl.col("type_registrant").is_in(list(ORG_REGISTRANT)))
        .then(pl.col("name"))
        .otherwise(None)
        .alias("name")
    )


# ---------------------------------------------------------------- model names

_SUFFIX_WORDS = {"INC", "CORP", "CORPORATION", "CO", "LTD", "LLC", "SA", "S", "A", "SAS", "GMBH", "LP", "AG"}
_MAKES = [
    ("AIRBUS HELICOPTERS", "Airbus Helicopters"),
    ("AIRBUS", "Airbus"),
    ("BOEING", "Boeing"),
    ("EMBRAER", "Embraer"),
    ("BOMBARDIER", "Bombardier"),
    ("CANADAIR", "Bombardier"),
    ("MCDONNELL DOUGLAS HELICOPTER", "MD Helicopters"),
    ("MCDONNELL DOUGLAS", "McDonnell Douglas"),
    ("DE HAVILLAND", "De Havilland"),
    ("CESSNA", "Cessna"),
    ("TEXTRON AVIATION", "Textron"),
    ("PIPER", "Piper"),
    ("BEECH", "Beechcraft"),
    ("RAYTHEON", "Beechcraft"),
    ("HAWKER BEECHCRAFT", "Beechcraft"),
    ("GULFSTREAM", "Gulfstream"),
    ("CIRRUS", "Cirrus"),
    ("DIAMOND", "Diamond"),
    ("MOONEY", "Mooney"),
    ("PILATUS", "Pilatus"),
    ("DASSAULT", "Dassault"),
    ("BELL", "Bell"),
    ("ROBINSON", "Robinson"),
    ("SIKORSKY", "Sikorsky"),
    ("LEARJET", "Learjet"),
    ("ATR", "ATR"),
    ("AVIONS DE TRANSPORT REGIONAL", "ATR"),
    ("SAAB", "Saab"),
    ("LOCKHEED", "Lockheed"),
]

_CRJ = {
    "CL-600-2B19": "CRJ200",
    "CL-600-2C10": "CRJ700",
    "CL-600-2C11": "CRJ550",
    "CL-600-2D15": "CRJ705",
    "CL-600-2D24": "CRJ900",
    "CL-600-2E25": "CRJ1000",
    "CL-600-2B16": "Challenger 604",
    "CL-600-1A11": "Challenger 600",
    "CL-600-2A12": "Challenger 601",
    "BD-100-1A10": "Challenger 300",
    "BD-700-1A10": "Global Express",
    "BD-700-1A11": "Global 5000",
    "BD-700-2A12": "Global 7500",
    "BD-700-2A13": "Global 8000",
    "BD-500-1A10": "A220-100",
    "BD-500-1A11": "A220-300",
}
_EMB = [
    (r"^ERJ 170-100", "E170"),
    (r"^ERJ 170-200", "E175"),
    (r"^ERJ 190-100", "E190"),
    (r"^ERJ 190-200", "E195"),
    (r"^ERJ 190-300", "E190-E2"),
    (r"^ERJ 190-400", "E195-E2"),
    (r"^EMB-145", "ERJ-145"),
    (r"^EMB-135", "ERJ-135"),
    (r"^EMB-140", "ERJ-140"),
    (r"^EMB-505", "Phenom 300"),
    (r"^EMB-500", "Phenom 100"),
    (r"^EMB-550", "Praetor 600"),
    (r"^EMB-545", "Praetor 500"),
    (r"^EMB-120", "Brasilia"),
]


def normalize_make(mfr: str | None) -> str:
    if not mfr:
        return "Unknown"
    u = mfr.upper()
    for prefix, name in _MAKES:
        if u.startswith(prefix):
            return name
    words = [w for w in re.split(r"[\s,.]+", u) if w and w not in _SUFFIX_WORDS]
    return " ".join(w.capitalize() for w in words[:3]) or mfr.title()


def normalize_model(make: str, model: str | None) -> str:
    """Collapse customer-specific FAA model strings into the family name a passenger would recognise."""
    if not model:
        return "Unknown"
    m = model.upper().strip()
    if make == "Boeing":
        mm = re.match(r"^7([0-9])7-([0-9])$", m)
        if mm and mm.group(1) == "3":
            return f"737 MAX {mm.group(2)}"
        if m == "737-10":
            return "737 MAX 10"
        mm = re.match(r"^7([0-9])7-([0-9])([0-9A-Z]{2})(ER|LR|F|PF|SF|BCF|BDSF|SP)?$", m)
        if mm:
            return f"7{mm.group(1)}7-{mm.group(2)}00{mm.group(4) or ''}"
        mm = re.match(r"^7([0-9])7-([0-9])(ER|LR|F)?$", m)
        if mm:
            return f"7{mm.group(1)}7-{mm.group(2)}{mm.group(3) or ''}"
        return m
    if make == "Airbus":
        if m in _CRJ:
            return _CRJ[m]
        mm = re.match(r"^A(3[0-9]{2})-?([0-9])[0-9]{2}(NX|N)?", m)
        if mm:
            base = f"A{mm.group(1)}"
            if mm.group(3):
                return f"{base}neo" if base in {"A319", "A320", "A321"} else f"{base}-{mm.group(2)}00neo"
            return f"{base}-{mm.group(2)}00"
        mm = re.match(r"^A300 ?(B4|F4|C4)-?6", m)
        if mm:
            return "A300-600"
        return m
    if make == "Bombardier":
        return _CRJ.get(m, m)
    if make == "Embraer":
        for pat, name in _EMB:
            if re.match(pat, m):
                return name
        return m
    return m


def display_model(mfr: str | None, model: str | None) -> tuple[str, str]:
    make = normalize_make(mfr)
    return make, normalize_model(make, model)


# ---------------------------------------------------------------- download


def download_zip(dest: Path) -> Path:
    """Download the FAA zip. registry.faa.gov sometimes rejects non-browser clients, so use a browser UA."""
    out = dest / "ReleasableAircraft.zip"
    try:
        data = http_get_bytes(FAA_URL, user_agent=BROWSER_UA, retries=4, timeout=300)
    except Exception as e:  # noqa: BLE001 - any failure falls through to the page scrape
        log(f"direct FAA download failed ({e}); scraping download page")
        page = http_get_bytes(FAA_PAGE, user_agent=BROWSER_UA).decode("utf-8", "replace")
        links = re.findall(r'href="([^"]+ReleasableAircraft[^"]*\.zip)"', page, flags=re.I)
        if not links:
            raise RuntimeError("no zip link on FAA download page") from e
        url = links[0] if links[0].startswith("http") else "https://www.faa.gov" + links[0]
        data = http_get_bytes(url, user_agent=BROWSER_UA, retries=4, timeout=300)
    if len(data) < 10_000_000:
        raise RuntimeError(f"FAA zip suspiciously small: {len(data)} bytes")
    out.write_bytes(data)
    return out


def extract(zip_path: Path, dest: Path) -> dict[str, Path]:
    paths = {}
    with zipfile.ZipFile(zip_path) as z:
        names = {n.upper(): n for n in z.namelist()}
        for want in ("MASTER.TXT", "ACFTREF.TXT", "ENGINE.TXT"):
            if want not in names:
                raise RuntimeError(f"{want} missing from FAA zip")
            p = dest / want
            with z.open(names[want]) as src, open(p, "wb") as dst:
                shutil.copyfileobj(src, dst)
            paths[want.split(".")[0]] = p
    return paths


# ---------------------------------------------------------------- build


def build_records(master_path: Path, acftref_path: Path, engine_path: Path) -> pl.DataFrame:
    master = apply_privacy_filter(read_faa_csv(master_path, MASTER_COLS))
    acft = read_faa_csv(acftref_path, ACFTREF_COLS).unique("code", keep="first")
    eng = read_faa_csv(engine_path, ENGINE_COLS).unique("code", keep="first")

    df = (
        master.filter(pl.col("mode_s_code_hex").is_not_null() & pl.col("n_number").is_not_null())
        .with_columns(
            pl.col("mode_s_code_hex").str.to_uppercase(),
            iso_date("cert_issue_date"),
            iso_date("air_worth_date"),
            pl.col("year_mfr").cast(pl.Int32, strict=False),
        )
        .join(
            acft.select(
                pl.col("code").alias("mfr_mdl_code"),
                pl.col("mfr").alias("acft_mfr"),
                pl.col("model").alias("acft_model"),
                pl.col("no_eng").cast(pl.Int32, strict=False).alias("no_eng"),
                pl.col("no_seats").cast(pl.Int32, strict=False).alias("no_seats"),
            ),
            on="mfr_mdl_code",
            how="left",
        )
        .join(
            eng.select(
                pl.col("code").alias("eng_mfr_mdl"),
                pl.col("mfr").alias("eng_mfr"),
                pl.col("model").alias("eng_model"),
            ),
            on="eng_mfr_mdl",
            how="left",
        )
        .filter(pl.col("mode_s_code_hex").str.contains(r"^[0-9A-F]{6}$"))
    )
    return df


def to_record(r: dict) -> dict:
    make, model = display_model(r["acft_mfr"], r["acft_model"])
    eng_model = r["eng_model"]
    if eng_model and eng_model.upper() == "NONE":
        eng_model = None
    rec = {
        "hex": r["mode_s_code_hex"],
        "n": "N" + r["n_number"],
        "serial": r["serial"],
        "mfr": make,
        "model": model,
        "fmodel": r["acft_model"],
        "code": r["mfr_mdl_code"],
        "year": r["year_mfr"],
        "cat": AIRCRAFT_TYPE.get(r["type_aircraft"] or ""),
        "eng_type": ENGINE_TYPE.get(r["type_engine"] or ""),
        "engines": r["no_eng"],
        "seats": r["no_seats"],
        "engine_mfr": r["eng_mfr"] if eng_model else None,
        "engine_model": eng_model,
        "owner_kind": REGISTRANT.get(r["type_registrant"] or "", "unknown"),
        "owner_org": r["name"] if (r["type_registrant"] in ORG_REGISTRANT) else None,
        "cert_issued": r["cert_issue_date"],
        "airworthy_since": r["air_worth_date"],
        "status": r["status_code"],
    }
    return {k: v for k, v in rec.items() if v is not None}


def model_key(rec: dict) -> str:
    return f"{rec.get('mfr', 'Unknown')} {rec.get('model', 'Unknown')}"


def write_shards(records: list[dict], out_dir: Path) -> dict:
    hex_shards: dict[str, dict] = defaultdict(dict)
    n_shards: dict[str, dict] = defaultdict(dict)
    models: dict[str, dict] = {}
    for rec in records:
        hex_shards[rec["hex"][:3]][rec["hex"]] = rec
        n_after = rec["n"][1:]
        n_shards[n_after[:3]][rec["n"]] = rec["hex"]
        if rec.get("status") in ACTIVE_STATUS:
            m = models.setdefault(model_key(rec), {"n": 0, "years": defaultdict(int)})
            m["n"] += 1
            if rec.get("year"):
                m["years"][str(rec["year"])] += 1

    # Precompute the age percentile into each record so the plane page never downloads models.json.
    for rec in records:
        m = models.get(model_key(rec))
        if not m or not rec.get("year"):
            continue
        dated = sum(m["years"].values())
        if dated < 2:
            continue
        newer = sum(c for y, c in m["years"].items() if int(y) > rec["year"])
        rec["pct"] = round(100 * newer / dated)
        rec["model_n"] = dated

    reg = out_dir / "reg"
    tmp = out_dir / "reg.new"
    if tmp.exists():
        shutil.rmtree(tmp)
    total = 0
    for k, v in hex_shards.items():
        total += write_json(tmp / "hex" / f"{k}.json", v)
    for k, v in n_shards.items():
        total += write_json(tmp / "n" / f"{k}.json", v)
    models_out = {k: {"n": v["n"], "years": dict(v["years"])} for k, v in models.items()}
    total += write_json(tmp / "models.json", models_out)
    meta = {
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "records": len(records),
        "hex_shards": len(hex_shards),
        "n_shards": len(n_shards),
        "models": len(models_out),
        "bytes": total,
    }
    write_json(tmp / "meta.json", meta)
    # Swap atomically-ish so a crash mid-write never leaves a half registry in place.
    if reg.exists():
        shutil.rmtree(reg)
    tmp.rename(reg)
    return meta


def run(out_dir: Path, zip_path: Path | None = None, min_records: int = 200_000) -> dict:
    t0 = time.time()
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        if zip_path is None:
            log("downloading FAA registry")
            zip_path = download_zip(tdp)
        paths = extract(zip_path, tdp)
        log("parsing")
        df = build_records(paths["MASTER"], paths["ACFTREF"], paths["ENGINE"])
        records = [to_record(r) for r in df.iter_rows(named=True)]
    if len(records) < min_records:
        # Never publish an empty or truncated registry: keep yesterday's shards.
        raise RuntimeError(f"only {len(records)} records parsed; refusing to overwrite registry")
    meta = write_shards(records, out_dir)
    meta["runtime_s"] = round(time.time() - t0, 1)
    log("registry done", meta)
    return meta


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--zip", type=Path, help="use a local ReleasableAircraft.zip instead of downloading")
    ap.add_argument("--min-records", type=int, default=200_000)
    a = ap.parse_args(argv)
    try:
        run(a.out, a.zip, a.min_records)
    except Exception as e:  # noqa: BLE001
        log(f"FAA registry step failed, previous shards kept: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
