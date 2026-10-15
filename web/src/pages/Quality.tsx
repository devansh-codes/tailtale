import { api, type QualityDay } from "../api";
import { BarChart, LineChart } from "../components/charts";
import { Card, Skeleton, SkeletonStats, Stat } from "../components/ui";
import { fmtDay, fmtInt } from "../format";
import { useTitle } from "../router";
import { useLoad } from "../useLoad";
import headlines from "../headlines.json";

const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const GAP_BINS = ["30-60", "60-120", "120-240", "240-480", "480+"];
const dayX = (d: string) => Date.parse(d + "T00:00:00Z") / 1000;

export function Quality() {
  useTitle("Data quality | TailTale");
  const hist = useLoad(() => api.quality(), []);
  const latest = useLoad(() => api.qualityLatest(), []);
  const spot = useLoad(() => api.spotCheck(), []);
  const ok = (hist.data?.days ?? []).filter((d): d is QualityDay & Required<Pick<QualityDay, "segments">> => d.status === "ok" && d.segments != null);
  const last = latest.data?.history;
  const p = latest.data?.params;

  return (
    <div className="prose">
      <h1>Data quality</h1>
      <p>
        TailTale's flight history is built from volunteer ADS-B receivers, so it has holes. This page shows, every day, how much we saw, how much we
        could explain, and where we gave up instead of guessing. All numbers are for US-registered civil aircraft (hex A00001–ADF7C7), including
        general aviation.
      </p>

      <Card title={`Last run${last?.d ? ` · ${fmtDay(last.d)}` : ""}`} busy={latest.loading}>
        {latest.loading ? (
          <SkeletonStats n={8} />
        ) : !last ? (
          <p className="muted">No report yet.</p>
        ) : last.status === "missing" ? (
          <p className="note">
            The history pipeline did not complete for {last.d}. The site is still serving the last good day ({latest.data?.history_last_ok ?? "none"}).
          </p>
        ) : (
          <div className="kpis">
            <Stat label="Traces read" value={fmtInt(last.traces_read ?? 0)} source="ADSB.lol daily archive" />
            <Stat label="US aircraft" value={fmtInt(last.us_traces ?? 0)} source="hex A00001–ADF7C7" />
            <Stat label="Flights found" value={fmtInt(last.segments ?? 0)} source="TailTale segmentation" />
            <Stat label="Opted out (LADD/PIA)" value={fmtInt(last.blocked ?? 0)} source="readsb dbFlags" />
            <Stat label="Both airports matched" value={pct(last.both_airports_share)} source="within 8 km" />
            <Stat label="Partly observed" value={pct(last.incomplete_share)} source="gap > 30 min or midnight" />
            <Stat label="Outlier points dropped" value={fmtInt(last.outliers_dropped ?? 0)} source={`of ${fmtInt(last.points ?? 0)} points`} />
            <Stat label="Pipeline runtime" value={last.runtime_s != null ? `${Math.round(last.runtime_s / 60)} min` : "—"} source="GitHub Actions" />
          </div>
        )}
      </Card>

      <Card title="Flights found per day" busy={hist.loading}>
        {hist.loading ? (
          <Skeleton h={120} />
        ) : (
          <BarChart
            data={ok.map((d) => ({ key: d.d, label: fmtDay(d.d), value: d.segments, tip: `${fmtDay(d.d)}: ${fmtInt(d.segments)} flights` }))}
            caption={ok.length ? [fmtDay(ok[0].d), fmtDay(ok[ok.length - 1].d)] : undefined}
            tableHead={["Day (UTC)", "Flights"]}
          />
        )}
      </Card>

      <Card title="How much we could explain" busy={hist.loading}>
        {hist.loading ? (
          <Skeleton h={140} />
        ) : (
          <LineChart
            series={[
              { name: "Both airports matched", color: "var(--series-1)", points: ok.map((d) => ({ x: dayX(d.d), y: (d.both_airports_share ?? 0) * 100 })) },
              { name: "Partly observed", color: "var(--series-2)", points: ok.map((d) => ({ x: dayX(d.d), y: (d.incomplete_share ?? 0) * 100 })) },
            ]}
            yMax={100}
            fmtX={(x) => fmtDay(new Date(x * 1000).toISOString().slice(0, 10))}
            fmtY={(y) => `${y.toFixed(1)}%`}
            caption={["Share of flights, %", "0 – 100%"]}
            tableHead="Share of flights with both airports matched, and share partly observed, per day"
          />
        )}
        <p className="small muted" style={{ marginTop: 8 }}>
          “Airport matched” needs a takeoff or landing within 8 km of one of ~6,300 large, medium or scheduled-service airports. Most unmatched ends are
          small general-aviation fields, which we deliberately leave out, plus ends lost to coverage gaps.
        </p>
      </Card>

      <Card title="Coverage gaps (latest day)">
        {last?.gap_hist_mins ? (
          <>
            <BarChart
              data={GAP_BINS.map((k) => {
                const v = last.gap_hist_mins?.[k] ?? 0;
                return { key: k, label: `${k} min`, value: v, tip: `${k} min: ${fmtInt(v)} gaps` };
              })}
              tableHead={["Gap length", "Airborne gaps"]}
              caption={["30–60 min", "8 h +"]}
              color="var(--series-2)"
            />
            <p className="small muted" style={{ marginTop: 8 }}>
              Airborne silences longer than 30 minutes, which close a flight as partly observed. Median gap: {last.median_gap_mins ?? "—"} min across{" "}
              {fmtInt(last.split_gaps ?? 0)} gaps.
            </p>
          </>
        ) : (
          <Skeleton h={100} />
        )}
      </Card>

      <Card title="Do our flights match published routes?" busy={spot.loading}>
        {spot.data ? (
          <>
            <div className="stats three">
              <Stat label="Leg continuity" value={pct(spot.data.continuity[0])} source={`${spot.data.continuity[1]} consecutive legs`} />
              <Stat label="Matches adsbdb or ADSB.lol route" value={pct(spot.data.either_source[0])} source={`${spot.data.either_source[1]} flights`} />
              <Stat label="Matches adsbdb exactly" value={pct(spot.data.adsbdb_strict[0])} source={`${spot.data.adsbdb_strict[1]} flights`} />
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>
              Daily spot check of {spot.data.aircraft} random airliners' completed flights. Continuity (each landing airport is the next takeoff airport)
              checks our segmentation against itself. Route tables keyed by callsign are often stale, and airlines reuse a flight number across legs, so
              disagreement there is mostly about the reference, not the track.
            </p>
          </>
        ) : spot.loading ? (
          <SkeletonStats n={3} />
        ) : (
          <p className="muted">No spot check yet.</p>
        )}
      </Card>

      <Card title="From the notebooks">
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {Object.values(headlines.sections as Record<string, string[]>)
            .flat()
            .map((h) => (
              <li key={h} className="sub">
                {h}
              </li>
            ))}
        </ul>
        <p className="small muted" style={{ marginTop: 8 }}>
          Computed in <code>notebooks/coverage_and_gaps.ipynb</code> and <code>notebooks/fleet_insights.ipynb</code> ({headlines.as_of}).
        </p>
      </Card>

      <h2>Method</h2>
      <ul>
        <li>Points implying more than {p?.max_speed_kt ?? 700} kt from the previous point are dropped as outliers.</li>
        <li>On the ground = altitude reported as “ground”, or under 50 kt within 8 km of an airport.</li>
        <li>
          A landing is a ground transition, or the last point below {fmtInt(p?.landing_agl_ft ?? 3000)} ft above field elevation within 8 km of an airport
          followed by {p?.landing_gap_min ?? 20}+ minutes of silence.
        </li>
        <li>Any other airborne silence over {p?.split_gap_min ?? 30} minutes ends the flight as “partly observed”; we don't guess the missing part.</li>
        <li>Flights under {p?.min_flight_min ?? 5} airborne minutes are discarded. History keeps a rolling {p?.window_days ?? 30} days.</li>
      </ul>
      {latest.data?.registry?.records && (
        <p className="small muted">
          FAA registry: {fmtInt(latest.data.registry.records)} aircraft, rebuilt {latest.data.registry.built_at?.slice(0, 10)}.
        </p>
      )}
    </div>
  );
}
