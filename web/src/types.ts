/** Mirrors pipeline/SCHEMA.md. */
export interface RegRecord {
  hex: string;
  n: string;
  serial?: string;
  mfr?: string;
  model?: string;
  fmodel?: string;
  code?: string;
  year?: number;
  cat?: string;
  eng_type?: string;
  engines?: number;
  seats?: number;
  engine_mfr?: string;
  engine_model?: string;
  owner_kind?: string;
  owner_org?: string;
  cert_issued?: string;
  airworthy_since?: string;
  status?: string;
  pct?: number;
  model_n?: number;
}

export interface Flight {
  dep: string | null;
  arr: string | null;
  t_off: number;
  t_on: number;
  mins: number;
  incomplete: boolean;
  cs?: string;
}

export interface HistDay {
  d: string;
  flights: Flight[];
  airborne_mins: number;
  max_alt: number;
}

export interface HistEntry {
  t?: string;
  last_seen?: string;
  days?: HistDay[];
  blocked?: string;
}

/** [iata, name, city, country, lat, lon] */
export type AirportRef = [string | null, string, string | null, string, number, number];

export interface LiveAircraft {
  hex: string;
  reg: string | null;
  type: string | null;
  callsign: string | null;
  onGround: boolean;
  alt: number | null;
  gs: number | null;
  track: number | null;
  vrate: number | null;
  lat: number | null;
  lon: number | null;
  posAge: number | null;
  seen: number | null;
  category: string | null;
  source: string | null;
  blocked: boolean;
}

export interface LiveResponse {
  hex: string;
  live: LiveAircraft | null;
  blocked: boolean;
  seen: boolean;
}

export interface Resolved {
  hex: string;
  reg: string | null;
  callsign: string | null;
  type: string | null;
  matchedBy: "hex" | "n_number" | "registration" | "flight_number" | "flight_number_partner" | "callsign";
  live: LiveAircraft | null;
  blocked: boolean;
}

export interface Airport {
  icao: string | null;
  iata: string | null;
  name: string | null;
  city: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
}

export interface Route {
  callsign: string;
  airline: { name: string | null; icao: string | null; iata: string | null } | null;
  origin: Airport | null;
  destination: Airport | null;
  source: string;
}

export interface Siblings {
  type: string;
  airborne: number;
  total: number | null;
  ts: number;
  source: "cron" | "live";
}

export interface AircraftInfo {
  hex: string | null;
  reg: string | null;
  icaoType: string | null;
  type: string | null;
  manufacturer: string | null;
  country: string | null;
  operatorCode: string | null;
}

export interface Photo {
  id: string;
  thumbnail_large?: { src: string; size: { width: number; height: number } };
  thumbnail: { src: string; size: { width: number; height: number } };
  link: string;
  photographer: string;
}
