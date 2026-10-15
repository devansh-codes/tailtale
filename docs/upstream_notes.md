# Upstream notes (verified 2026-10-15)

Every field below was observed in a real response. Raw responses live in
`pipeline/tests/fixtures/upstream/`. When an upstream changes, re-probe, update
the fixture, and update this file before touching code.

## ADSB.lol live API (`https://api.adsb.lol`)

All `/v2/*` endpoints return HTTP 200 with the same envelope, even when nothing matches:

```json
{"ac":[...], "msg":"No error", "now":1792073820500, "total":1, "ctime":1792073820500, "ptime":0}
```

* `now` / `ctime` are **milliseconds** since epoch.
* `total` equals `ac.length` and is the **last** key in the body (useful for cheap counting: read the tail only).
* Not found = `{"ac":[], "total":0}` (fixtures `adsblol_hex_notfound.json`, `adsblol_callsign_notfound.json`).

| Endpoint | Fixture | Notes |
|---|---|---|
| `GET /v2/hex/{hex}` | `adsblol_hex_a7197d.json` | lowercase hex works |
| `GET /v2/callsign/{cs}` | `adsblol_callsign_ASA73.json` | no padding needed in the query |
| `GET /v2/reg/{reg}` | `adsblol_reg_N557AS.json` | |
| `GET /v2/type/{icao}` | `adsblol_type_B738.json` | B738 ≈ 1,100 aircraft, ≈ 650 KB body |
| `POST /api/0/routeset` | `adsblol_routeset.json` | **returned empty HTTP 201 on every try**, as the spec warned |
| `GET /api/0/route/{cs}` | `adsblol_route_ASA73.json` | 302 redirect then JSON: `airport_codes` ("PASI-PAJN-PANC"), `_airport_codes_iata`, `_airports[]` with `icao, iata, name, location, countryiso2, lat, lon` |

Aircraft object fields observed (subset we use):
`hex` (lowercase; `~` prefix = non-ICAO address), `type` (source: `adsb_icao`, `mode_s`, `mlat`, `tisb_icao`, ...),
`flight` (callsign, right-padded with spaces to 8), `r` (registration), `t` (ICAO type), `dbFlags` (only present when non-zero),
`alt_baro` (int feet **or the string `"ground"`**, sometimes absent), `alt_geom`, `gs`, `track`, `baro_rate`, `squawk`,
`category` (e.g. `A3`), `lat`, `lon` (absent for Mode-S-only), `lastPosition {lat,lon,nic,rc,seen_pos}` (stale position),
`seen`, `seen_pos`, `messages`, `rssi`.

`dbFlags` bitfield (readsb README-json): `1` military, `2` interesting, `4` PIA, `8` LADD.
Observed: `N804VL` (B738, Vista/VXP) has `dbFlags: 8` (fixture `adsblol_hex_ladd_aaf29f.json`).

Connection resets happened when probing quickly; space requests out and back off.

## ADSB.lol daily history (`github.com/adsblol/globe_history_{YEAR}`)

* Releases API fixture: `github_releases_2026.json`.
* Three releases per day: `vYYYY.MM.DD-planes-readsb-{staging,prod,mlatonly}-0`. The prod release for day D is published
  around **03:25 UTC on D+1**.
* Prod assets are split: `....tar.aa` (exactly 2,000,000,000 bytes) + `....tar.ab` (≈1.8–1.9 GB). Concatenate in name order.
  The split is mid-member, so it must be one continuous stream.
* The tar is **uncompressed** (`ustar`). Members: `./LICENSE-ODbL.txt`, `./traces/{last2hex}/trace_full_{hex}.json`.
  ≈ 51k members in part `aa`, so ≈ 100k traces per day. Streaming part `aa` took ~90 s on a home connection.
* Some hex names start with `~` (non-ICAO / TIS-B); skip them.
* Each trace file is **gzip compressed** despite the `.json` name.

Trace file top level keys (observed): `icao`, `r`, `t`, `desc`, `dbFlags`, `ownOp`, `year`, `version`, `timestamp`,
`trace`, and `noRegData` (when there is no DB entry). `timestamp` is midnight UTC of the day (seconds, float).
**`ownOp` is an owner/operator name and can be a private person: never copy it.** Fixtures have it replaced by `REDACTED`.

