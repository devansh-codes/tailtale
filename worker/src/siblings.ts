import { ApiError } from "./http";
import type { LiveProvider } from "./provider";
import { CRON_GROUPS, isTracked, TRACKED_TYPES } from "./tracked";
import type { Env } from "./types";

const TEN_MIN = 600;
const RETENTION_S = 8 * 86400;
const STALE_S = 30 * 60;

export interface SiblingCount {
  type: string;
  airborne: number;
  total: number | null;
  ts: number;
  source: "cron" | "live";
}

export function normalizeType(t: string): string {
  const u = t.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,4}$/.test(u)) throw new ApiError(400, "bad_type", "ICAO type designators are 2 to 4 letters or digits, like B738.");
  return u;
}

export async function siblings(env: Env, provider: LiveProvider, type: string, now = Date.now()): Promise<SiblingCount> {
  const ts = Math.floor(now / 1000);
  if (env.DB && isTracked(type)) {
    const row = await env.DB.prepare("SELECT ts, n, total FROM type_counts WHERE type = ? ORDER BY ts DESC LIMIT 1")
      .bind(type)
      .first<{ ts: number; n: number; total: number | null }>();
    if (row && ts - row.ts < STALE_S) return { type, airborne: row.n, total: row.total, ts: row.ts, source: "cron" };
  }
  const c = await provider.countType(type);
  return { type, airborne: c.airborne, total: c.total, ts, source: "live" };
}

export async function allSiblings(env: Env, now = Date.now()): Promise<{ ts: number | null; types: Record<string, number> }> {
  if (!env.DB) return { ts: null, types: {} };
  const since = Math.floor(now / 1000) - STALE_S;
  // All cron groups write the same 10-minute slot timestamp, so the latest slot holds every type.
  const { results } = await env.DB.prepare(
    "SELECT type, n, ts FROM type_counts WHERE ts >= ? AND ts >= (SELECT MAX(ts) FROM type_counts) - ? ORDER BY ts",
  )
    .bind(since, TEN_MIN)
    .all<{ type: string; n: number; ts: number }>();
  const types: Record<string, number> = {};
  let ts: number | null = null;
  for (const r of results ?? []) {
    types[r.type] = r.n;
    ts = Math.max(ts ?? 0, r.ts);
  }
  return { ts, types };
}

export async function trend(env: Env, type: string, now = Date.now()): Promise<{ type: string; points: [number, number][] }> {
  if (!env.DB || !isTracked(type)) return { type, points: [] };
  const since = Math.floor(now / 1000) - 7 * 86400;
  const { results } = await env.DB.prepare("SELECT ts, n FROM type_counts WHERE type = ? AND ts >= ? ORDER BY ts")
    .bind(type, since)
    .all<{ ts: number; n: number }>();
  return { type, points: (results ?? []).map((r) => [r.ts, r.n]) };
}

/** Cron: count one group of tracked types sequentially, polite delay between calls, stop on 429. */
export async function runCron(
  env: Env,
  provider: LiveProvider,
  cron: string,
  opts: { now?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ written: number; errors: number }> {
  if (!env.DB) return { written: 0, errors: 0 };
  const started = Date.now();
  const types = CRON_GROUPS[cron] ?? TRACKED_TYPES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delay = opts.delayMs ?? 2500;
  // Bucket to the 10-minute slot so the four groups line up on the same timestamps.
  const ts = Math.floor((opts.now ?? Date.now()) / 1000 / TEN_MIN) * TEN_MIN;
  const rows: { type: string; n: number; total: number }[] = [];
  let errors = 0;
  for (const [i, type] of types.entries()) {
    if (i) await sleep(delay);
    try {
      const c = await provider.countType(type);
      rows.push({ type, n: c.airborne, total: c.total });
    } catch (e) {
      errors++;
      if (e instanceof ApiError && e.code === "upstream_busy") break; // back off until the next run
    }
  }
  const stmts = rows.map((r) => env.DB!.prepare("INSERT INTO type_counts (ts, type, n, total) VALUES (?, ?, ?, ?)").bind(ts, r.type, r.n, r.total));
  stmts.push(
    env.DB.prepare("DELETE FROM type_counts WHERE ts < ? AND type IN (" + types.map(() => "?").join(",") + ")").bind(ts - RETENTION_S, ...types),
  );
  stmts.push(
    env.DB.prepare("INSERT OR REPLACE INTO cron_runs (ts, grp, ok, types, errors, ms) VALUES (?, ?, ?, ?, ?, ?)").bind(
      Math.floor(Date.now() / 1000),
      cron,
      errors === 0 ? 1 : 0,
      rows.length,
      errors,
      Date.now() - started,
    ),
    env.DB.prepare("DELETE FROM cron_runs WHERE ts < ?").bind(ts - RETENTION_S),
  );
  await env.DB.batch(stmts);
  console.log(JSON.stringify({ cron, written: rows.length, errors, ms: Date.now() - started }));
  return { written: rows.length, errors };
}

export async function lastCron(env: Env): Promise<{ ts: number; ok: number; types: number; errors: number; grp: string } | null> {
  if (!env.DB) return null;
  return env.DB.prepare("SELECT ts, grp, ok, types, errors FROM cron_runs ORDER BY ts DESC LIMIT 1").first();
}
