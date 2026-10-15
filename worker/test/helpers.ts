import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveProvider } from "../src/provider";
import { trimAircraft } from "../src/provider";
import type { LiveAircraft, TypeCount } from "../src/types";

export const FIX = join(__dirname, "..", "..", "pipeline", "tests", "fixtures", "upstream");
export const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixture(name)) as T;

export function liveFromFixture(name: string): LiveAircraft[] {
  return fixtureJson<{ ac: Record<string, unknown>[] }>(name).ac.map(trimAircraft);
}

/** In-memory provider that records every upstream call (to assert "one request per action"). */
export class FakeProvider implements LiveProvider {
  readonly name = "fake";
  calls: string[] = [];
  constructor(
    public aircraft: LiveAircraft[] = [],
    public counts: Record<string, TypeCount> = {},
    public failWith?: Error,
  ) {}
  async byHex(hex: string) {
    this.calls.push(`hex:${hex}`);
    if (this.failWith) throw this.failWith;
    return this.aircraft.find((a) => a.hex === hex.toUpperCase()) ?? null;
  }
  async byCallsigns(cs: string[]) {
    this.calls.push(`callsign:${cs.join(",")}`);
    if (this.failWith) throw this.failWith;
    return this.aircraft.filter((a) => a.callsign && cs.includes(a.callsign));
  }
  async byReg(reg: string) {
    this.calls.push(`reg:${reg}`);
    if (this.failWith) throw this.failWith;
    return this.aircraft.find((a) => a.reg === reg) ?? null;
  }
  async countType(t: string) {
    this.calls.push(`type:${t}`);
    if (this.failWith) throw this.failWith;
    return this.counts[t] ?? { total: 0, airborne: 0 };
  }
}

export function aircraft(p: Partial<LiveAircraft> & { hex: string }): LiveAircraft {
  return {
    reg: null,
    type: null,
    callsign: null,
    onGround: false,
    alt: 30000,
    gs: 450,
    track: 90,
    vrate: 0,
    lat: 40,
    lon: -100,
    posAge: 1,
    seen: 1,
    category: "A3",
    source: "adsb_icao",
    blocked: false,
    ...p,
  };
}

/** Minimal D1 stand-in: records SQL, serves canned rows for SELECTs. */
export class FakeD1 {
  executed: { sql: string; args: unknown[] }[] = [];
  constructor(public rows: Record<string, unknown>[] = []) {}
  prepare(sql: string) {
    const self = this;
    const stmt = {
      sql,
      args: [] as unknown[],
      bind(...args: unknown[]) {
        stmt.args = args;
        return stmt;
      },
      async first<T>() {
        self.executed.push({ sql, args: stmt.args });
        return (self.select(sql, stmt.args)[0] ?? null) as T | null;
      },
      async all<T>() {
        self.executed.push({ sql, args: stmt.args });
        return { results: self.select(sql, stmt.args) as T[] };
      },
    };
    return stmt;
  }
  select(sql: string, args: unknown[]) {
    if (sql.includes("FROM cron_runs")) return this.rows.filter((r) => "grp" in r);
    if (sql.includes("WHERE type = ?")) {
      return this.rows.filter((r) => r.type === args[0]).sort((a, b) => (b.ts as number) - (a.ts as number));
    }
    return this.rows.filter((r) => "type" in r);
  }
  async batch(stmts: { sql: string; args: unknown[] }[]) {
    for (const s of stmts) this.executed.push({ sql: s.sql, args: s.args });
    return [];
  }
}

/** caches.default stand-in. */
export class FakeCache {
  store = new Map<string, Response>();
  async match(req: Request) {
    const r = this.store.get(req.url);
    return r ? r.clone() : undefined;
  }
  async put(req: Request, res: Response) {
    this.store.set(req.url, res.clone());
  }
}

export const ctx = () => {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), pending };
};
