import { ApiError } from "./http";
import type { LiveAircraft, TypeCount } from "./types";

/** Every live upstream goes through this interface so ADSB.lol can be swapped or supplemented. */
export interface LiveProvider {
  readonly name: string;
  byHex(hex: string): Promise<LiveAircraft | null>;
  byCallsigns(callsigns: string[]): Promise<LiveAircraft[]>;
  byReg(reg: string): Promise<LiveAircraft | null>;
  countType(icaoType: string): Promise<TypeCount>;
}

const DBFLAG_PIA = 4;
const DBFLAG_LADD = 8;

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** ADSBExchange-v2-style aircraft object -> trimmed LiveAircraft. LADD/PIA aircraft lose all position data. */
export function trimAircraft(a: Raw): LiveAircraft {
  const flags = num(a.dbFlags) ?? 0;
  const blocked = (flags & (DBFLAG_LADD | DBFLAG_PIA)) !== 0;
  const onGround = a.alt_baro === "ground";
  const last = (a.lastPosition ?? null) as Raw | null;
  const lat = num(a.lat) ?? (last ? num(last.lat) : null);
  const lon = num(a.lon) ?? (last ? num(last.lon) : null);
  const posAge = num(a.lat) !== null ? num(a.seen_pos) : last ? num(last.seen_pos) : null;
  const base: LiveAircraft = {
    hex: String(a.hex ?? "").toUpperCase(),
    reg: str(a.r),
    type: str(a.t),
    callsign: str(a.flight),
    onGround,
    alt: onGround ? 0 : num(a.alt_baro),
    gs: num(a.gs),
    track: num(a.track),
    vrate: num(a.baro_rate) ?? num(a.geom_rate),
    lat,
    lon,
    posAge,
    seen: num(a.seen),
    category: str(a.category),
    source: str(a.type),
    blocked,
  };
  if (blocked) {
    return { ...base, callsign: null, alt: null, gs: null, track: null, vrate: null, lat: null, lon: null, posAge: null };
  }
  return base;
}

// Module-level cooldown: after a 429 we stop calling the upstream for a while (per isolate).
let cooldownUntil = 0;

export function _resetCooldown(): void {
  cooldownUntil = 0;
}

export class AdsbLolProvider implements LiveProvider {
  readonly name = "adsb.lol";
  constructor(
    private ua: string,
    private base = "https://api.adsb.lol",
    private fetcher: typeof fetch = (...a) => fetch(...a),
    private retries429 = 1,
    private retryDelayMs = 1200,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async get(path: string): Promise<Response> {
    if (Date.now() < cooldownUntil) {
      throw new ApiError(503, "upstream_busy", "The live data source asked us to slow down. Try again in a minute.");
    }
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetcher(`${this.base}${path}`, {
          headers: { "user-agent": this.ua, accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        throw new ApiError(502, "upstream_unreachable", "The live data source did not answer. Try again shortly.");
      }
      if (res.status === 429) {
        // ADSB.lol's limits are dynamic and undocumented: back off once, then stop calling for a while.
        if (attempt < this.retries429) {
          await this.sleep(this.retryDelayMs * (attempt + 1));
          continue;
        }
        const ra = Number(res.headers.get("retry-after"));
        cooldownUntil = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15_000);
        throw new ApiError(503, "upstream_busy", "The live data source asked us to slow down. Try again in a minute.");
      }
      if (!res.ok) {
        throw new ApiError(502, "upstream_error", `The live data source returned ${res.status}.`);
      }
      return res;
    }
  }

  private async list(path: string): Promise<LiveAircraft[]> {
    const body = (await (await this.get(path)).json()) as { ac?: Raw[] };
    return Array.isArray(body.ac) ? body.ac.map(trimAircraft) : [];
  }

  async byHex(hex: string): Promise<LiveAircraft | null> {
    return (await this.list(`/v2/hex/${encodeURIComponent(hex.toLowerCase())}`))[0] ?? null;
  }

  async byCallsigns(callsigns: string[]): Promise<LiveAircraft[]> {
    if (!callsigns.length) return [];
    return this.list(`/v2/callsign/${callsigns.map(encodeURIComponent).join(",")}`);
  }

  async byReg(reg: string): Promise<LiveAircraft | null> {
    return (await this.list(`/v2/reg/${encodeURIComponent(reg)}`))[0] ?? null;
  }

  /**
   * Count aircraft of a type without JSON.parse (bodies reach ~650 KB and the free plan allows 10 ms CPU).
   * The body is streamed and scanned for each aircraft's `"hex":` key and for `"alt_baro":"ground"`.
   */
  async countType(icaoType: string): Promise<TypeCount> {
    const res = await this.get(`/v2/type/${encodeURIComponent(icaoType)}`);
    return countStream(res.body);
  }
}

const HEX_KEY = '{"hex":';
const GROUND = '"alt_baro":"ground"';

export async function countStream(body: ReadableStream<Uint8Array> | null): Promise<TypeCount> {
  if (!body) return { total: 0, airborne: 0 };
  const reader = body.getReader();
  const dec = new TextDecoder();
  let carry = "";
  let total = 0;
  let ground = 0;
  const keep = Math.max(HEX_KEY.length, GROUND.length) - 1;
  for (;;) {
    const { value, done } = await reader.read();
    const chunk = carry + (done ? dec.decode() : dec.decode(value, { stream: true }));
    total += occurrences(chunk, HEX_KEY);
    ground += occurrences(chunk, GROUND);
    if (done) break;
    // Keep a tail shorter than either needle so a match split across chunks is counted exactly once.
    carry = chunk.slice(-keep);
    total -= occurrences(carry, HEX_KEY);
    ground -= occurrences(carry, GROUND);
  }
  return { total, airborne: Math.max(0, total - ground) };
}

function occurrences(s: string, needle: string): number {
  let n = 0;
  let i = s.indexOf(needle);
  while (i !== -1) {
    n++;
    i = s.indexOf(needle, i + needle.length);
  }
  return n;
}
