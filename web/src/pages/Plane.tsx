import { useEffect, useMemo, useRef, useState } from "react";
import { api, FetchError } from "../api";
import { BarChart, LineChart } from "../components/charts";
import { LazyMap } from "../components/LazyMap";
import type { MapPoint } from "../components/MapView";
import { HeroPhoto } from "../components/Photo";
import { Card, Skeleton, SkeletonStats, Stat } from "../components/ui";
import { age, fmtDate, fmtDay, fmtInt, fmtMins, ownerLabel, pluralModel, summarize, typeName } from "../format";
import { historyState, Link, useTitle } from "../router";
import { drawCard, shareOrDownload, type CardData } from "../shareCard";
import { silhouetteKind } from "../silhouette";
import { typeLabel } from "../typeNames";
import type { AirportRef, LiveAircraft, RegRecord, Resolved } from "../types";
import { useLoad } from "../useLoad";
import { SearchBox } from "./Home";

const US_MIN = 0xa00001;
const US_MAX = 0xadf7c7;
const isUsHex = (h: string) => {
  const v = parseInt(h, 16);
  return v >= US_MIN && v <= US_MAX;
};
const AIRLINE_CS = /^[A-Z]{3}[0-9]{1,4}[A-Z]{0,2}$/;

export function Plane({ hex }: { hex: string }) {
  const nav = historyState<{ resolved?: Resolved; q?: string }>();
  const resolved = nav?.resolved?.hex === hex ? nav.resolved : null;
  const us = isUsHex(hex);

  const reg = useLoad(() => api.registry(hex), [hex], us);
  const hist = useLoad(() => api.history(hex), [hex], us);
  const live = useLoad(() => api.live(hex), [hex]);
  const blocked = !!(resolved?.blocked || live.data?.blocked || hist.data?.blocked);
  const liveAc: LiveAircraft | null = blocked ? null : (live.data?.live ?? resolved?.live ?? null);

  const needAdsbdb = !us || (!reg.loading && !reg.data);
  const info = useLoad(() => api.aircraft(hex), [hex], needAdsbdb || (!liveAc?.type && !hist.data?.t && !hist.loading && !live.loading));

  const icaoType = liveAc?.type ?? hist.data?.t ?? resolved?.type ?? info.data?.icaoType ?? null;
  const regRec = reg.data;
  const registration = regRec?.n ?? liveAc?.reg ?? resolved?.reg ?? info.data?.reg ?? null;
  const plainType = typeName(regRec) ?? (icaoType ? typeLabel(icaoType) : null) ?? info.data?.type ?? null;
  const kind = silhouetteKind(regRec, liveAc?.category, icaoType);

  const photo = useLoad(() => api.photo(hex, registration), [hex, registration], !blocked && !reg.loading);
  const sib = useLoad(() => api.siblings(icaoType!), [icaoType], !!icaoType);
  const trend = useLoad(() => api.trend(icaoType!), [icaoType], !!icaoType);
  const cs = liveAc?.callsign && AIRLINE_CS.test(liveAc.callsign) ? liveAc.callsign : null;
  const route = useLoad(
    () => api.route(cs!, liveAc?.lat != null && liveAc?.lon != null ? { lat: liveAc.lat, lon: liveAc.lon } : undefined),
    [cs],
    !!cs && !liveAc?.onGround,
  );
  const summary = useMemo(() => summarize(blocked ? null : (hist.data ?? null)), [hist.data, blocked]);
  const needAirports = summary.airports.length > 0;
  const airports = useLoad(() => api.airports(), [needAirports], needAirports);

  const title = registration ? `${registration}${plainType ? ` · ${plainType}` : ""} | TailTale` : "Aircraft | TailTale";
  useTitle(title);

  const notFound = us && !reg.loading && !reg.data && !live.loading && !live.data?.seen && !hist.loading && !hist.data && !info.loading && !info.data;

  if (notFound) {
    return (
      <>
        <div className="error-box" role="alert">
          <strong>We don't know aircraft {hex} yet.</strong>
          <p className="sub">It isn't in the FAA registry, isn't transmitting right now, and hasn't flown in the last 30 days.</p>
        </div>
        <SearchBox />
      </>
    );
  }

  return (
    <>
      <section className="card hero" aria-labelledby="reg-h">
        <HeroPhoto photo={blocked ? null : (photo.data ?? null)} loading={!blocked && (photo.loading || reg.loading)} kind={kind} alt={`${registration ?? hex} ${plainType ?? ""}`.trim()} />
        <div className="hero-body">
          {registration || !reg.loading ? (
            <h1 className="reg" id="reg-h">
              {registration ?? hex}
            </h1>
          ) : (
            <Skeleton h={40} w="50%" />
          )}
          {plainType || !reg.loading ? <p className="type-line">{plainType ?? "Unknown type"}</p> : <Skeleton h={20} w="40%" style={{ marginTop: 6 }} />}
          <div className="chips">
            {liveAc && !liveAc.onGround && <span className="chip live">Flying now</span>}
            {liveAc?.onGround && <span className="chip">On the ground</span>}
            {icaoType && <span className="chip">ICAO type {icaoType}</span>}
            <span className="chip">Hex {hex}</span>
            {resolved?.matchedBy === "flight_number_partner" && <span className="chip">Matched via partner callsign {resolved.callsign}</span>}
          </div>
          {resolved?.matchedBy === "flight_number_partner" && (
            <p className="note">
              We found <strong>{resolved.callsign}</strong>, a regional partner flying the same number. That's usually your flight, but regional
              carriers fly for several airlines. Check the tail number on the plane to be sure.
            </p>
          )}
          {blocked && (
            <p className="note" role="note">
              The owner of this aircraft has opted out of public tracking (FAA LADD/PIA program). We only show what kind of aircraft it is: no position,
              no history, no owner details.
            </p>
          )}
        </div>
      </section>

      {!blocked && (
        <VitalStats loading={reg.loading || (needAdsbdb && info.loading)} us={us} rec={regRec} info={info.data} plainType={plainType} />
      )}

      {!blocked && regRec?.pct != null && regRec.model_n && (
        <Card title="How old is it, really?">
          <p className="lede">
            Older than {regRec.pct}% of the {fmtInt(regRec.model_n)} US-registered {pluralModel(typeName(regRec) ?? "aircraft of this model", regRec.model_n)}.
          </p>
          <p className="muted small" style={{ marginTop: 6 }}>
            Share of currently registered airframes of this model built in a later year. Source: FAA registry.
          </p>
        </Card>
      )}

      {!blocked && <RightNow live={liveAc} loading={live.loading} error={live.error} route={route.data} routeLoading={route.loading} />}

      {icaoType && (
        <Card title="Siblings in the sky" busy={sib.loading}>
          {sib.loading ? (
            <Skeleton h={28} w="70%" />
          ) : sib.data ? (
            <>
              <p className="lede">
                <span className="num">{fmtInt(sib.data.airborne)}</span> {pluralModel(plainType && regRec ? plainType : typeLabel(icaoType), sib.data.airborne)}{" "}
                {sib.data.airborne === 1 ? "is" : "are"} flying right now.
              </p>
              <p className="muted small" style={{ marginTop: 4 }}>
                Worldwide aircraft of ICAO type {icaoType} seen airborne by ADSB.lol volunteer receivers
                {sib.data.source === "cron" ? " in the latest 10-minute count" : " just now"}. Source: ADSB.lol.
              </p>
              {trend.data && trend.data.points.length > 1 && (
                <div style={{ marginTop: 12 }}>
                  <LineChart
                    series={[{ name: icaoType, color: "var(--series-1)", points: trend.data.points.map(([x, y]) => ({ x, y })) }]}
                    height={90}
                    fmtX={(x) => new Date(x * 1000).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}
                    fmtY={(y) => `${fmtInt(y)} airborne`}
                    caption={["7 days ago", "now"]}
                    tableHead={`Airborne ${icaoType} over the last 7 days, 10-minute samples`}
                  />
                </div>
              )}
            </>
          ) : (
            <p className="muted">Live counts are unavailable right now.</p>
          )}
        </Card>
      )}

      {us && !blocked && <Last30 loading={hist.loading} summary={summary} airports={airports.data} hasData={!!hist.data?.days?.length} />}

      {!blocked && registration && !reg.loading && (
        <ShareSection
          data={{
            reg: registration,
            type: plainType ?? icaoType ?? "Aircraft",
            age: regRec?.year ? String(age(regRec.year)) : "—",
            flights30: us ? fmtInt(summary.flights) : "—",
            airports: us ? fmtInt(summary.airports.length) : "—",
            siblings: sib.data ? fmtInt(sib.data.airborne) : "—",
            siblingsLabel: sib.data ? `${pluralModel(typeLabel(icaoType ?? ""), 2)} flying now` : "siblings flying now",
            kind,
            url: `${location.host}/p/${hex}`,
          }}
          ready={!sib.loading && !hist.loading}
        />
      )}

      <div style={{ marginTop: 24 }}>
        <h2 className="small muted" style={{ textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
          Look up another plane
        </h2>
        <SearchBox />
      </div>
    </>
  );
}

function VitalStats({ loading, us, rec, info, plainType }: {
  loading: boolean;
  us: boolean;
  rec: RegRecord | null;
  info: Awaited<ReturnType<typeof api.aircraft>> | null;
  plainType: string | null;
}) {
  if (loading)
    return (
      <Card title="Vital stats" busy>
        <SkeletonStats n={6} />
      </Card>
    );
  if (!rec) {
    return (
      <Card title="Vital stats">
        <div className="stats">
          <Stat label="Type" value={info?.type ?? plainType} source="adsbdb" text />
          <Stat label="Manufacturer" value={info?.manufacturer} source="adsbdb" text />
          <Stat label="Registered in" value={info?.country} source="adsbdb" text />
          <Stat label="Operator code" value={info?.operatorCode} source="adsbdb" text />
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          {us
            ? "This hex isn't in the FAA registry today (new, recently deregistered, or misreported)."
            : "Full airframe details (build year, serial, engines, owner) are available for US-registered (N-number) aircraft. This one is registered elsewhere."}
        </p>
      </Card>
    );
  }
  const a = age(rec.year);
  return (
    <Card title="Vital stats">
      <div className="stats">
        <Stat label="Built" value={rec.year ? `${rec.year}${a !== null ? ` · ${a} yr${a === 1 ? "" : "s"} old` : ""}` : null} source="FAA registry" />
        <Stat label="Serial number" value={rec.serial} source="FAA registry" text />
        <Stat
          label="Engines"
          value={rec.engines ? `${rec.engines} × ${rec.engine_model ?? rec.eng_type ?? "engine"}` : rec.eng_type}
          source={rec.engine_mfr ? `FAA registry (${rec.engine_mfr})` : "FAA registry"}
          text
        />
        <Stat label="Airworthy since" value={fmtDate(rec.airworthy_since)} source="FAA airworthiness date" text />
        <Stat label="Registered to current owner since" value={fmtDate(rec.cert_issued)} source="FAA certificate issue date (not the delivery date)" text />
        <Stat label="Registered owner" value={ownerLabel(rec)} source="FAA registry (organizations only)" text />
        <Stat label="FAA model" value={`${rec.fmodel ?? "—"}${rec.seats ? ` · up to ${rec.seats} seats` : ""}`} source="FAA aircraft reference file" text wide />
      </div>
      {rec.status && !["V", "T", "M"].includes(rec.status) && (
        <p className="note">The FAA lists this registration with status code “{rec.status}” (not currently valid: pending, expired, or being cancelled).</p>
      )}
    </Card>
  );
}

function RightNow({ live, loading, error, route, routeLoading }: {
  live: LiveAircraft | null;
  loading: boolean;
  error: Error | null;
  route: Awaited<ReturnType<typeof api.route>> | null;
  routeLoading: boolean;
}) {
  const points = useMemo<MapPoint[]>(() => {
    if (!live || live.lat == null || live.lon == null) return [];
    const p: MapPoint[] = [{ lat: live.lat, lon: live.lon, label: live.callsign ?? "", kind: "plane" }];
    for (const ap of [route?.origin, route?.destination]) {
      if (ap?.lat != null && ap.lon != null) p.push({ lat: ap.lat, lon: ap.lon, label: ap.iata ?? ap.icao ?? "", kind: "airport" });
    }
    return p;
  }, [live, route]);
  const line = useMemo<[number, number][] | undefined>(() => {
    const o = route?.origin;
    const d = route?.destination;
    if (!live || live.lat == null || live.lon == null || o?.lon == null || o.lat == null || d?.lon == null || d.lat == null) return undefined;
    return [
      [o.lon, o.lat],
      [live.lon, live.lat],
      [d.lon, d.lat],
    ];
  }, [live, route]);

  if (loading)
    return (
      <Card title="Right now" busy>
        <SkeletonStats n={2} />
      </Card>
    );
  if (error) {
    return (
      <Card title="Right now">
        <p className="muted">{error instanceof FetchError ? error.message : "Live data is unavailable right now."}</p>
      </Card>
    );
  }
  if (!live) {
    return (
      <Card title="Right now">
        <p className="lede">Not transmitting right now.</p>
        <p className="muted" style={{ marginTop: 4 }}>
          No ADS-B receiver in the volunteer network has heard it in the last minute. It's probably parked with its transponder off, or outside
          receiver coverage.
        </p>
      </Card>
    );
  }
  if (live.onGround) {
    return (
      <Card title="Right now">
        <p className="lede">On the ground{live.callsign ? ` as ${live.callsign}` : ""}.</p>
        <p className="muted small" style={{ marginTop: 4 }}>
          Source: ADSB.lol live data{live.posAge != null ? `, position ${Math.round(live.posAge)} s old` : ""}.
        </p>
        {points.length > 0 && <LazyMap points={points} label="Map of the aircraft's current position on the ground" />}
      </Card>
    );
  }
  return (
    <Card title="Right now">
      {cs(live) && (
        <div style={{ marginBottom: 12 }}>
          {routeLoading ? (
            <Skeleton h={34} w="70%" />
          ) : route?.origin && route.destination ? (
            <>
              <div className="route" aria-label={`Published route ${route.origin.iata ?? route.origin.icao} to ${route.destination.iata ?? route.destination.icao}`}>
                <span className="ap">{route.origin.iata ?? route.origin.icao}</span>
                <span className="arrow" aria-hidden="true" />
                <span className="ap">{route.destination.iata ?? route.destination.icao}</span>
              </div>
              <p className="muted small">
                {route.origin.city ?? route.origin.name} to {route.destination.city ?? route.destination.name}
                {route.airline?.name ? ` · ${route.airline.name}` : ""}. Published route for {route.callsign} (source: {route.source}); airlines sometimes reuse numbers, so
                treat it as a guide.
              </p>
            </>
          ) : (
            <p className="muted small">No published route for {live.callsign}.</p>
          )}
        </div>
      )}
      <div className="stats">
        <Stat label="Altitude" value={live.alt != null ? `${fmtInt(live.alt)} ft` : null} source="ADSB.lol (barometric)" />
        <Stat label="Ground speed" value={live.gs != null ? `${fmtInt(Math.round(live.gs))} kt` : null} source="ADSB.lol" />
        <Stat label="Callsign" value={live.callsign} source="ADSB.lol" text />
        <Stat
          label="Vertical rate"
          value={live.vrate != null ? (Math.abs(live.vrate) < 200 ? "Level" : `${live.vrate > 0 ? "Climbing" : "Descending"} ${fmtInt(Math.abs(live.vrate))} ft/min`) : null}
          source="ADSB.lol"
          text
        />
      </div>
      {points.length > 0 && <LazyMap points={points} line={line} label="Map of the aircraft's current position and route" />}
    </Card>
  );
}

const cs = (l: LiveAircraft) => !!l.callsign && AIRLINE_CS.test(l.callsign);

function Last30({ loading, summary, airports, hasData }: {
  loading: boolean;
  summary: ReturnType<typeof summarize>;
  airports: Record<string, AirportRef> | null;
  hasData: boolean;
}) {
  if (loading)
    return (
      <Card title="Its last 30 days" busy>
        <Skeleton h={120} />
        <SkeletonStats n={4} />
      </Card>
    );
  if (!hasData) {
    return (
      <Card title="Its last 30 days">
        <p className="lede">No flights recorded in the last 30 days.</p>
        <p className="muted" style={{ marginTop: 4 }}>
          Either it stayed on the ground, or it flew where volunteer receivers don't reach. History is rebuilt every night from ADSB.lol data.
        </p>
      </Card>
    );
  }
  const name = (code: string) => {
    const a = airports?.[code];
    return a ? { short: a[0] ?? code, long: a[2] ? `${a[2]} · ${a[1]}` : a[1] } : { short: code, long: "" };
  };
  const apPoints: MapPoint[] = airports
    ? summary.airports
        .map((a) => airports[a.code])
        .filter(Boolean)
        .map((a) => ({ lat: a[4], lon: a[5], label: a[0] ?? "", kind: "airport" as const }))
    : [];
  return (
    <Card title="Its last 30 days">
      <BarChart
        data={summary.days.map((d) => ({
          key: d.d,
          label: fmtDay(d.d),
          value: d.flights,
          tip: `${fmtDay(d.d)}: ${d.flights} flight${d.flights === 1 ? "" : "s"}${d.mins ? `, ${fmtMins(d.mins)}` : ""}`,
        }))}
        caption={[fmtDay(summary.days[0].d), fmtDay(summary.days[summary.days.length - 1].d)]}
        tableHead={["Day (UTC)", "Flights"]}
      />
      <div className="stats" style={{ marginTop: 12 }}>
        <Stat label="Flights" value={fmtInt(summary.flights)} source="ADSB.lol history, segmented by TailTale" />
        <Stat label="Hours in the air" value={summary.hours.toFixed(1)} source="ADSB.lol history" />
        <Stat
          label="Longest flight"
          value={summary.longest ? fmtMins(summary.longest.mins) : null}
          source={summary.longest ? `${name(summary.longest.dep ?? "?").short} → ${name(summary.longest.arr ?? "?").short}, ${fmtDay(summary.longest.d)}` : "ADSB.lol history"}
          text
        />
        <Stat label="Busiest day" value={summary.busiest ? `${summary.busiest.flights} flights` : null} source={summary.busiest ? fmtDay(summary.busiest.d) : "ADSB.lol history"} text />
      </div>
      {summary.airports.length > 0 && (
        <>
          <h3 className="small muted" style={{ marginTop: 16 }}>
            Airports visited ({summary.airports.length})
          </h3>
          {apPoints.length > 0 && <LazyMap points={apPoints} label={`Map of ${apPoints.length} airports this aircraft visited in the last 30 days`} />}
          <ul className="airports">
            {summary.airports.slice(0, 12).map((a) => {
              const n = name(a.code);
              return (
                <li key={a.code}>
                  <span>
                    <span className="code">{n.short}</span> <span className="muted small">{n.long}</span>
                  </span>
                  <span className="num muted">{a.visits}×</span>
                </li>
              );
            })}
          </ul>
          {summary.airports.length > 12 && <p className="muted small">…and {summary.airports.length - 12} more.</p>}
        </>
      )}
      {summary.incomplete > 0 && (
        <p className="note">
          {summary.incomplete} of {summary.flights} flights were only partly observed (volunteer receivers lost the signal for 30+ minutes, or the flight crossed
          midnight UTC). Their missing ends show no airport rather than a guess. <Link href="/quality">How we handle gaps</Link>
        </p>
      )}
    </Card>
  );
}

function ShareSection({ data, ready }: { data: CardData; ready: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const key = JSON.stringify(data);
  useEffect(() => {
    if (ref.current && ready) drawCard(ref.current, data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);
  return (
    <Card title="Share its story">
      <canvas ref={ref} className="share-preview" role="img" aria-label={`Share card for ${data.reg}: ${data.type}, ${data.age} years old, ${data.flights30} flights in the last 30 days`} />
      <div className="share-row">
        <button
          className="btn"
          type="button"
          disabled={!ready}
          onClick={async () => {
            if (!ref.current) return;
            drawCard(ref.current, data);
            try {
              const r = await shareOrDownload(ref.current, `tailtale-${data.reg}.png`, `${data.reg} on TailTale`, `https://${data.url}`);
              setMsg(r === "downloaded" ? "Image downloaded." : r === "shared" ? "Shared!" : null);
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
        >
          Share card
        </button>
        <span className="muted small" role="status" style={{ alignSelf: "center" }}>
          {msg}
        </span>
      </div>
    </Card>
  );
}
