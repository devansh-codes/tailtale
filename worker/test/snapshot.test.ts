import { describe, expect, it } from "vitest";
import { ApiError } from "../src/http";
import { resolve } from "../src/resolve";
import { bucket, Snapshot, SnapshotFirstProvider } from "../src/snapshot";
import type { Env } from "../src/types";
import { FakeD1, FakeProvider } from "./helpers";

const NOW = Date.UTC(2026, 9, 15, 18, 30) / 1000;
const pad = (n: number) => n.toString().padStart(2, "0");
const UAL = ["A465DF", "UAL1711", "N38257", "B738", 37.3, -118.4, 29000, 416.8, 85, 0, "A3", 1, 0];
const SKW = ["AD9B94", "SKW5123", "N976SW", "CRJ2", 36.9, -105.4, "g", 4, 180, null, "A2", 2, 0];
const LADD = ["AAF29F", null, null, "B738", null, null, null, null, null, null, null, null, 1];

function db(ts = NOW - 300) {
  const hex = new Map<string, unknown[][]>();
  for (const r of [UAL, SKW, LADD]) {
    const k = `h${pad(bucket(r[0] as string))}`;
    hex.set(k, [...(hex.get(k) ?? []), r]);
  }
  const cs = new Map<string, Record<string, string[]>>();
  for (const r of [UAL, SKW]) {
    const k = `c${pad(bucket(r[1] as string))}`;
    cs.set(k, { ...(cs.get(k) ?? {}), [r[1] as string]: [r[0] as string] });
  }
  return new FakeD1([
    ...[...hex].map(([k, v]) => ({ k, ts, data: JSON.stringify(v) })),
    ...[...cs].map(([k, v]) => ({ k, ts, data: JSON.stringify(v) })),
    { k: "meta", ts, data: "{}" },
    { ts: ts - (ts % 600), type: "B738", n: 900, total: 1000 },
  ]);
}
const env = (d: FakeD1): Env => ({ DB: d as unknown as D1Database });
const busy = () => new FakeProvider([], {}, new ApiError(503, "upstream_busy", "slow down"));

describe("snapshot", () => {
  it("bucket matches the Python writer", () => {
    // pipeline/live_snapshot.py: sum(ord(c) for c in key.upper()) % 32
    expect(bucket("A7197D")).toBe([..."A7197D"].reduce((s, c) => s + c.charCodeAt(0), 0) % 32);
    expect(bucket("ual1711")).toBe(bucket("UAL1711"));
  });

  it("finds aircraft by hex and by callsign, stamped with the snapshot time", async () => {
    const s = new Snapshot(env(db()), () => NOW * 1000);
    const h = await s.byHex("a465df");
    expect(h.ac).toMatchObject({ hex: "A465DF", callsign: "UAL1711", alt: 29000, provider: "adsb.lol", asOf: NOW - 300 });
    const c = await s.byCallsigns(["DAL5123", "SKW5123"]);
    expect(c.ac.map((a) => a.callsign)).toEqual(["SKW5123"]);
    expect(c.ac[0]).toMatchObject({ onGround: true, alt: 0 });
    expect(await s.freshAt()).toBe(NOW - 300);
  });

  it("never exposes position or callsign for LADD/PIA stubs", async () => {
    const a = (await new Snapshot(env(db()), () => NOW * 1000).byHex("AAF29F")).ac!;
    expect(a).toMatchObject({ blocked: true, lat: null, lon: null, callsign: null, type: "B738" });
  });

  it("ignores a stale snapshot", async () => {
    const s = new Snapshot(env(db(NOW - 3 * 3600)), () => NOW * 1000);
    expect((await s.byHex("A465DF")).ac).toBeNull();
    expect(await s.freshAt()).toBeNull();
    expect(await s.countType("B738")).toBeNull();
  });

  it("snapshot-first provider: no upstream call when the snapshot answers", async () => {
    const live = busy();
    const p = new SnapshotFirstProvider(new Snapshot(env(db()), () => NOW * 1000), live);
    expect((await p.byHex("A465DF"))?.callsign).toBe("UAL1711");
    expect((await p.countType("B738")).airborne).toBe(900);
    expect(live.calls).toEqual([]);
  });

  it("not in a fresh snapshot + upstream refusing = not seen (not an error); no snapshot = error", async () => {
    const p = new SnapshotFirstProvider(new Snapshot(env(db()), () => NOW * 1000), busy());
    expect(await p.byHex("A00001")).toBeNull();
    expect(await p.byCallsigns(["DAL1"])).toEqual([]);
    const none = new SnapshotFirstProvider(new Snapshot(env(new FakeD1()), () => NOW * 1000), busy());
    await expect(none.byHex("A00001")).rejects.toMatchObject({ code: "upstream_busy" });
  });

  it("flight-number search works end to end from the snapshot, including regional partners", async () => {
    const p = new SnapshotFirstProvider(new Snapshot(env(db()), () => NOW * 1000), busy());
    const deps = { provider: p, staticText: async () => null };
    expect(await resolve("UA1711", deps)).toMatchObject({ hex: "A465DF", matchedBy: "flight_number" });
    expect(await resolve("DL5123", deps)).toMatchObject({ hex: "AD9B94", matchedBy: "flight_number_partner" });
    await expect(resolve("DL9999", deps)).rejects.toMatchObject({ code: "not_found" });
  });
});