Each `trace` row has 14 elements (format documented in readsb's
[README-json.md](https://github.com/wiedehopf/readsb/blob/dev/README-json.md#trace-jsons)):

| idx | meaning |
|---|---|
| 0 | seconds after `timestamp` |
| 1, 2 | lat, lon |
| 3 | altitude ft, `"ground"`, or null |
| 4 | ground speed kt or null |
| 5 | track (true heading when on ground) or null |
| 6 | flags: `1` stale, `2` start of new leg, `4` geometric vrate, `8` geometric altitude |
| 7 | vertical rate fpm or null |
| 8 | aircraft object (contains `flight`, `squawk`, `category`, ...) or null |
| 9 | source type (`adsb_icao`, `mlat`, ...) |
| 10–13 | geometric altitude, geometric vrate, IAS, roll |

## FAA Releasable Aircraft Database

`https://registry.faa.gov/database/ReleasableAircraft.zip` (73 MB) downloaded fine with a browser User-Agent.
Contents: `ACFTREF.txt DEALER.txt DEREG.txt DOCINDEX.txt ENGINE.txt MASTER.txt RESERVED.txt` (no PDF in the zip; the layout
is `https://registry.faa.gov/database/ardata.pdf`). Files are UTF-8 **with BOM**, CRLF line endings, comma delimited, fields
space padded, a **trailing comma** on every line. MASTER ≈ 317k rows.

MASTER header (verbatim): `N-NUMBER, SERIAL NUMBER, MFR MDL CODE, ENG MFR MDL, YEAR MFR, TYPE REGISTRANT, NAME, STREET,
STREET2, CITY, STATE, ZIP CODE, REGION, COUNTY, COUNTRY, LAST ACTION DATE, CERT ISSUE DATE, CERTIFICATION, TYPE AIRCRAFT,
TYPE ENGINE, STATUS CODE, MODE S CODE, FRACT OWNER, AIR WORTH DATE, OTHER NAMES(1..5), EXPIRATION DATE, UNIQUE ID,
KIT MFR, " KIT MODEL", MODE S CODE HEX`. N-NUMBER has **no leading `N`**. `MODE S CODE HEX` is uppercase hex.

ACFTREF: `CODE, MFR, MODEL, TYPE-ACFT, TYPE-ENG, AC-CAT, BUILD-CERT-IND, NO-ENG, NO-SEATS, AC-WEIGHT, SPEED, TC-DATA-SHEET, TC-DATA-HOLDER`.
ENGINE: `CODE, MFR, MODEL, TYPE, HORSEPOWER, THRUST`.

Codes (from ardata.pdf):
* Type registrant: 1 Individual, 2 Partnership, 3 Corporation, 4 Co-Owned, 5 Government, 7 LLC, 8 Non Citizen Corporation, 9 Non Citizen Co-Owned.
* Type aircraft: 1 Glider, 2 Balloon, 3 Blimp/Dirigible, 4 Fixed wing single engine, 5 Fixed wing multi engine, 6 Rotorcraft,
  7 Weight-shift-control, 8 Powered Parachute, 9 Gyroplane, H Hybrid Lift, O Other.
* Type engine: 0 None, 1 Reciprocating, 2 Turbo-prop, 3 Turbo-shaft, 4 Turbo-jet, 5 Turbo-fan, 6 Ramjet, 7 2 Cycle, 8 4 Cycle,
  9 Unknown, 10 Electric, 11 Rotary.
* Status: `V` valid, `T` valid (trainee), `M` valid (manufacturer dealer cert), plus many pending/expired/revoked codes.

Fixture `faa/MASTER.txt` is 1,000 real rows where every individual / co-owned / partnership name, every co-owner name,
and every street, city and ZIP has been replaced by a synthetic token (`PRIVATE PERSON 0001`, ...).

## adsbdb (`https://api.adsbdb.com/v0`)

* `GET /aircraft/{hex|reg}` → `{"response":{"aircraft":{type, icao_type, manufacturer, mode_s, registration,
  registered_owner_country_iso_name, registered_owner_country_name, registered_owner_operator_flag_code,
  registered_owner, url_photo, url_photo_thumbnail}}}`. Unknown → HTTP 404 `{"response":"unknown aircraft"}`.
* `GET /callsign/{cs}` → `{"response":{"flightroute":{callsign, callsign_icao, callsign_iata, airline{name,icao,iata,country,
  country_iso,callsign}, origin{...}, destination{...}}}}`; airport objects have `country_iso_name, country_name, elevation,
  iata_code, icao_code, latitude, longitude, municipality, name`. Accepts IATA flight numbers too (`UA1711`).
  Unknown → HTTP 404 `{"response":"unknown callsign"}`.

## Planespotters (`https://api.planespotters.net/pub/photos`)

`/hex/{hex}` and `/reg/{reg}` → `{"photos":[{id, thumbnail{src,size{width,height}}, thumbnail_large{src,size}, link,
photographer}]}`; none → `{"photos":[]}`. Sends `access-control-allow-origin: *`, so the browser can call it directly
(required by their terms). HEAD returns 403; use GET.

## Reference data

* OurAirports `https://davidmegginson.github.io/ourairports-data/airports.csv` (12.7 MB, 86k rows). Columns used:
  `ident, type, name, latitude_deg, longitude_deg, iso_country, municipality, scheduled_service, icao_code, iata_code, gps_code`.
  Large + medium + scheduled_service=yes ≈ 6,300 airports.
* OpenFlights `airlines.dat`: no header; columns `id, name, alias, iata, icao, callsign, country, active`; `\N` = null.

## Map tiles

OpenFreeMap public instance: free, no key, no limits stated, no cookies. Style `https://tiles.openfreemap.org/styles/positron`.
Attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".

## Rejected

* airplanes.live API now returns 403 "Please contact us at contact@airplanes.live..." for keyless use. Not usable under
  the $0 / no-signup constraint; the Provider interface stays so a source can be added later.

## Multi-value queries (verified)

`/v2/callsign/A,B,C` accepts a comma-separated list and returns every match in one response
(readsb `find_callsign`, limit 1000 entries / 8000 chars). The Worker uses this to try a flight's mainline
callsign and its regional partners (SkyWest `SKW`, Republic `RPA`, Endeavor `EDV`, ...) in **one** upstream request.
`/v2/type/A,B` also accepts lists. The bare readsb `/?find_callsign=` form is not exposed (302).
