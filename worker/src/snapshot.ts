import { ApiError } from "./http";
import type { LiveProvider } from "./provider";
import type { Env, LiveAircraft, TypeCount } from "./types";

/**
 * Reads the live airliner snapshot that GitHub Actions writes to D1 every ~10 minutes
 * (pipeline/live_snapshot.py). Needed because ADSB.lol and adsb.fi refuse most requests from Cloudflare's IPs.
 */

export const BUCKETS = 32;
/** Older than this, the snapshot is treated as missing (GitHub's scheduler can run late). */
export const SNAPSHOT_MAX_AGE_S = 45 * 60;

/** Same function as pipeline/live_snapshot.py: sum of character codes of the upper-cased key, mod 32. */
export function bucket(key: string): number {
  let s = 0;
  for (const ch of key.toUpperCase()) s += ch.charCodeAt(0);
  return s % BUCKETS;
}

const pad = (n: number) => n.toString().padStart(2, "0");

/** [hex, callsign, reg, type, lat, lon, alt|"g"|null, gs, track, vrate, category, posAge, blocked] */
type Rec = [string, string | null, string | null, string | null, number | null, number | null, number | "g" | null, number | null, number | null, number | null, string | null, number | null, 0 | 1];

export function fromRec(r: Rec, ts: number): LiveAircraft {
  const blocked = r[12] === 1;
  const onGround = r[6] === "g";
  const base: LiveAircraft = {
    hex: r[0],
    reg: r[2],
    type: r[3],
    callsign: r[1],
    onGround,
    alt: onGround ? 0 : (r[6] as number | null),
    gs: r[7],
    track: r[8],
    vrate: r[9],
    lat: r[4],
    lon: r[5],
    posAge: r[11],
    seen: null,
    category: r[10],
    source: null,
    blocked,
    provider: "adsb.lol",
    asOf: ts,
  };
  return blocked ? { ...base, callsign: null, alt: null, gs: null, track: null, vrate: null, lat: null, lon: null, posAge: null } : base;
}

interface Row {
  k: string;
  ts: number;
  data: string;
}

export class Snapshot {
  constructor(
    private env: Env,
    private now: () => number = () => Date.now(),
  ) {}

  private async rows(keys: string[]): Promise<Row[]> {
    if (!this.env.DB || !keys.length) return [];
    const uniq = [...new Set(keys)];
    const { results } = await this.env.DB.prepare(`SELECT k, ts, data FROM live_bucket WHERE k IN (${uniq.map(() => "?").join(",")})`)
      .bind(...uniq)
      .all<Row>();
    const fresh = Math.floor(this.now() / 1000) - SNAPSHOT_MAX_AGE_S;
    return (results ?? []).filter((r) => r.ts >= fresh);
  }

  /** Timestamp of the latest fresh snapshot, or null if there is none. */
  async freshAt(): Promise<number | null> {
    const [m] = await this.rows(["meta"]);
    return m ? m.ts : null;
  }

  async byHex(hex: string): Promise<{ ac: LiveAircraft | null; ts: number | null }> {
    const h = hex.toUpperCase();
    const [row] = await this.rows([`h${pad(bucket(h))}`]);
    if (!row) return { ac: null, ts: null };
    const rec = (JSON.parse(row.data) as Rec[]).find((r) => r[0] === h);
    return { ac: rec ? fromRec(rec, row.ts) : null, ts: row.ts };
  }

  async byCallsigns(callsigns: string[]): Promise<{ ac: LiveAircraft[]; ts: number | null }> {
    const cs = callsigns.map((c) => c.toUpperCase());
    const csRows = await this.rows(cs.map((c) => `c${pad(bucket(c))}`));
    if (!csRows.length) return { ac: [], ts: null };
    const hexes: string[] = [];
    for (const r of csRows) {
      const m = JSON.parse(r.data) as Record<string, string[]>;
      for (const c of cs) hexes.push(...(m[c] ?? []));
    }
    const hexRows = await this.rows(hexes.map((h) => `h${pad(bucket(h))}`));
    const all = new Map<string, LiveAircraft>();
    for (const r of hexRows) {
      for (const rec of JSON.parse(r.data) as Rec[]) if (hexes.includes(rec[0])) all.set(rec[0], fromRec(rec, r.ts));
    }
    // Keep the caller's callsign order (mainline first, then partners).
    const out = cs.flatMap((c) => [...all.values()].filter((a) => a.callsign === c));
    return { ac: out, ts: csRows[0].ts };
  }

  async countType(type: string): Promise<TypeCount & { ts: number } | null> {
    if (!this.env.DB) return null;
    const row = await this.env.DB.prepare("SELECT ts, n, total FROM type_counts WHERE type = ? ORDER BY ts DESC LIMIT 1")
      .bind(type)
      .first<{ ts: number; n: number; total: number | null }>();
    const fresh = Math.floor(this.now() / 1000) - 6 * 3600; // counts stay useful longer than positions
    return row && row.ts >= fresh ? { airborne: row.n, total: row.total ?? row.n, ts: row.ts } : null;
  }
}

/**
 * Snapshot first, then the direct live provider. If the snapshot is fresh and the aircraft isn't in it, a failed
 * direct call means "not seen in the latest snapshot" rather than an error: the snapshot covers every airliner that
 * volunteer receivers saw at that time.
 */
export class SnapshotFirstProvider implements LiveProvider {
  readonly name: string;
  constructor(
    private snap: Snapshot,
    private live: LiveProvider,
  ) {
    this.name = `snapshot+${live.name}`;
  }

  async byHex(hex: string): Promise<LiveAircraft | null> {
    const s = await this.snap.byHex(hex);
    if (s.ac) return s.ac;
    try {
      return await this.live.byHex(hex);
    } catch (e) {
      if (e instanceof ApiError && (s.ts ?? (await this.snap.freshAt())) !== null) return null;
      throw e;
    }
  }

  async byCallsigns(callsigns: string[]): Promise<LiveAircraft[]> {
    const s = await this.snap.byCallsigns(callsigns);
    if (s.ac.length) return s.ac;
    try {
      return await this.live.byCallsigns(callsigns);
    } catch (e) {
      if (e instanceof ApiError && (s.ts ?? (await this.snap.freshAt())) !== null) return [];
      throw e;
    }
  }

  byReg(reg: string): Promise<LiveAircraft | null> {
    return this.live.byReg(reg);
  }

  async countType(type: string): Promise<TypeCount> {
    const c = await this.snap.countType(type);
    if (c) return { airborne: c.airborne, total: c.total };
    return this.live.countType(type);
  }
}
