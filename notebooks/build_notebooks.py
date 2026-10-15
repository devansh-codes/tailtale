# Regenerate: cd pipeline && uv run --group notebooks python ../notebooks/build_notebooks.py ../notebooks
# then execute: TAILTALE_OUT=../out/data uv run --project ../pipeline --group notebooks jupyter nbconvert --to notebook --execute --inplace *.ipynb
"""Generate the two TailTale notebooks (executed afterwards with nbconvert)."""

import sys
from pathlib import Path

import nbformat as nbf

OUT = Path(sys.argv[1])

COMMON = r'''
import json, os, re
from pathlib import Path
import numpy as np
import polars as pl
import matplotlib.pyplot as plt

REPO = Path.cwd().parent if Path.cwd().name == "notebooks" else Path.cwd()
DATA = Path(os.environ.get("TAILTALE_OUT", REPO / "out" / "data"))
assert (DATA / "reg").exists(), f"run the pipeline first (looked in {DATA})"

# Chart style: thin marks, recessive axes, the site's palette.
BLUE, ORANGE, INK, MUTED, GRID = "#2a78d6", "#eb6834", "#0b0b0b", "#898781", "#e1e0d9"
plt.rcParams.update({
    "figure.dpi": 110, "axes.spines.top": False, "axes.spines.right": False, "axes.edgecolor": "#c3c2b7",
    "axes.labelcolor": "#52514e", "xtick.color": MUTED, "ytick.color": MUTED, "axes.grid": True,
    "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True, "font.size": 10,
})

def load_shards(sub):
    out = {}
    for p in sorted((DATA / sub).glob("*.json")):
        out.update(json.loads(p.read_bytes()))
    return out

AIRLINER_TYPES = {
    "A319","A320","A321","A20N","A21N","BCS1","BCS3","A332","A333","A339","A359","A35K","A388","B712","B737","B738",
    "B739","B38M","B39M","B752","B753","B763","B764","B772","B77W","B77L","B788","B789","B78X","B744","B748","E170",
    "E75L","E75S","E190","E195","E290","CRJ2","CRJ7","CRJ9","CRJX","AT76","DH8D","MD11","A306",
}

def headline(key, items):
    """Merge this notebook's headline numbers into web/src/headlines.json (shown on the Data Quality page)."""
    p = REPO / "web" / "src" / "headlines.json"
    cur = json.loads(p.read_text()) if p.exists() else {}
    cur.setdefault("sections", {})[key] = items
    cur.pop("items", None)
    run = json.loads((DATA / "quality" / "run.json").read_text())
    cur["as_of"] = f"history day {run['d']}, FAA registry {json.loads((DATA / 'reg' / 'meta.json').read_text())['built_at'][:10]}"
    p.write_text(json.dumps(cur, indent=2) + "\n")
    for i in items:
        print("•", i)
'''


def md(s):
    return nbf.v4.new_markdown_cell(s.strip())


def code(s):
    return nbf.v4.new_code_cell(s.strip())


meta = {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}}

