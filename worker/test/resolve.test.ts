import { describe, expect, it } from "vitest";
import { ApiError } from "../src/http";
import { classify, NOT_FOUND_HINT, resolve, type ResolveDeps } from "../src/resolve";
import { aircraft, FakeProvider, liveFromFixture } from "./helpers";

const N_SHARD = JSON.stringify({ N557AS: "A7197D", N55AS: "A6F2A1" });
const HEX_SHARD = JSON.stringify({ A7197D: { hex: "A7197D", n: "N557AS" } });

function deps(p: FakeProvider, extra: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    provider: p,
    staticText: async (path) => (path === "reg/n/557.json" ? N_SHARD : path === "reg/hex/A71.json" ? HEX_SHARD : null),
    ...extra,
  };
}

async function notFound(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected an ApiError");
}

describe("classify", () => {
  it.each([
    ["a7197d", ["hex"]],
    ["N557AS", ["n_number"]],
    [" n 557-as ", ["n_number"]],
    ["N1", ["n_number"]],
    ["G-EUPT", ["registration"]],
    ["c-fabc", ["registration"]],
    ["DL1234", ["flight_number"]],
    ["dl 1234", ["flight_number"]],
    ["B6123", ["flight_number"]],
    ["NK123", ["flight_number"]],
    ["DAL1234", ["callsign"]],
    ["ACA123", ["hex", "callsign"]], // all-hex callsign: hex first, then callsign
    ["", ["invalid"]],
    ["NOT A PLANE!!", ["invalid"]],
    ["NO123", ["flight_number"]], // N-numbers never start with a letter after N, so this is airline "NO"
  ])("%s -> %j", (q, kinds) => {
    expect(classify(q).map((k) => k.kind)).toEqual(kinds);
  });

  it("maps IATA flight numbers to ICAO callsigns with regional partners", () => {
    const k = classify("DL0054")[0];
    expect(k).toMatchObject({ kind: "flight_number", iata: "DL", number: "54" });
    if (k.kind === "flight_number") expect(k.callsigns).toEqual(["DAL54", "EDV54", "SKW54", "RPA54"]);
    const b6 = classify("B6123")[0];
    if (b6.kind === "flight_number") expect(b6.callsigns).toEqual(["JBU123"]);
  });
});

