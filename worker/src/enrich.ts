import { ApiError } from "./http";
import type { Airport, Route } from "./types";

type Raw = Record<string, unknown>;
type Fetch = typeof fetch;

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function getJson(fetcher: Fetch, url: string, ua: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetcher(url, {
      ...init,
      headers: { "user-agent": ua, accept: "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ApiError(502, "upstream_unreachable", "The route source did not answer. Try again shortly.");
  }
  if (res.status === 429) throw new ApiError(503, "upstream_busy", "The route source asked us to slow down.");
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function adsbdbAirport(a: Raw | undefined): Airport | null {
  if (!a) return null;
  return {
    icao: s(a.icao_code),
    iata: s(a.iata_code),
    name: s(a.name),
    city: s(a.municipality),
    country: s(a.country_iso_name),
    lat: n(a.latitude),
    lon: n(a.longitude),
  };
}

function adsblolAirport(a: Raw | undefined): Airport | null {
  if (!a) return null;
  return {
    icao: s(a.icao),
    iata: s(a.iata),
    name: s(a.name),
    city: s(a.location),
    country: s(a.countryiso2),
    lat: n(a.lat),
    lon: n(a.lon),
  };
}

/** adsbdb first; ADSB.lol routeset (needs a position) and then its GET route as fallbacks. */
export async function lookupRoute(
  callsign: string,
  ua: string,
  pos: { lat: number; lon: number } | null,
  fetcher: Fetch = (...a) => fetch(...a),
): Promise<Route | null> {
  const cs = callsign.toUpperCase();
  const db = await getJson(fetcher, `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, ua);
  const fr = (db.body as { response?: { flightroute?: Raw } } | null)?.response?.flightroute;
  if (db.status === 200 && fr && typeof fr === "object") {
    const al = fr.airline as Raw | undefined;
    return {
      callsign: s(fr.callsign_icao) ?? cs,
      airline: al ? { name: s(al.name), icao: s(al.icao), iata: s(al.iata) } : null,
      origin: adsbdbAirport(fr.origin as Raw),
      destination: adsbdbAirport(fr.destination as Raw),
      source: "adsbdb",
    };
  }

  const fromAdsbLol = (r: Raw | undefined): Route | null => {
    const aps = Array.isArray(r?._airports) ? (r!._airports as Raw[]) : [];
    if (aps.length < 2) return null;
    return {
      callsign: cs,
      airline: null,
      origin: adsblolAirport(aps[0]),
      destination: adsblolAirport(aps[aps.length - 1]),
      source: "adsb.lol",
    };
  };

  if (pos) {
    const rs = await getJson(fetcher, "https://api.adsb.lol/api/0/routeset", ua, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planes: [{ callsign: cs, lat: pos.lat, lng: pos.lon }] }),
    }).catch(() => null);
    const r = Array.isArray(rs?.body) ? fromAdsbLol((rs!.body as Raw[])[0]) : null;
    if (r) return r;
  }
  const g = await getJson(fetcher, `https://api.adsb.lol/api/0/route/${encodeURIComponent(cs)}`, ua).catch(() => null);
  return g && g.status === 200 ? fromAdsbLol(g.body as Raw) : null;
}

export interface AircraftInfo {
  hex: string | null;
  reg: string | null;
  icaoType: string | null;
  type: string | null;
  manufacturer: string | null;
  country: string | null;
  /** Only the airline ICAO flag code and its name: owner names of private aircraft are never returned. */
  operatorCode: string | null;
}

export async function lookupAircraft(q: string, ua: string, fetcher: Fetch = (...a) => fetch(...a)): Promise<AircraftInfo | null> {
  const r = await getJson(fetcher, `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(q)}`, ua);
  const a = (r.body as { response?: { aircraft?: Raw } } | null)?.response?.aircraft;
  if (r.status !== 200 || !a || typeof a !== "object") return null;
  const flag = s(a.registered_owner_operator_flag_code);
  return {
    hex: s(a.mode_s)?.toUpperCase() ?? null,
    reg: s(a.registration),
    icaoType: s(a.icao_type),
    type: s(a.type),
    manufacturer: s(a.manufacturer),
    country: s(a.registered_owner_country_iso_name),
    operatorCode: flag && /^[A-Z]{3}$/.test(flag) ? flag : null,
  };
}