# ------------------------------------------------------------------------------------------------ coverage
nb = nbf.v4.new_notebook(metadata=meta)
nb.cells = [
    md("""
# Coverage and gaps

How complete is volunteer ADS-B coverage for US aircraft, where does it fail, and can we trust the airports we
assign to each flight?

Inputs are the pipeline outputs (`out/data`, or `$TAILTALE_OUT`): the 30-day history shards (`hist/*.json`), the
latest run report (`quality/run.json`) and a route spot check (`quality/spot_check_25.json`, produced by
`pipeline/spot_check.py --n 25`). Segmentation rules are documented in `pipeline/SCHEMA.md`.
"""),
    code(COMMON),
    code(r'''
hist = load_shards("hist")
run = json.loads((DATA / "quality" / "run.json").read_text())
rows = []
for hx, e in hist.items():
    for d in e.get("days", []):
        for f in d["flights"]:
            rows.append({"hex": hx, "t": e.get("t"), "d": d["d"], **{k: f.get(k) for k in ("dep","arr","t_off","t_on","mins","incomplete","cs")}})
fl = pl.DataFrame(rows).with_columns(
    pl.col("t").is_in(list(AIRLINER_TYPES)).alias("airliner"),
    (pl.col("dep").is_not_null() & pl.col("arr").is_not_null()).alias("both"),
)
day0 = pl.col("d").str.strptime(pl.Date).cast(pl.Datetime("ms")).dt.epoch("s")
fl = fl.with_columns(
    ((pl.col("t_off") - day0) < 120).alias("starts_at_midnight"),
    ((day0 + 86400 - pl.col("t_on")) < 120).alias("ends_at_midnight"),
)
print(f"{fl.height:,} flights from {fl['hex'].n_unique():,} aircraft over {fl['d'].n_unique()} day(s); "
      f"{len([e for e in hist.values() if e.get('blocked')]):,} LADD/PIA aircraft kept as stubs only")
'''),
    md("## 1. How much of each flight do we see?\n\nAirliners fly between big airports inside dense receiver coverage, so they should look much better than the all-aircraft average, which includes general aviation flying from small fields we deliberately do not match."),
    code(r'''
summary = (fl.group_by("airliner").agg(
    pl.len().alias("flights"),
    pl.col("incomplete").mean().alias("incomplete"),
    pl.col("both").mean().alias("both_airports"),
    (pl.col("incomplete") & ~pl.col("starts_at_midnight") & ~pl.col("ends_at_midnight")).mean().alias("gap_only"),
).sort("airliner", descending=True))
summary
'''),
    code(r'''
air = summary.filter(pl.col("airliner")).row(0, named=True)
ga = summary.filter(~pl.col("airliner")).row(0, named=True)
fig, ax = plt.subplots(figsize=(6.4, 2.6))
labels = ["Both airports matched", "Partly observed", "Partly observed (mid-flight gap only)"]
vals_a = [air["both_airports"], air["incomplete"], air["gap_only"]]
vals_g = [ga["both_airports"], ga["incomplete"], ga["gap_only"]]
y = np.arange(len(labels))
ax.barh(y - 0.18, [v * 100 for v in vals_a], 0.34, color=BLUE, label="Airliners")
ax.barh(y + 0.18, [v * 100 for v in vals_g], 0.34, color=ORANGE, label="Everything else")
ax.set_yticks(y, labels); ax.invert_yaxis(); ax.set_xlabel("% of flights"); ax.set_xlim(0, 100)
for i, (a, g) in enumerate(zip(vals_a, vals_g)):
    ax.text(a * 100 + 1, i - 0.18, f"{a:.0%}", va="center", fontsize=9, color=INK)
    ax.text(g * 100 + 1, i + 0.18, f"{g:.0%}", va="center", fontsize=9, color=INK)
ax.legend(frameon=False, loc="lower right"); ax.grid(axis="y", visible=False)
plt.tight_layout(); plt.show()
'''),
    md("## 2. Why flights are only partly observed\n\nA flight can be cut because it crossed midnight UTC (each daily archive ends at 24:00) or because receivers lost it for more than 30 minutes while airborne."),
    code(r'''
inc = fl.filter(pl.col("incomplete"))
reasons = inc.select(
    (pl.col("starts_at_midnight") | pl.col("ends_at_midnight")).alias("midnight"),
).to_series().value_counts().sort("midnight")
print(reasons)
gaps = run["gap_hist_mins"]
order = ["30-60", "60-120", "120-240", "240-480", "480+"]
fig, ax = plt.subplots(figsize=(6.4, 2.4))
ax.bar(order, [gaps[k] for k in order], color=BLUE, width=0.8)
ax.set_xlabel("Length of airborne silence (minutes)"); ax.set_ylabel("Gaps"); ax.grid(axis="x", visible=False)
plt.tight_layout(); plt.show()
print(f"median gap {run['median_gap_mins']} min across {run['split_gaps']:,} gaps")
'''),
    md("## 3. Where gaps happen\n\nWe do not store gap positions, but the departure airport of partly observed airliner flights is a good proxy: oceanic and remote routes dominate."),
    code(r'''
refs = json.loads((DATA / "ref" / "airports.json").read_text())
by_dep = (fl.filter(pl.col("airliner") & pl.col("dep").is_not_null() & ~pl.col("starts_at_midnight") & ~pl.col("ends_at_midnight"))
          .group_by("dep").agg(pl.len().alias("flights"), pl.col("incomplete").mean().alias("gap_share"))
          .filter(pl.col("flights") >= 15).sort("gap_share", descending=True))
by_dep = by_dep.with_columns(pl.col("dep").map_elements(lambda c: (refs.get(c) or [None, c])[1], return_dtype=pl.Utf8).alias("airport"))
by_dep.head(12)
'''),
    md("""
## 4. Are the airports right?

For a sample of airliners we compare each **completed** flight's departure and arrival with two published callsign
route tables (adsbdb; ADSB.lol's multi-leg route) and check **leg continuity**: the arrival airport of one flight
should be the departure airport of the aircraft's next flight. Precision here = share of our assignments that a
reference agrees with, among flights where a reference exists.
"""),
    code(r'''
spot_path = DATA / "quality" / "spot_check_25.json"
if not spot_path.exists():
    spot_path = DATA / "quality" / "spot_check.json"
spot = json.loads(spot_path.read_text())
sr = pl.DataFrame(spot["rows"])
def ref_pairs(r):
    pairs = [tuple(x.split("-")) for x in r["adsblol_legs"]]
    if r["adsbdb"]:
        pairs.append(tuple(r["adsbdb"].split("-")))
    return pairs
ev = []
for r in spot["rows"]:
    pairs = ref_pairs(r)
    if not pairs:
        continue
    dep, arr = r["ours"].split("-")
    ev.append({"dep_ok": any(p[0] == dep for p in pairs), "arr_ok": any(p[1] == arr for p in pairs),
               "both_ok": (dep, arr) in pairs, "dep_any": any(dep in p for p in pairs), "arr_any": any(arr in p for p in pairs)})
ev = pl.DataFrame(ev)
prec = {k: ev[k].mean() for k in ev.columns}
cont_share, cont_n = spot["continuity"]  # full-sample summary written by spot_check.py
print(f"{spot['aircraft']} aircraft, {spot['flights']} completed flights; precision below uses the {len(spot['rows'])} saved rows, {ev.height} with a published route")
print(f"departure precision {prec['dep_ok']:.0%}, arrival precision {prec['arr_ok']:.0%}, exact pair {prec['both_ok']:.0%}")
print(f"our airport appears anywhere in the published route: dep {prec['dep_any']:.0%}, arr {prec['arr_any']:.0%}")
print(f"leg continuity {cont_share:.0%} over {cont_n} consecutive legs")
'''),
    md("""
**Reading this honestly.** Continuity is a self-consistency check: if takeoff/landing detection were wrong we
would see a plane "teleport" between legs, and we don't. Disagreement with the route tables is mostly about the
references: they are keyed by callsign, many are stale, and airlines reuse one flight number for several legs
(Southwest especially), so a reference often names a different leg of the same flight number. Where our airport
appears *anywhere* in the published itinerary, we are almost always describing one of its legs.
"""),
    code(r'''
headline("coverage", [
    f"Airliners: {air['both_airports']:.0%} of flights have both airports matched and {air['incomplete']:.0%} are partly observed "
    f"(all US aircraft incl. general aviation: {fl['both'].mean():.0%} and {fl['incomplete'].mean():.0%}).",
    f"{reasons.filter(pl.col('midnight'))['count'].sum() / max(inc.height, 1):.0%} of partly observed flights are simply split at midnight UTC; "
    f"the rest lost coverage mid-flight (median silence {run['median_gap_mins']:.0f} min).",
    f"Leg continuity is {cont_share:.0%} over {cont_n} consecutive airliner legs: each landing airport matched the next takeoff airport.",
    f"Published route tables agree with our departure airport {prec['dep_ok']:.0%} and arrival {prec['arr_ok']:.0%} of the time; "
    f"our airports appear somewhere in the published itinerary {min(prec['dep_any'], prec['arr_any']):.0%}+ of the time.",
])
'''),
]
nbf.write(nb, OUT / "coverage_and_gaps.ipynb")