describe("resolve", () => {
  const asa = liveFromFixture("adsblol_hex_a7197d.json")[0];

  it("resolves a live hex", async () => {
    const p = new FakeProvider([asa]);
    const r = await resolve("a7197d", deps(p));
    expect(r).toMatchObject({ hex: "A7197D", reg: "N557AS", callsign: "ASA73", type: "B738", matchedBy: "hex" });
    expect(r.live?.alt).toBe(16250);
    expect(p.calls).toEqual(["hex:A7197D"]); // registry checked first (static), then one live call
  });

  it("resolves a registry-only hex when the plane is not flying", async () => {
    const r = await resolve("A7197D", deps(new FakeProvider([])));
    expect(r).toMatchObject({ hex: "A7197D", matchedBy: "hex", live: null });
  });

  it("resolves an N-number through the static shard, then one live lookup", async () => {
    const p = new FakeProvider([asa]);
    const r = await resolve("n557as", deps(p));
    expect(r).toMatchObject({ hex: "A7197D", reg: "N557AS", matchedBy: "n_number" });
    expect(p.calls).toEqual(["hex:A7197D"]);
  });

  it("still resolves registry aircraft when the live source is rate-limiting", async () => {
    const busy = new FakeProvider([], {}, new ApiError(503, "upstream_busy", "slow down"));
    expect(await resolve("N557AS", deps(busy))).toMatchObject({ hex: "A7197D", matchedBy: "n_number", live: null });
    expect(await resolve("A7197D", deps(busy))).toMatchObject({ hex: "A7197D", matchedBy: "hex", live: null });
    // Unknown aircraft still surface the upstream error rather than a misleading not_found.
    await expect(resolve("DL1234", deps(busy))).rejects.toMatchObject({ code: "upstream_busy" });
  });

  it("falls back to live /reg for N-numbers missing from the registry", async () => {
    const p = new FakeProvider([aircraft({ hex: "A12345", reg: "N999ZZ" })]);
    const r = await resolve("N999ZZ", deps(p));
    expect(r).toMatchObject({ hex: "A12345", matchedBy: "n_number" });
  });

  it("resolves a mainline flight number in one upstream request", async () => {
    const p = new FakeProvider([aircraft({ hex: "A00001", callsign: "DAL1234", reg: "N1" })]);
    const r = await resolve("DL1234", deps(p));
    expect(r).toMatchObject({ hex: "A00001", callsign: "DAL1234", matchedBy: "flight_number" });
    expect(p.calls).toEqual(["callsign:DAL1234,EDV1234,SKW1234,RPA1234"]);
  });

  it("finds a Delta Connection flight flown under the SkyWest callsign", async () => {
    const p = new FakeProvider([aircraft({ hex: "A18B41", callsign: "SKW3487", reg: "N199SY", type: "E75L" })]);
    const r = await resolve("DL3487", deps(p));
    expect(r).toMatchObject({ hex: "A18B41", callsign: "SKW3487", matchedBy: "flight_number_partner" });
    expect(p.calls).toHaveLength(1);
  });

  it("regional carrier not broadcasting: helpful not_found that explains codeshares and asks for the tail", async () => {
    const p = new FakeProvider([]);
    const e = await notFound(resolve("DL5123", deps(p)));
    expect(e.status).toBe(404);
    expect(e.code).toBe("not_found");
    expect(e.extra.reason).toBe("flight_not_live");
    expect(e.extra.hint).toBe(NOT_FOUND_HINT);
    expect(e.message).toMatch(/regional or codeshare partner/);
    expect(e.message).toMatch(/DAL5123/);
    expect(p.calls).toEqual(["callsign:DAL5123,EDV5123,SKW5123,RPA5123"]);
  });

  it("unknown airline code still gets the tail-number hint", async () => {
    const e = await notFound(resolve("ZZ123", deps(new FakeProvider([]))));
    expect(e.extra).toMatchObject({ reason: "flight_not_live", hint: NOT_FOUND_HINT });
    expect(e.message).toMatch(/ZZ/);
  });

  it("resolves an ICAO callsign", async () => {
    const r = await resolve("ASA73", deps(new FakeProvider([asa])));
    expect(r).toMatchObject({ hex: "A7197D", matchedBy: "callsign" });
  });

  it("falls through hex to callsign for all-hex callsigns", async () => {
    const p = new FakeProvider([aircraft({ hex: "C01234", callsign: "ACA123" })]);
    const r = await resolve("ACA123", deps(p));
    expect(r).toMatchObject({ hex: "C01234", matchedBy: "callsign" });
  });

  it("resolves a foreign registration via live data, then adsbdb", async () => {
    const live = new FakeProvider([aircraft({ hex: "406B2F", reg: "G-EUPT" })]);
    expect(await resolve("G-EUPT", deps(live))).toMatchObject({ hex: "406B2F", matchedBy: "registration" });
    const r = await resolve(
      "G-EUPT",
      deps(new FakeProvider([]), { adsbdbHex: async () => ({ hex: "406B2F", reg: "G-EUPT", type: "A319" }) }),
    );
    expect(r).toMatchObject({ hex: "406B2F", type: "A319", live: null });
  });

  it("never returns a position for LADD/PIA aircraft", async () => {
    const ladd = liveFromFixture("adsblol_hex_ladd_aaf29f.json")[0];
    expect(ladd.blocked).toBe(true);
    expect(ladd.lat).toBeNull();
    const r = await resolve("aaf29f", deps(new FakeProvider([ladd])));
    expect(r).toMatchObject({ hex: "AAF29F", blocked: true, live: null, callsign: null });
  });

  it("rejects garbage with 400 and unknown tails with 404 + hint", async () => {
    expect((await notFound(resolve("??", deps(new FakeProvider([]))))).status).toBe(400);
    const e = await notFound(resolve("N12345", deps(new FakeProvider([]))));
    expect(e.status).toBe(404);
    expect(e.extra).toMatchObject({ reason: "unknown_aircraft", hint: NOT_FOUND_HINT });
  });
});
