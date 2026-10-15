export interface Env {
  DB?: D1Database;
  /** Present when running as a Pages Function: serves the static site and /data shards without a subrequest. */
  ASSETS?: Fetcher;
  /** Origin of the static site, e.g. https://jetlog.pages.dev (used for /data fetches and CORS). */
  PAGES_ORIGIN?: string;
  /** Extra comma-separated origins allowed by CORS (local development). */
  EXTRA_ORIGINS?: string;
  REPO_URL?: string;
}

export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

/** Trimmed live state for one aircraft. Never the raw upstream payload. */
export interface LiveAircraft {
  hex: string;
  reg: string | null;
  type: string | null;
  callsign: string | null;
  onGround: boolean;
  alt: number | null;
  gs: number | null;
  track: number | null;
  vrate: number | null;
  lat: number | null;
  lon: number | null;
  /** Seconds since the position was received (null when no position). */
  posAge: number | null;
  /** Seconds since any message. */
  seen: number | null;
  category: string | null;
  source: string | null;
  /** Owner opted out of public tracking (FAA LADD or PIA): position fields are always null. */
  blocked: boolean;
  /** Which live network answered ("adsb.lol" or "adsb.fi"), for attribution on the page. */
  provider: string;
  /** Present when the data comes from the ~10-minute snapshot: unix seconds it was taken. */
  asOf?: number;
}

export interface TypeCount {
  total: number;
  airborne: number;
}

export interface Airport {
  icao: string | null;
  iata: string | null;
  name: string | null;
  city: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
}

export interface Route {
  callsign: string;
  airline: { name: string | null; icao: string | null; iata: string | null } | null;
  origin: Airport | null;
  destination: Airport | null;
  source: "adsbdb" | "adsb.lol";
}