# ------------------------------------------------------------------------------------------------ fleet
nb = nbf.v4.new_notebook(metadata=meta)
nb.cells = [
    md("""
# Fleet insights

Age distributions from the FAA registry (`reg/hex/*.json`, all ~317k US registrations) and utilization from the
ADS-B flight history (`hist/*.json`). Owner names only exist for organizations; private owners were filtered out
in the pipeline and never reach these files.
"""),
    code(COMMON),
    code(r'''
reg = pl.DataFrame(list(load_shards("reg/hex").values()), infer_schema_length=None)
active = reg.filter(pl.col("status").is_in(["V", "T", "M"]))
jets = active.filter((pl.col("eng_type") == "Turbofan") & (pl.col("seats") >= 50) & pl.col("year").is_not_null())
jets = jets.with_columns((2026 - pl.col("year")).alias("age"), (pl.col("mfr") + " " + pl.col("model")).alias("type"))
print(f"{reg.height:,} registrations, {active.height:,} valid, {jets.height:,} turbofan aircraft with 50+ seats")
'''),
    md("## 1. How old are US airliners?"),
    code(r'''
top = jets.group_by("type").agg(pl.len().alias("n"), pl.col("age").median().alias("median_age"),
                                pl.col("age").quantile(0.25).alias("p25"), pl.col("age").quantile(0.75).alias("p75"),
                                pl.col("age").max().alias("oldest")).filter(pl.col("n") >= 60).sort("n", descending=True).head(15)
top
'''),
    code(r'''
order = top.sort("median_age")["type"].to_list()
fig, ax = plt.subplots(figsize=(6.6, 4.6))
data = [jets.filter(pl.col("type") == t)["age"].to_numpy() for t in order]
bp = ax.boxplot(data, vert=False, widths=0.55, patch_artist=True, showfliers=False,
                medianprops={"color": INK, "linewidth": 1.5}, whiskerprops={"color": MUTED}, capprops={"color": MUTED},
                boxprops={"facecolor": "#cde2fb", "edgecolor": BLUE})
ax.set_yticks(range(1, len(order) + 1), [f"{t} ({len(d):,})" for t, d in zip(order, data)])
ax.set_xlabel("Age in years (FAA year of manufacture)"); ax.grid(axis="y", visible=False)
plt.tight_layout(); plt.show()
'''),
    md("## 2. Who owns the airliners?\n\nThe registered owner is frequently a bank or trust acting as trustee for a lessor, not the airline whose paint is on the plane."),
    code(r'''
own = jets.with_columns(
    pl.when(pl.col("owner_org").str.contains(r"TRUST|BANK|TRUSTEE|LEASING|CAPITAL|FINANCE")).then(pl.lit("Bank, trust or lessor"))
      .when(pl.col("owner_org").is_null()).then(pl.lit("Not listed"))
      .otherwise(pl.lit("Operator / other company")).alias("owner_class"))
own_share = own.group_by("owner_class").agg(pl.len().alias("n")).with_columns((pl.col("n") / pl.col("n").sum()).alias("share")).sort("n", descending=True)
print(own_share)
print(own.filter(pl.col("owner_class") == "Bank, trust or lessor").group_by("owner_org").len().sort("len", descending=True).head(8))
'''),
    md("## 3. Utilization: how hard do they work?\n\nFlights and airborne hours per airframe per day it was seen flying, joined to the registry by hex. Only completed days in the history window are used."),
    code(r'''
hist = load_shards("hist")
rows = [{"hex": h, "d": d["d"], "flights": len(d["flights"]), "hours": d["airborne_mins"] / 60, "t": e.get("t"),
         "airline": next((f["cs"][:3] for f in d["flights"] if f.get("cs") and re.match(r"^[A-Z]{3}\d", f["cs"])), None)}
        for h, e in hist.items() for d in e.get("days", [])]
days = pl.DataFrame(rows).join(jets.select("hex", "type", "age"), on="hex", how="inner")
airlines = json.loads((REPO / "worker" / "src" / "generated" / "airlines.json").read_text())
icao_name = {v["icao"]: v["name"] for v in airlines.values()}
util_type = days.group_by("type").agg(pl.len().alias("airframe_days"), pl.col("flights").mean().alias("flights_per_day"),
                                      pl.col("hours").mean().alias("hours_per_day")).filter(pl.col("airframe_days") >= 40).sort("hours_per_day", descending=True)
util_air = (days.filter(pl.col("airline").is_not_null()).group_by("airline")
            .agg(pl.len().alias("airframe_days"), pl.col("flights").mean().alias("flights_per_day"), pl.col("hours").mean().alias("hours_per_day"))
            .filter(pl.col("airframe_days") >= 60).sort("hours_per_day", descending=True)
            .with_columns(pl.col("airline").replace_strict(icao_name, default=pl.col("airline")).alias("name")))
print(util_type.head(12)); print(util_air.head(15))
'''),
    code(r'''
u = util_air.head(14).sort("hours_per_day")
fig, ax = plt.subplots(figsize=(6.4, 4.2))
ax.barh(u["name"], u["hours_per_day"], color=BLUE, height=0.7)
for i, (h, f) in enumerate(zip(u["hours_per_day"], u["flights_per_day"])):
    ax.text(h + 0.1, i, f"{h:.1f} h · {f:.1f} flights", va="center", fontsize=8.5, color=INK)
ax.set_xlabel("Airborne hours per airframe per flying day (observed)"); ax.grid(axis="y", visible=False)
ax.set_xlim(0, u["hours_per_day"].max() * 1.35)
plt.tight_layout(); plt.show()
'''),
    md("## 4. Something surprising: who opts out of tracking?\n\nAircraft in the FAA LADD/PIA privacy programs keep only a stub in our history. Joining those stubs to the registry shows which kinds of aircraft opt out. Note the difference between *count* (piston aircraft are most numerous) and *rate* (business jets opt out far more often)."),
    code(r'''
blocked = pl.DataFrame({"hex": [h for h, e in hist.items() if e.get("blocked")]})
b = blocked.join(active.select("hex", "eng_type", "seats", "owner_kind"), on="hex", how="left")
seen = pl.DataFrame({"hex": list(hist.keys())}).join(active.select("hex", "eng_type", "seats"), on="hex", how="inner")
def kind(df):
    return df.with_columns(pl.when((pl.col("eng_type") == "Turbofan") & (pl.col("seats") < 20)).then(pl.lit("Business jet"))
        .when(pl.col("eng_type") == "Turbofan").then(pl.lit("Airliner"))
        .when(pl.col("eng_type") == "Turboprop").then(pl.lit("Turboprop"))
        .when(pl.col("eng_type").is_null()).then(pl.lit("Not in registry"))
        .otherwise(pl.lit("Piston / other")).alias("kind"))
opt = kind(b).group_by("kind").len().join(kind(seen).group_by("kind").len().rename({"len": "seen"}), on="kind", how="left")
opt = opt.with_columns((pl.col("len") / pl.col("seen")).alias("opt_out_rate")).sort("len", descending=True)
opt
'''),
    code(r'''
bj = opt.filter(pl.col("kind") == "Business jet")
pist = opt.filter(pl.col("kind") == "Piston / other")
oldest = top.sort("median_age", descending=True).row(0, named=True)
youngest = top.sort("median_age").row(0, named=True)
lessor = own_share.filter(pl.col("owner_class") == "Bank, trust or lessor")["share"]
best = util_air.row(0, named=True) if util_air.height else None
headline("fleet", [
    f"The oldest common US airliner type is the {oldest['type']} (median {oldest['median_age']:.0f} years); the youngest is the {youngest['type']} ({youngest['median_age']:.0f}).",
    f"{lessor[0]:.0%} of US airliners are registered to a bank, trust or lessor rather than the airline that flies them." if len(lessor) else "Owner classes unavailable.",
    (f"Hardest-working fleet in the sample: {best['name']}, {best['hours_per_day']:.1f} airborne hours per aircraft per flying day." if best else "Utilization needs more history."),
    (f"Business jets opt out of public tracking (FAA LADD/PIA) at the highest rate: {bj['opt_out_rate'][0]:.0%} of those seen flying, "
     f"vs {pist['opt_out_rate'][0]:.0%} of piston aircraft." if bj.height and pist.height else "Opt-out breakdown unavailable."),
])
'''),
]
nbf.write(nb, OUT / "fleet_insights.ipynb")
print("written")
