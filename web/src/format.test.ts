import { describe, expect, it } from "vitest";
import { age, fmtMins, ownerLabel, pluralModel, prettyName, summarize } from "./format";
import { silhouette, silhouetteKind } from "./silhouette";
import type { HistEntry } from "./types";

describe("format", () => {
  it("prettifies FAA organisation names", () => {
    expect(prettyName("ALASKA AIRLINES INC")).toBe("Alaska Airlines Inc");
    expect(prettyName("BANK OF UTAH TRUSTEE")).toBe("Bank of Utah Trustee");
    expect(prettyName("WELLS FARGO TRUST CO NA TRUSTEE")).toBe("Wells Fargo Trust Co NA Trustee");
  });

  it("never names private owners", () => {
    expect(ownerLabel({ hex: "A", n: "N1", owner_kind: "individual" })).toBe("Private owner (not shown)");
    expect(ownerLabel({ hex: "A", n: "N1", owner_kind: "co-owned" })).toBe("Private owner (not shown)");
    expect(ownerLabel({ hex: "A", n: "N1", owner_kind: "llc", owner_org: "SKY LLC" })).toBe("Sky LLC");
  });

  it("formats durations, ages and plurals", () => {
    expect(fmtMins(233)).toBe("3 h 53 min");
    expect(fmtMins(45)).toBe("45 min");
    expect(age(2006, new Date("2026-10-15"))).toBe(20);
    expect(age(undefined)).toBeNull();
    expect(pluralModel("Boeing 737 MAX 8", 2)).toBe("Boeing 737 MAX 8s");
    expect(pluralModel("Boeing 737 MAX 8", 1)).toBe("Boeing 737 MAX 8");
  });
});

describe("summarize", () => {
  const h: HistEntry = {
    t: "B38M",
    days: [
      {
        d: "2026-10-13",
        airborne_mins: 100,
        max_alt: 35000,
        flights: [{ dep: "KDEN", arr: "KLAS", t_off: 0, t_on: 6000, mins: 100, incomplete: false }],
      },
      {
        d: "2026-10-14",
        airborne_mins: 330,
        max_alt: 40000,
        flights: [
          { dep: "KLAS", arr: "KEWR", t_off: 0, t_on: 1, mins: 233, incomplete: false },
          { dep: "KEWR", arr: null, t_off: 0, t_on: 1, mins: 97, incomplete: true },
        ],
      },
    ],
  };

  it("rolls up 30 days with zero-filled days", () => {
    const s = summarize(h, new Date("2026-10-15T12:00:00Z"));
    expect(s.days).toHaveLength(30);
    expect(s.days[s.days.length - 1]).toMatchObject({ d: "2026-10-14", flights: 2, incomplete: 1 });
    expect(s.days[0].flights).toBe(0);
    expect(s.flights).toBe(3);
    expect(s.hours).toBeCloseTo(430 / 60);
    expect(s.longest).toMatchObject({ mins: 233, dep: "KLAS", arr: "KEWR" }); // incomplete flights never count as longest
    expect(s.busiest).toEqual({ d: "2026-10-14", flights: 2 });
    expect(s.airports.map((a) => a.code)).toEqual(["KEWR", "KLAS", "KDEN"]);
    expect(s.incomplete).toBe(1);
  });

  it("handles no history", () => {
    const s = summarize(null, new Date("2026-10-15T12:00:00Z"));
    expect(s.flights).toBe(0);
    expect(s.days.every((d) => d.flights === 0)).toBe(true);
    expect(s.longest).toBeNull();
  });
});

describe("silhouettes", () => {
  it("picks a kind from FAA facts, then ADS-B category", () => {
    expect(silhouetteKind({ hex: "A", n: "N", eng_type: "Turbofan", seats: 175 })).toBe("narrowbody");
    expect(silhouetteKind({ hex: "A", n: "N", eng_type: "Turbofan", seats: 330 })).toBe("widebody");
    expect(silhouetteKind({ hex: "A", n: "N", eng_type: "Turbofan", seats: 88 })).toBe("regional");
    expect(silhouetteKind({ hex: "A", n: "N", eng_type: "Turbofan", seats: 9 })).toBe("bizjet");
    expect(silhouetteKind({ hex: "A", n: "N", eng_type: "Reciprocating" })).toBe("piston");
    expect(silhouetteKind({ hex: "A", n: "N", cat: "Rotorcraft", eng_type: "Turboshaft" })).toBe("helicopter");
    expect(silhouetteKind({ hex: "A", n: "N", cat: "Balloon" })).toBe("balloon");
    expect(silhouetteKind(null, "A5")).toBe("widebody");
    expect(silhouetteKind(null, "A3", "E75L")).toBe("regional");
    expect(silhouetteKind(null, null, "B789")).toBe("widebody");
    expect(silhouetteKind(null)).toBe("narrowbody");
  });

  it("every kind draws valid paths", () => {
    for (const k of ["widebody", "narrowbody", "regional", "bizjet", "turboprop", "piston", "helicopter", "glider", "balloon"] as const) {
      const parts = silhouette(k);
      expect(parts.length).toBeGreaterThan(2);
      for (const p of parts) expect(p.d).toMatch(/^M /);
    }
  });
});
