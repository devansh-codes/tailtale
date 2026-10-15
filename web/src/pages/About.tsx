import { Link, useTitle } from "../router";

export function About() {
  useTitle("About and data | TailTale");
  return (
    <article className="prose">
      <h1>About TailTale</h1>
      <p>
        TailTale tells the story of one specific airframe: the plane you're sitting in. It joins three public sources: the live position broadcast by
        the aircraft's transponder, the FAA's aircraft registry, and a nightly-built 30-day flight history.
      </p>

      <h2>How it works</h2>
      <ul>
        <li>
          <strong>Finding your plane.</strong> A flight number like DL1234 is turned into the callsign airlines broadcast (DAL1234). Regional flights
          often fly under the partner's callsign (SkyWest, Republic, Endeavor…), so we check those too, in the same single request. If a plane isn't
          transmitting yet, the tail number always works.
        </li>
        <li>
          <strong>Airframe facts</strong> come from the FAA Releasable Aircraft Database, refreshed nightly and split into small static files.
        </li>
        <li>
          <strong>Where it has been.</strong> Every night a pipeline streams the previous day's ADSB.lol history archive (about 4 GB), splits each US
          aircraft's track into flights, and matches takeoffs and landings to airports within 8 km. Gaps in coverage are marked, never guessed.
        </li>
        <li>
          <strong>Siblings in the sky</strong> are counted every 10 minutes for 40 common airliner types.
        </li>
      </ul>

      <h2>Limitations</h2>
      <ul>
        <li>Coverage depends on volunteers' receivers. Oceans and remote areas have gaps, so some flights are only partly observed.</li>
        <li>Planes at the gate often aren't transmitting before pushback. Enter the tail number instead.</li>
        <li>Published routes for a callsign can be out of date; airlines reuse flight numbers.</li>
        <li>
          “Registered to current owner since” is the FAA certificate date, not the delivery date. Many airliners are registered to banks or leasing
          trusts, not the airline that flies them.
        </li>
        <li>Full airframe details are US-only (N-numbers). Other aircraft get a reduced card.</li>
      </ul>

      <h2>Privacy</h2>
      <p>
        We never store or show names or addresses of individual owners. Only organizations (corporations, LLCs, governments) are named. Aircraft whose
        owners joined the FAA's LADD or PIA privacy programs get type information only: no position, no history. We don't use cookies or analytics.
      </p>

      <h2>Data sources and licenses</h2>
      <ul>
        <li>
          <a href="https://adsb.lol">ADSB.lol</a>: live and historical ADS-B data, licensed{" "}
          <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL 1.0</a>. Our derived flight-history files (<code>/data/hist/</code>) are published
          under the same ODbL license.
        </li>
        <li>
          <a href="https://adsb.fi">adsb.fi</a>: live positions when ADSB.lol is busy (open data API, personal non-commercial use, with thanks).
        </li>
        <li>
          <a href="https://registry.faa.gov/aircraftinquiry/">FAA Civil Aircraft Registry</a>: public US government data.
        </li>
        <li>
          <a href="https://www.planespotters.net">Planespotters.net</a>: aircraft photos, each credited to its photographer and linked to its page.
        </li>
        <li>
          <a href="https://www.adsbdb.com">adsbdb.com</a>: aircraft and route enrichment.
        </li>
        <li>
          <a href="https://ourairports.com">OurAirports</a>: airport data (public domain).
        </li>
        <li>
          <a href="https://openflights.org/data">OpenFlights</a>: airline codes, licensed{" "}
          <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL 1.0</a>.
        </li>
        <li>
          Maps: <a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://openmaptiles.org">OpenMapTiles</a>, data ©{" "}
          <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>.
        </li>
      </ul>

      <h2>Open source</h2>
      <p>
        The code, pipeline and data-quality methodology are on <a href={import.meta.env.VITE_REPO_URL ?? "https://github.com/devansh-codes/tailtale"}>GitHub</a>.
        See the <Link href="/quality">Data Quality</Link> page for how complete and accurate the history is.
      </p>
    </article>
  );
}

export function NotFoundPage() {
  useTitle("Not found | TailTale");
  return (
    <div className="prose">
      <h1>That page doesn't exist.</h1>
      <p>
        <Link href="/">Look up a plane</Link> instead.
      </p>
    </div>
  );
}
