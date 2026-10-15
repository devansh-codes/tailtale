import airlines from "./generated/airlines.json";
import { ApiError } from "./http";
import type { LiveProvider } from "./provider";
import type { LiveAircraft } from "./types";

export const NOT_FOUND_HINT =
  "Can't find it yet? Enter the tail number. It's painted on the plane's tail and usually on the engine cowling, and visible from the gate.";

type AirlineMap = Record<string, { icao: string; name: string; partners?: string[] }>;
const AIRLINES = airlines as AirlineMap;

export type MatchedBy = "hex" | "n_number" | "registration" | "flight_number" | "flight_number_partner" | "callsign";

export interface Resolved {
  hex: string;
  reg: string | null;
  callsign: string | null;
  type: string | null;
  matchedBy: MatchedBy;
  live: LiveAircraft | null;
  blocked: boolean;
}

export type Kind =
  | { kind: "hex"; hex: string }
  | { kind: "n_number"; reg: string }
  | { kind: "registration"; reg: string }
  | { kind: "flight_number"; iata: string; number: string; callsigns: string[]; airline: string | null }
  | { kind: "callsign"; callsign: string }
  | { kind: "invalid" };

// FAA N-numbers: N + 1-5 chars, first a digit 1-9, no I/O, at most two trailing letters.
const N_NUMBER = /^N[1-9](?:[0-9]{0,4}|[0-9]{0,3}[A-HJ-NP-Z]|[0-9]{0,2}[A-HJ-NP-Z]{2})$/;
const HEX = /^[0-9A-F]{6}$/;
const DASH_REG = /^[A-Z0-9]{1,2}-[A-Z0-9]{2,5}$/;
const FLIGHT = /^([A-Z][A-Z0-9]|[0-9][A-Z])([0-9]{1,4})$/;
const CALLSIGN = /^[A-Z]{3}[0-9]{1,4}[A-Z]{0,2}$/;

/** Normalize (trim, uppercase, drop spaces/dashes) and classify. Dashed registrations are detected first. */
export function classify(input: string): Kind[] {
  const raw = input.trim().toUpperCase().replace(/\s+/g, "");
  const q = raw.replace(/-/g, "");
  if (!q || q.length > 10 || !/^[A-Z0-9]+$/.test(q)) return [{ kind: "invalid" }];
  const kinds: Kind[] = [];
  if (HEX.test(q)) kinds.push({ kind: "hex", hex: q });
  if (N_NUMBER.test(q)) kinds.push({ kind: "n_number", reg: q });
  if (DASH_REG.test(raw) && !raw.startsWith("N")) kinds.push({ kind: "registration", reg: raw });
  const fm = FLIGHT.exec(q);
  if (fm && !N_NUMBER.test(q)) {
    const [, iata, numRaw] = fm;
    const number = String(Number(numRaw));
    const a = AIRLINES[iata];
    const callsigns = a ? [a.icao, ...(a.partners ?? [])].map((c) => c + number) : [];
    kinds.push({ kind: "flight_number", iata, number, callsigns, airline: a?.name ?? null });
  }
  if (CALLSIGN.test(q)) kinds.push({ kind: "callsign", callsign: q });
  return kinds.length ? kinds : [{ kind: "invalid" }];
}

export interface ResolveDeps {
  provider: LiveProvider;
  /** Fetch a static data file (path relative to /data/), returning null on 404. */
  staticText(path: string): Promise<string | null>;
  /** Optional adsbdb lookup for foreign registrations: returns hex or null. */
  adsbdbHex?(reg: string): Promise<{ hex: string; reg: string | null; type: string | null } | null>;
}

function fromLive(live: LiveAircraft, matchedBy: MatchedBy): Resolved {
  return {
    hex: live.hex,
    reg: live.reg,
    callsign: live.callsign,
    type: live.type,
    matchedBy,
    live: live.blocked ? null : live,
    blocked: live.blocked,
  };
}

