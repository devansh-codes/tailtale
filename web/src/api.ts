import type { AircraftInfo, AirportRef, HistEntry, LiveResponse, Photo, RegRecord, Resolved, Route, Siblings } from "./types";

/** Same-origin Pages Function by default; override for local dev against `wrangler dev`. */
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export class FetchError extends Error {
  status: number;
  code: string;
  hint?: string;
  reason?: string;
  constructor(status: number, code: string, message: string, hint?: string, reason?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.reason = reason;
  }
}

async function getJson<T>(url: string, timeoutMs = 12000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  } catch {
    throw new FetchError(0, "network", "We couldn't reach the server. Slow Wi-Fi? Try again in a moment.");
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    // Pages answers unknown /data paths with the SPA's index.html.
    throw new FetchError(404, "not_found", "Not found.");
  }
  const body = (await res.json()) as T & { error?: { code: string; message: string; hint?: string; reason?: string } };
  if (!res.ok || body.error) {
    const e = body.error ?? { code: "http_" + res.status, message: `Request failed (${res.status}).` };
    throw new FetchError(res.status, e.code, e.message, e.hint, e.reason);
  }
  return body;
}

/** Static shard: null when the shard (or the key) does not exist. */
async function shard<T>(path: string, key: string): Promise<T | null> {
  try {
    const m = await getJson<Record<string, T>>(`/data/${path}`);
    return m[key] ?? null;
  } catch (e) {
    if (e instanceof FetchError && e.status === 404) return null;
    throw e;
  }
}

export const api = {
  resolve: (q: string) => getJson<Resolved>(`${API_BASE}/api/resolve?q=${encodeURIComponent(q)}`),
  live: (hex: string) => getJson<LiveResponse>(`${API_BASE}/api/live/${hex}`),
  siblings: (type: string) => getJson<Siblings>(`${API_BASE}/api/siblings/${encodeURIComponent(type)}`),
  allSiblings: () => getJson<{ ts: number | null; types: Record<string, number> }>(`${API_BASE}/api/siblings`),
  trend: (type: string) => getJson<{ type: string; points: [number, number][] }>(`${API_BASE}/api/siblings/${encodeURIComponent(type)}/trend`),
  route: (cs: string, pos?: { lat: number; lon: number }) =>
    getJson<Route>(`${API_BASE}/api/route/${encodeURIComponent(cs)}${pos ? `?lat=${pos.lat.toFixed(2)}&lon=${pos.lon.toFixed(2)}` : ""}`),
  aircraft: (q: string) => getJson<AircraftInfo>(`${API_BASE}/api/aircraft/${encodeURIComponent(q)}`),
  registry: (hex: string) => shard<RegRecord>(`reg/hex/${hex.slice(0, 3)}.json`, hex),
  history: (hex: string) => shard<HistEntry>(`hist/${hex.slice(0, 4)}.json`, hex),
  airports: () => getJson<Record<string, AirportRef>>("/data/ref/airports.json"),
  quality: () => getJson<QualityHistory>("/data/quality/history.json"),
  qualityLatest: () => getJson<QualityLatest>("/data/quality/latest.json"),
  spotCheck: () => getJson<SpotCheck>("/data/quality/spot_check.json"),
  dailyStats: () => getJson<{ days: { d: string; airframes: number; types: Record<string, { airframes: number; hours: number }> }[] }>("/data/stats/daily.json"),
  /** Planespotters terms: called from the browser, never proxied or cached by us; URLs used unchanged. */
  photo: async (hex: string, reg?: string | null): Promise<Photo | null> => {
    const get = async (u: string) => {
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const b = (await r.json()) as { photos?: Photo[] };
      return b.photos?.[0] ?? null;
    };
    try {
      return (await get(`https://api.planespotters.net/pub/photos/hex/${hex}`)) ?? (reg ? await get(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`) : null);
    } catch {
      return null;
    }
  },
};

export interface QualityDay {
  d: string;
  status: "ok" | "missing";
  traces_read?: number;
  us_traces?: number;
  aircraft_flew?: number;
  blocked?: number;
  points?: number;
  outliers_dropped?: number;
  segments?: number;
  both_airports_share?: number;
  dep_matched_share?: number;
  arr_matched_share?: number;
  incomplete_share?: number;
  split_gaps?: number;
  median_gap_mins?: number;
  gap_hist_mins?: Record<string, number>;
  runtime_s?: number;
  stream_s?: number;
}
export interface QualityHistory {
  days: QualityDay[];
}
export interface QualityLatest {
  generated_at: string;
  history: QualityDay;
  history_last_ok: string | null;
  registry: { built_at?: string; records?: number; hex_shards?: number; n_shards?: number; models?: number };
  params: Record<string, number>;
}
export interface SpotCheck {
  generated_at?: string;
  aircraft: number;
  flights: number;
  adsbdb_strict: [number | null, number];
  either_source: [number | null, number];
  continuity: [number | null, number];
}
