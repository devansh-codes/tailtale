import type { HistEntry, RegRecord } from "./types";

const SMALL = new Set(["of", "and", "the", "de", "for"]);
const KEEP_UPPER = new Set(["LLC", "LP", "NA", "USA", "US", "UPS", "FAA", "DBA", "II", "III", "AG", "SA", "NV", "BV"]);

/** "ALASKA AIRLINES INC" -> "Alaska Airlines Inc"; keeps legal suffixes upper-case. */
export function prettyName(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => {
      const up = w.toUpperCase();
      if (KEEP_UPPER.has(up.replace(/[.,]/g, ""))) return up;
      if (i > 0 && SMALL.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

export const fmtInt = (n: number): string => n.toLocaleString("en-US");

export function age(year: number | undefined, now = new Date()): number | null {
  if (!year) return null;
  return Math.max(0, now.getUTCFullYear() - year);
}

export function fmtDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtDay(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtMins(m: number): string {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h ? `${h} h ${mm.toString().padStart(2, "0")} min` : `${mm} min`;
}

export function fmtTimeUtc(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(11, 16) + " UTC";
}

export function pluralModel(name: string, n: number): string {
  if (n === 1) return name;
  return /s$/i.test(name) ? name : name + "s";
}

export function typeName(reg: RegRecord | null): string | null {
  if (!reg?.mfr || !reg.model || reg.model === "Unknown") return null;
  return `${reg.mfr} ${reg.model}`;
}

export interface HistSummary {
  days: { d: string; flights: number; mins: number; incomplete: number }[];
  flights: number;
  hours: number;
  longest: { mins: number; dep: string | null; arr: string | null; d: string } | null;
  busiest: { d: string; flights: number } | null;
  airports: { code: string; visits: number }[];
  incomplete: number;
}

/** Last-30-days roll-up for the plane page and the share card. Zero-flight days are filled in. */
export function summarize(h: HistEntry | null, today = new Date()): HistSummary {
  const byDay = new Map((h?.days ?? []).map((d) => [d.d, d]));
  const days: HistSummary["days"] = [];
  const end = h?.days?.length ? new Date(h.days[h.days.length - 1].d + "T00:00:00Z") : today;
  const last = new Date(Math.max(end.getTime(), today.getTime() - 86400000));
  for (let i = 29; i >= 0; i--) {
    const d = new Date(last.getTime() - i * 86400000).toISOString().slice(0, 10);
    const e = byDay.get(d);
    days.push({
      d,
      flights: e?.flights.length ?? 0,
      mins: e?.airborne_mins ?? 0,
      incomplete: e?.flights.filter((f) => f.incomplete).length ?? 0,
    });
  }
  const visits = new Map<string, number>();
  let longest: HistSummary["longest"] = null;
  let busiest: HistSummary["busiest"] = null;
  let flights = 0;
  let mins = 0;
  let incomplete = 0;
  for (const d of h?.days ?? []) {
    flights += d.flights.length;
    mins += d.airborne_mins;
    if (!busiest || d.flights.length > busiest.flights) busiest = { d: d.d, flights: d.flights.length };
    for (const f of d.flights) {
      if (f.incomplete) incomplete++;
      if (!f.incomplete && (!longest || f.mins > longest.mins)) longest = { mins: f.mins, dep: f.dep, arr: f.arr, d: d.d };
      for (const c of [f.dep, f.arr]) if (c) visits.set(c, (visits.get(c) ?? 0) + 1);
    }
  }
  return {
    days,
    flights,
    hours: mins / 60,
    longest,
    busiest,
    airports: [...visits.entries()].map(([code, v]) => ({ code, visits: v })).sort((a, b) => b.visits - a.visits || a.code.localeCompare(b.code)),
    incomplete,
  };
}

export function ownerLabel(r: RegRecord): string {
  if (r.owner_org) return prettyName(r.owner_org);
  switch (r.owner_kind) {
    case "individual":
    case "co-owned":
    case "non-citizen co-owned":
    case "partnership":
      return "Private owner (not shown)";
    default:
      return "Not listed";
  }
}
