# Static data schema

Everything below is served from `https://<project>.pages.dev/data/`. All JSON is minified with sorted keys.
Hex is always **uppercase** in keys and file names. Dates are ISO `YYYY-MM-DD` (UTC); times are Unix seconds.

## `reg/hex/{first3hex}.json` — airframe records (FAA registry)

`{ "A7197D": Record, ... }`. 224 files (`A00` … `ADF`).

| key | meaning |
|---|---|
| `hex` | Mode S code (ICAO 24-bit address), uppercase |
| `n` | N-number with the `N` prefix |
| `serial` | manufacturer serial number |
| `mfr` | manufacturer, normalized (`Boeing`, `Airbus`, `Embraer`, …) |
| `model` | family model a passenger would recognise (`737-800`, `A321neo`, `E175`) |
| `fmodel` | FAA model string as registered (`737-890`) |
| `code` | FAA manufacturer/model code (joins to ACFTREF) |
| `year` | year manufactured |
| `cat` | FAA type of aircraft (`Fixed wing multi engine`, `Rotorcraft`, …) |
| `eng_type` | FAA type of engine (`Turbofan`, `Reciprocating`, …) |
| `engines` | number of engines |
| `seats` | maximum seats (ACFTREF) |
| `engine_mfr`, `engine_model` | from ENGINE (`CFM INTL`, `CFM56-7B27`) |
| `owner_kind` | registrant type: `individual`, `partnership`, `corporation`, `co-owned`, `government`, `llc`, `non-citizen corporation`, `non-citizen co-owned`, `unknown` |
| `owner_org` | registrant name, **only** for corporation, government, LLC and non-citizen corporation |
| `cert_issued` | FAA certificate issue date = "registered to current owner since" (not a delivery date) |
| `airworthy_since` | airworthiness date |
| `status` | FAA status code (`V` valid, `T` trainee, `M` dealer; others are pending/expired) |
| `pct` | percent of currently registered airframes of the same `mfr model` built in a later year ("older than pct%") |
| `model_n` | number of currently registered airframes of that model with a known year (the percentile's denominator) |

Absent keys mean unknown. **Never present:** registrant name for individuals / partnerships / co-owners, any
street, city, state, ZIP, county or co-owner name.

## `reg/n/{first3_after_N}.json` — N-number index

`{ "N557AS": "A7197D", ... }`; file name is the 1–3 characters after `N` (`N557AS` → `557.json`, `N1` → `1.json`).

## `reg/models.json` — age percentile input

`{ "Boeing 737-800": { "n": 930, "years": { "1998": 3, ... } }, ... }` — key is `mfr + " " + model`.
Counts only currently valid registrations (`V`, `T`, `M`). `n` may exceed the histogram total when the year is unknown.
Percentile shown on the site: share of airframes in the histogram built in a **later** year.

## `reg/meta.json`

`{built_at, records, hex_shards, n_shards, models, bytes}`.

## `hist/{first4hex}.json` — 30-day flight history (ODbL, derived from ADSB.lol)

```json
{
  "A5CF41": {
    "t": "B38M",
    "last_seen": "2026-10-14",
    "days": [
      {"d": "2026-10-14", "airborne_mins": 723, "max_alt": 40025,
       "flights": [{"dep": "KDEN", "arr": "KLAS", "t_off": 1791941340, "t_on": 1791947100,
                    "mins": 96, "incomplete": false, "cs": "UAL655"}]}
    ]
  },
  "A53341": {"blocked": "2026-10-14"}
}
```

* `dep` / `arr`: airport id (ICAO code, else GPS code, else OurAirports ident) or `null` when no airport in the
  subset is within 8 km, or the end is unknown because of a coverage gap.
* `incomplete: true` means part of the flight was not observed (a gap of more than 30 minutes while airborne, or
  the flight crosses midnight UTC). We never guess what happened inside a gap.
* `cs`: most common callsign during the flight.
* `blocked`: the aircraft is in the FAA LADD or PIA program (readsb `dbFlags` & 12). No history is kept and the
  site shows type-level information only. The date is the day it was last seen flagged.
* Only days with at least one flight are stored. Entries with no days in the last 30 are removed.

### Segmentation rules (`history_etl.py`)

1. Sort by time; drop points implying > 700 kt from the previous kept point (a run of 5 consistent "impossible"
   points replaces the anchor instead).
2. Ground = altitude `"ground"`, or ground speed < 50 kt within 8 km of an airport and < 500 ft above it.
3. Takeoff = ground → airborne; departure = airport nearest the last ground point.
4. Landing = airborne → ground, or the last airborne point is < 3,000 ft **above field elevation** within 8 km of
   an airport followed by > 20 minutes of silence (or the end of the day).
5. Airborne silence > 30 minutes that is not a landing closes the flight as incomplete.
6. Flights shorter than 5 airborne minutes are discarded.
7. Airports: OurAirports `large_airport` + `medium_airport` + `scheduled_service=yes`, matched with a KD-tree
   on 3D unit vectors with an 8 km chord radius.

## `ref/airports.json`

Airports referenced by any history shard: `{ "KDEN": [iata, name, city, country, lat, lon], ... }`.

## `stats/daily.json`

`{ "days": [ {"d": "2026-10-14", "airframes": 21345, "types": {"B738": {"airframes": 512, "hours": 4120.5}}} ] }`
US-registered aircraft only, 30-day window.

## `quality/latest.json`, `quality/history.json`, `quality/run.json`

`run.json` is the raw report of the last history run. `latest.json` = `{generated_at, history: {...},
history_last_ok, registry: {...}, params: {...}}`. `history.json` = `{days: [...]}` (30 days), each day
`{d, status: "ok"|"missing", traces_read, us_traces, aircraft_flew, blocked, corrupt, points, outliers_dropped,
segments, both_airports_share, dep_matched_share, arr_matched_share, incomplete_share, split_gaps,
median_gap_mins, gap_hist_mins, hist_shards, prev_shard_fetch_failed, stream_s, runtime_s}`.

## `manifest.json`

`{ "generated_at": ..., "files": ["reg/hex/A00.json", ...] }` — every data file in the deploy. Used by the next
run to know which history shards exist on the live site.
