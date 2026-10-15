# Attribution and licenses

TailTale combines the following sources. Thank you to everyone who runs a receiver, takes a photo, or maintains
these datasets.

| Source | Used for | License / terms |
|---|---|---|
| [ADSB.lol](https://adsb.lol) | Live aircraft positions (`api.adsb.lol`) and daily history archives ([globe_history](https://github.com/adsblol)) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| [FAA Civil Aircraft Registry](https://registry.faa.gov/aircraftinquiry/) | Airframe facts (Releasable Aircraft Database) | Public US government data |
| [Planespotters.net](https://www.planespotters.net) | Aircraft photos | Called from the browser only; every photo shows its photographer's credit and links to its Planespotters page; URLs used unchanged; never cached, proxied, or put in generated images |
| [adsbdb.com](https://www.adsbdb.com) | Aircraft and callsign route enrichment | Free public API |
| [OurAirports](https://ourairports.com/data/) | Airport coordinates and codes | Public domain |
| [OpenFlights](https://openflights.org/data) | Airline IATA/ICAO codes (`airlines.dat`) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| [OpenFreeMap](https://openfreemap.org) | Map tiles | © [OpenMapTiles](https://openmaptiles.org), data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL) |

## Derived databases

* **Flight history shards** (`/data/hist/*.json`, `/data/stats/daily.json`, `/data/quality/*`) are derived from
  ADSB.lol data and are published under the **Open Database License (ODbL) 1.0**. Any public use must attribute
  ADSB.lol and TailTale and keep the ODbL.
* **Airline code map** (`worker/src/generated/airlines.json`) is derived from OpenFlights and is published under
  **ODbL 1.0**, with hand-curated overrides in `data/airline_overrides.json`.
* **Registry shards** (`/data/reg/*`) are derived from public FAA data. Individual owners' names and every address
  are removed before publication.

## Code

The TailTale source code is MIT licensed (see `LICENSE`). Aircraft silhouettes are original drawings.