async function registryHasHex(deps: ResolveDeps, hex: string): Promise<boolean> {
  // Avoid JSON.parse of a ~500 KB shard (CPU budget): a quoted-key substring test is exact enough.
  const t = await deps.staticText(`reg/hex/${hex.slice(0, 3)}.json`);
  return !!t && t.includes(`"${hex}":{`);
}

export async function resolve(input: string, deps: ResolveDeps): Promise<Resolved> {
  const kinds = classify(input);
  if (kinds[0].kind === "invalid") {
    throw new ApiError(400, "bad_query", "Type a flight number (DL1234), a tail number (N123AB) or a 6-character hex code.");
  }
  let flightMiss: Extract<Kind, { kind: "flight_number" }> | null = null;

  for (const k of kinds) {
    switch (k.kind) {
      case "hex": {
        const live = await deps.provider.byHex(k.hex);
        if (live) return fromLive(live, "hex");
        if (await registryHasHex(deps, k.hex)) {
          return { hex: k.hex, reg: null, callsign: null, type: null, matchedBy: "hex", live: null, blocked: false };
        }
        break;
      }
      case "n_number": {
        const shard = await deps.staticText(`reg/n/${k.reg.slice(1, 4)}.json`);
        const hex = shard ? ((JSON.parse(shard) as Record<string, string>)[k.reg] ?? null) : null;
        if (hex) {
          const live = await deps.provider.byHex(hex);
          if (live) return { ...fromLive(live, "n_number"), reg: k.reg };
          return { hex, reg: k.reg, callsign: null, type: null, matchedBy: "n_number", live: null, blocked: false };
        }
        const live = await deps.provider.byReg(k.reg);
        if (live) return fromLive(live, "n_number");
        break;
      }
      case "registration": {
        const live = await deps.provider.byReg(k.reg);
        if (live) return fromLive(live, "registration");
        const db = deps.adsbdbHex ? await deps.adsbdbHex(k.reg) : null;
        if (db) return { hex: db.hex, reg: db.reg ?? k.reg, callsign: null, type: db.type, matchedBy: "registration", live: null, blocked: false };
        break;
      }
      case "flight_number": {
        if (!k.callsigns.length) {
          flightMiss = k;
          break;
        }
        // One upstream request covers the mainline callsign and its regional partners.
        const found = await deps.provider.byCallsigns(k.callsigns);
        const main = found.find((a) => a.callsign === k.callsigns[0]);
        if (main) return fromLive(main, "flight_number");
        const partner = k.callsigns.slice(1).map((cs) => found.find((a) => a.callsign === cs)).find(Boolean);
        if (partner) return fromLive(partner, "flight_number_partner");
        flightMiss = k;
        break;
      }
      case "callsign": {
        const found = await deps.provider.byCallsigns([k.callsign]);
        if (found[0]) return fromLive(found[0], "callsign");
        break;
      }
    }
  }

  if (flightMiss) {
    const who = flightMiss.airline ?? flightMiss.iata;
    const reason = flightMiss.callsigns.length
      ? `No aircraft is broadcasting ${flightMiss.callsigns[0]} right now. ${who} flights can be operated by a regional or codeshare partner under a different callsign, and planes at the gate before pushback often aren't transmitting yet.`
      : `We don't recognise the airline code ${flightMiss.iata}.`;
    throw new ApiError(404, "not_found", reason, { reason: "flight_not_live", hint: NOT_FOUND_HINT });
  }
  const k = kinds[0];
  const what = k.kind === "hex" ? "that hex code" : k.kind === "callsign" ? "that callsign" : "that tail number";
  throw new ApiError(404, "not_found", `We couldn't find ${what} in the FAA registry or in live data.`, {
    reason: k.kind === "callsign" ? "callsign_not_live" : "unknown_aircraft",
    hint: NOT_FOUND_HINT,
  });
}
