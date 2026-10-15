import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest, handleScheduled } from "../src/app";
import { lookupAircraft, lookupRoute } from "../src/enrich";
import { AdsbFiProvider, AdsbLolProvider, FallbackProvider, _resetCooldown, countStream, trimAircraft } from "../src/provider";
import { runCron, siblings } from "../src/siblings";
import { CRON_GROUPS, TRACKED_TYPES } from "../src/tracked";
import type { Env } from "../src/types";
import { aircraft, ctx, FakeCache, FakeD1, FakeProvider, fixture, fixtureJson } from "./helpers";

const ORIGIN = "https://tailtale.pages.dev";
const UA = "TailTale/1.0 (+test)";

function streamOf(text: string, chunk: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

const fakeFetch = (routes: Record<string, () => Response>) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return v();
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

let cache: FakeCache;
beforeEach(() => {
  cache = new FakeCache();
  (globalThis as unknown as { caches: unknown }).caches = { default: cache };
  _resetCooldown();
});
afterEach(() => {
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

describe("provider", () => {
  it("counts a real /v2/type body exactly, whatever the chunking", async () => {
    const body = fixture("adsblol_type_B738.json");
    const parsed = JSON.parse(body) as { ac: { alt_baro?: unknown }[] };
    const ground = parsed.ac.filter((a) => a.alt_baro === "ground").length;
    for (const chunk of [7, 64, 4096, 1 << 20]) {
      expect(await countStream(streamOf(body, chunk))).toEqual({ total: parsed.ac.length, airborne: parsed.ac.length - ground });
    }
    expect(await countStream(null)).toEqual({ total: 0, airborne: 0 });
  });

  it("trims aircraft and keeps no raw fields", () => {
    const raw = fixtureJson<{ ac: Record<string, unknown>[] }>("adsblol_type_B738.json").ac;
    const ground = trimAircraft(raw.find((a) => a.alt_baro === "ground")!);
    expect(ground.onGround).toBe(true);
    expect(ground.alt).toBe(0);
    const stale = trimAircraft(raw.find((a) => a.lastPosition && a.lat === undefined) ?? { hex: "x", lastPosition: { lat: 1, lon: 2, seen_pos: 600 } });
    expect(stale.lat).not.toBeNull();
    expect(Object.keys(ground).sort()).toEqual(
      ["alt", "blocked", "callsign", "category", "gs", "hex", "lat", "lon", "onGround", "posAge", "provider", "reg", "seen", "source", "track", "type", "vrate"],
    );
  });

  it("sends the identifying User-Agent and backs off after a 429", async () => {
    const f = vi.fn(async () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    const slept: number[] = [];
    const p = new AdsbLolProvider(UA, "https://api.adsb.lol", f as unknown as typeof fetch, 1, 1200, async (ms) => void slept.push(ms));
    await expect(p.byHex("a7197d")).rejects.toMatchObject({ code: "upstream_busy", status: 503 });
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ headers: { "user-agent": UA } });
    expect(slept).toEqual([1200]); // one polite retry
    await expect(p.byHex("a7197d")).rejects.toMatchObject({ code: "upstream_busy" });
    expect(f).toHaveBeenCalledTimes(2); // the call after the cooldown started never left the isolate
  });

  it("recovers when the single retry succeeds", async () => {
    let n = 0;
    const f = (async () => (++n === 1 ? new Response("", { status: 429 }) : new Response(fixture("adsblol_hex_a7197d.json")))) as unknown as typeof fetch;
    const p = new AdsbLolProvider(UA, "x", f, 1, 1, async () => {});
    expect((await p.byHex("a7197d"))?.reg).toBe("N557AS");
  });

  it("maps upstream failures to clean errors", async () => {
    const down = new AdsbLolProvider(UA, "x", (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch);
    await expect(down.byReg("N1")).rejects.toMatchObject({ code: "upstream_unreachable" });
    const err = new AdsbLolProvider(UA, "x", (async () => new Response("", { status: 500 })) as unknown as typeof fetch);
    await expect(err.byCallsigns(["X1"])).rejects.toMatchObject({ code: "upstream_error" });
    const ok = new AdsbLolProvider(UA, "x", (async () => new Response(fixture("adsblol_callsign_ASA73.json"))) as unknown as typeof fetch);
    expect((await ok.byCallsigns(["ASA73"]))[0].callsign).toBe("ASA73");
    expect(await ok.byCallsigns([])).toEqual([]);
    const typ = new AdsbLolProvider(UA, "x", (async () => new Response(fixture("adsblol_type_B738.json"))) as unknown as typeof fetch);
    expect((await typ.countType("B738")).total).toBe(1133);
  });
});

describe("fallback provider", () => {
  const busy = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
  const fiFetch = vi.fn(async (u: RequestInfo | URL) => {
    const url = String(u);
    if (url.includes("/v2/registration/")) return new Response(fixture("adsbfi_hex_a465df.json"));
    return new Response(fixture("adsbfi_hex_a465df.json"));
  }) as unknown as typeof fetch;

  it("answers from adsb.fi when ADSB.lol is rate-limiting, and says so", async () => {
    const p = new FallbackProvider(new AdsbLolProvider(UA, "x", busy, 0, 0, async () => {}), new AdsbFiProvider(UA, fiFetch, async () => {}));
    const a = await p.byHex("a465df");
    expect(a).toMatchObject({ hex: "A465DF", reg: "N38257", provider: "adsb.fi" });
    expect(JSON.stringify(a)).not.toMatch(/ownOp|UNITED AIRLINES/);
    expect((await p.byCallsigns(["UAL1125", "SKW1125"]))[0].callsign).toBe("UAL1125");
    await p.byReg("N38257");
    expect((fiFetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => String(c[0]).includes("/v2/registration/N38257"))).toBe(true);
    // adsb.fi has no by-type endpoint: the primary's error surfaces.
    await expect(p.countType("B738")).rejects.toMatchObject({ code: "upstream_busy" });
    expect(p.name).toBe("adsb.lol+adsb.fi");
  });

  it("does not fall back on caller errors, and prefers the primary when it answers", async () => {
    const ok = new AdsbLolProvider(UA, "x", (async () => new Response(fixture("adsblol_hex_a7197d.json"))) as unknown as typeof fetch);
    const never = vi.fn();
    const p = new FallbackProvider(ok, { name: "x", byHex: never, byCallsigns: never, byReg: never, countType: never });
    expect((await p.byHex("a7197d"))?.provider).toBe("adsb.lol");
    expect(never).not.toHaveBeenCalled();
    const boom = new FallbackProvider(
      { name: "a", byHex: async () => { throw new Error("bug"); }, byCallsigns: never, byReg: never, countType: never },
      { name: "b", byHex: never, byCallsigns: never, byReg: never, countType: never },
    );
    await expect(boom.byHex("a")).rejects.toThrow("bug");
    expect(never).not.toHaveBeenCalled();
  });
});

describe("enrich", () => {
  it("normalizes adsbdb routes", async () => {
    const f = fakeFetch({ "adsbdb.com/v0/callsign/UAL1711": () => new Response(fixture("adsbdb_callsign_UAL1711.json")) });
    const r = await lookupRoute("ual1711", UA, null, f);
    expect(r).toMatchObject({
      callsign: "UAL1711",
      source: "adsbdb",
      airline: { name: "United Airlines", icao: "UAL", iata: "UA" },
      origin: { icao: "KSFO", iata: "SFO", city: "San Francisco" },
      destination: { icao: "KCLE", iata: "CLE" },
    });
  });

  it("falls back to ADSB.lol when adsbdb has no route, tolerating an empty routeset", async () => {
    const f = fakeFetch({
      "adsbdb.com": () => new Response(fixture("adsbdb_callsign_notfound.json"), { status: 404 }),
      "/api/0/routeset": () => new Response("", { status: 201 }),
      "/api/0/route/ASA73": () => new Response(fixture("adsblol_route_ASA73.json")),
    });
    const r = await lookupRoute("ASA73", UA, { lat: 57, lon: -135 }, f);
    expect(r).toMatchObject({ source: "adsb.lol", origin: { icao: "PASI" }, destination: { icao: "PANC" } });
    const none = fakeFetch({ "adsbdb.com": () => new Response(fixture("adsbdb_callsign_notfound.json"), { status: 404 }) });
    expect(await lookupRoute("ZZZ9999", UA, null, none)).toBeNull();
  });

  it("returns adsbdb aircraft without owner names", async () => {
    const f = fakeFetch({ "aircraft/G-EUPT": () => new Response(fixture("adsbdb_aircraft_G-EUPT.json")) });
    const a = await lookupAircraft("G-EUPT", UA, f);
    expect(a?.reg).toBe("G-EUPT");
    expect(JSON.stringify(a)).not.toMatch(/registered_owner|url_photo/);
    expect(await lookupAircraft("ZZZZZZ", UA, fakeFetch({}))).toBeNull();
  });
});

describe("HTTP API", () => {
  const env = (extra: Partial<Env> = {}): Env => ({ PAGES_ORIGIN: ORIGIN, ...extra });

  it("live endpoint: trimmed, cached for 15 s, CORS only for the Pages origin", async () => {
    const p = new FakeProvider([aircraft({ hex: "A7197D", callsign: "ASA73" })]);
    const deps = { provider: p, fetcher: fakeFetch({}) };
    const c = ctx();
    const req = () => new Request("https://api.test/api/live/a7197d", { headers: { origin: ORIGIN } });
    const r1 = await handleRequest(req(), env(), c, deps);
    await Promise.all(c.pending);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r1.headers.get("cache-control")).toBe("public, max-age=15");
    expect(await r1.json()).toMatchObject({ hex: "A7197D", live: { callsign: "ASA73" }, blocked: false });
    const r2 = await handleRequest(req(), env(), c, deps);
    expect(r2.headers.get("x-cache")).toBe("HIT");
    expect(p.calls).toHaveLength(1);
    const evil = await handleRequest(new Request("https://api.test/api/live/a7197d", { headers: { origin: "https://evil.example" } }), env(), c, deps);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const preview = await handleRequest(new Request("https://api.test/api/live/a7197d", { headers: { origin: "https://abc123.tailtale.pages.dev" } }), env(), c, deps);
    expect(preview.headers.get("access-control-allow-origin")).toBe("https://abc123.tailtale.pages.dev");
  });

  it("consistent error shape and status codes", async () => {
    const deps = { provider: new FakeProvider([]), fetcher: fakeFetch({}) };
    const bad = await handleRequest(new Request("https://x/api/live/zzz"), env(), ctx(), deps);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "bad_hex", message: expect.any(String) } });
    const nf = await handleRequest(new Request("https://x/api/nope"), env(), ctx(), deps);
    expect(nf.status).toBe(404);
    const post = await handleRequest(new Request("https://x/api/live/a7197d", { method: "POST" }), env(), ctx(), deps);
    expect(post.status).toBe(405);
    const opt = await handleRequest(new Request("https://x/api/live/a7197d", { method: "OPTIONS", headers: { origin: ORIGIN } }), env(), ctx(), deps);
    expect(opt.status).toBe(204);
    const boom = { provider: new FakeProvider([], {}, new Error("kaboom")), fetcher: fakeFetch({}) };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r500 = await handleRequest(new Request("https://x/api/live/a7197d"), env(), ctx(), boom);
    expect(r500.status).toBe(500);
    expect(JSON.stringify(await r500.json())).not.toMatch(/kaboom/);
  });

  it("resolve endpoint reads static shards via ASSETS and returns the not_found hint", async () => {
    const assets = {
      fetch: async (r: Request) =>
        r.url.endsWith("/data/reg/n/557.json")
          ? new Response(JSON.stringify({ N557AS: "A7197D" }), { headers: { "content-type": "application/json" } })
          : new Response("<html>", { headers: { "content-type": "text/html" } }),
    } as unknown as Fetcher;
    const p = new FakeProvider([]);
    const deps = { provider: p, fetcher: fakeFetch({}) };
    const ok = await handleRequest(new Request("https://x/api/resolve?q=N557AS"), env({ ASSETS: assets }), ctx(), deps);
    expect(await ok.json()).toMatchObject({ hex: "A7197D", matchedBy: "n_number", live: null });
    const miss = await handleRequest(new Request("https://x/api/resolve?q=DL5123"), env({ ASSETS: assets }), ctx(), deps);
    expect(miss.status).toBe(404);
    const body = (await miss.json()) as { error: { code: string; hint: string; reason: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.reason).toBe("flight_not_live");
    expect(body.error.hint).toMatch(/painted on the plane's tail/);
  });

  it("resolve can read shards from the Pages origin when running as a standalone Worker", async () => {
    const f = fakeFetch({
      "tailtale.pages.dev/data/reg/n/557.json": () => new Response(JSON.stringify({ N557AS: "A7197D" }), { headers: { "content-type": "application/json" } }),
    });
    const r = await handleRequest(new Request("https://x/api/resolve?q=N557AS"), env(), ctx(), { provider: new FakeProvider([]), fetcher: f });
    expect(await r.json()).toMatchObject({ hex: "A7197D" });
    const broken = fakeFetch({ "pages.dev": () => new Response("err", { status: 500 }) });
    const r2 = await handleRequest(new Request("https://x/api/resolve?q=N557AT"), env(), ctx(), { provider: new FakeProvider([]), fetcher: broken });
    expect(r2.status).toBe(502);
  });

  it("route endpoint caches a day and validates input", async () => {
    const f = fakeFetch({ "adsbdb.com/v0/callsign/UAL1711": () => new Response(fixture("adsbdb_callsign_UAL1711.json")) });
    const deps = { provider: new FakeProvider([]), fetcher: f };
    const r = await handleRequest(new Request("https://x/api/route/UAL1711"), env(), ctx(), deps);
    expect(r.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(await r.json()).toMatchObject({ origin: { iata: "SFO" } });
    expect((await handleRequest(new Request("https://x/api/route/!!"), env(), ctx(), deps)).status).toBe(400);
    const nf = await handleRequest(new Request("https://x/api/route/ZZZ1?lat=1&lon=2"), env(), ctx(), deps);
    expect(nf.status).toBe(404);
  });

  it("aircraft endpoint", async () => {
    const f = fakeFetch({ "aircraft/A7197D": () => new Response(fixture("adsbdb_aircraft_A7197D.json")) });
    const r = await handleRequest(new Request("https://x/api/aircraft/a7197d"), env(), ctx(), { provider: new FakeProvider([]), fetcher: f });
    expect(await r.json()).toMatchObject({ hex: "A7197D", icaoType: "B738", operatorCode: "ASA" });
    const nf = await handleRequest(new Request("https://x/api/aircraft/ZZZ"), env(), ctx(), { provider: new FakeProvider([]), fetcher: f });
    expect(nf.status).toBe(404);
    expect((await handleRequest(new Request("https://x/api/aircraft/%24%24"), env(), ctx(), { provider: new FakeProvider([]), fetcher: f })).status).toBe(400);
  });

  it("siblings: D1 for tracked types, live count otherwise; trend from D1", async () => {
    const now = Date.now();
    const ts = Math.floor(now / 1000) - 60;
    const db = new FakeD1([
      { ts, type: "B738", n: 214, total: 250 },
      { ts: ts - 600, type: "B738", n: 200, total: 230 },
    ]);
    const p = new FakeProvider([], { C172: { total: 900, airborne: 400 }, B738: { total: 1, airborne: 1 } });
    const deps = { provider: p, fetcher: fakeFetch({}) };
    const e = env({ DB: db as unknown as D1Database });
    const tracked = await handleRequest(new Request("https://x/api/siblings/b738"), e, ctx(), deps);
    expect(await tracked.json()).toMatchObject({ type: "B738", airborne: 214, source: "cron" });
    const untracked = await handleRequest(new Request("https://x/api/siblings/C172"), e, ctx(), deps);
    expect(await untracked.json()).toMatchObject({ type: "C172", airborne: 400, source: "live" });
    expect(p.calls).toEqual(["type:C172"]);
    const tr = await handleRequest(new Request("https://x/api/siblings/B738/trend"), e, ctx(), deps);
    expect(tr.headers.get("cache-control")).toBe("public, max-age=600");
    expect(((await tr.json()) as { points: unknown[] }).points).toHaveLength(2);
    const all = await handleRequest(new Request("https://x/api/siblings"), e, ctx(), deps);
    expect(await all.json()).toMatchObject({ types: { B738: expect.any(Number) } });
    expect((await handleRequest(new Request("https://x/api/siblings/TOOLONG"), e, ctx(), deps)).status).toBe(400);
    // Stale cron data falls back to a live count.
    const stale = new FakeD1([{ ts: ts - 7200, type: "B738", n: 5, total: 5 }]);
    expect(await siblings({ DB: stale as unknown as D1Database }, p, "B738", now)).toMatchObject({ source: "live" });
  });

  it("health reports upstreams and the last cron run", async () => {
    const db = new FakeD1([{ ts: 1, grp: "x", ok: 1, types: 10, errors: 0 }]);
    const f = fakeFetch({ "adsb.lol": () => new Response("{}"), "adsbdb.com": () => new Response("{}", { status: 404 }) });
    const r = await handleRequest(new Request("https://x/api/health"), env({ DB: db as unknown as D1Database }), ctx(), {
      provider: new FakeProvider([]),
      fetcher: f,
    });
    const body = (await r.json()) as { ok: boolean; lastCron: { types: number } };
    expect(body.ok).toBe(true);
    expect(body.lastCron.types).toBe(10);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("cron", () => {
  it("groups cover every tracked type exactly once", () => {
    expect(Object.values(CRON_GROUPS).flat().sort()).toEqual([...TRACKED_TYPES].sort());
    expect(TRACKED_TYPES.length).toBe(40);
  });

  it("writes one row per type into the shared 10-minute slot, prunes 8 days, logs the run", async () => {
    const db = new FakeD1();
    const p = new FakeProvider([], { A319: { total: 300, airborne: 250 } });
    const cron = "0-59/10 * * * *";
    const now = Date.UTC(2026, 9, 15, 12, 3, 30);
    const r = await runCron({ DB: db as unknown as D1Database }, p, cron, { now, sleep: async () => {} });
    expect(r).toEqual({ written: 10, errors: 0 });
    const inserts = db.executed.filter((x) => x.sql.startsWith("INSERT INTO type_counts"));
    expect(inserts).toHaveLength(10);
    expect(inserts[0].args).toEqual([Date.UTC(2026, 9, 15, 12, 0) / 1000, "A319", 250, 300]);
    const del = db.executed.find((x) => x.sql.startsWith("DELETE FROM type_counts"))!;
    expect(del.args[0]).toBe(Date.UTC(2026, 9, 15, 12, 0) / 1000 - 8 * 86400);
    expect(db.executed.some((x) => x.sql.includes("INTO cron_runs"))).toBe(true);
    expect(p.calls).toEqual(CRON_GROUPS[cron].map((t) => `type:${t}`));
  });

  it("stops the run on a 429 and records the error", async () => {
    const db = new FakeD1();
    let n = 0;
    const p = new AdsbLolProvider(UA, "x", (async () => (++n >= 3 ? new Response("", { status: 429 }) : new Response('{"ac":[{"hex":"a"}]}'))) as unknown as typeof fetch, 1, 1, async () => {});
    const r = await runCron({ DB: db as unknown as D1Database }, p, "1-59/10 * * * *", { sleep: async () => {} });
    expect(r).toEqual({ written: 2, errors: 1 });
    expect(n).toBe(4); // third type: first try + one retry, then the run stops
  });

  it("is a no-op without D1 and is reachable from the scheduled handler", async () => {
    expect(await runCron({}, new FakeProvider([]), "x")).toEqual({ written: 0, errors: 0 });
    const db = new FakeD1();
    await handleScheduled(
      "3-59/10 * * * *",
      { DB: db as unknown as D1Database },
      { provider: new FakeProvider([]), fetcher: fakeFetch({}) },
      { sleep: async () => {} },
    );
    expect(db.executed.filter((x) => x.sql.startsWith("INSERT INTO type_counts"))).toHaveLength(10);
  });
});
