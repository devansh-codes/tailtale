import type { RegRecord } from "./types";

/** Hand-drawn side views (nose right) in a 240x100 box. Original shapes; no liveries or logos. */
export type SilKind = "widebody" | "narrowbody" | "regional" | "bizjet" | "turboprop" | "piston" | "helicopter" | "glider" | "balloon";

export interface SilPart {
  d: string;
  /** 1 = body ink; 0 = window cut-outs drawn in the background colour. */
  ink: 0 | 1;
}

const rr = (x: number, y: number, w: number, h: number) => {
  const r = h / 2;
  return `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} L ${x + r} ${y + h} Q ${x} ${y + h} ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
};

function jet(r: number, x0: number, x1: number, engines: "wing" | "tail", tTail = false, engW = 30): SilPart[] {
  const cy = 52;
  const top = cy - r;
  const bot = cy + r;
  const parts: SilPart[] = [
    {
      ink: 1,
      d: `M ${x0} ${cy - r * 0.5} L ${x0 + 14} ${top} L ${x1 - r * 2.4} ${top} Q ${x1 + 2} ${top} ${x1 + 6} ${cy} Q ${x1 + 2} ${bot} ${x1 - r * 2.4} ${bot} L ${x0 + 36} ${bot} Q ${x0 + 14} ${bot - 1} ${x0} ${cy - r * 0.5} Z`,
    },
    // swept fin
    tTail
      ? { ink: 1, d: `M ${x0 + 8} ${top + 1} L ${x0 + 2} ${top - 30} L ${x0 + 12} ${top - 30} L ${x0 + 34} ${top + 1} Z` }
      : { ink: 1, d: `M ${x0 + 8} ${top + 1} L ${x0 - 4} ${top - 28 - r} L ${x0 + 9} ${top - 28 - r} L ${x0 + 40} ${top + 1} Z` },
    // tailplane
    tTail
      ? { ink: 1, d: `M ${x0 - 8} ${top - 32} L ${x0 + 24} ${top - 31} L ${x0 + 22} ${top - 27} L ${x0 + 2} ${top - 28} Z` }
      : { ink: 1, d: `M ${x0 + 2} ${cy - 2} L ${x0 - 12} ${cy + 3} L ${x0 - 2} ${cy + 4} L ${x0 + 30} ${cy + 1} Z` },
    // wing root
    { ink: 1, d: `M ${x0 + (x1 - x0) * 0.46} ${bot - 3} L ${x0 + (x1 - x0) * 0.36} ${bot + 12} L ${x0 + (x1 - x0) * 0.42} ${bot + 12} L ${x0 + (x1 - x0) * 0.6} ${bot - 2} Z` },
    // cockpit + cabin windows
    { ink: 0, d: `M ${x1 - r * 1.6} ${top + 3} L ${x1 - 3} ${top + 3} L ${x1 + 1} ${top + 7} L ${x1 - r * 1.6} ${top + 7} Z` },
  ];
  if (engines === "wing") {
    const ex = x0 + (x1 - x0) * 0.36;
    parts.push({ ink: 1, d: rr(ex, bot + 2, engW, r * 1.25) });
  } else {
    parts.push({ ink: 1, d: rr(x0 + 26, top - r * 0.9, engW * 0.8, r * 1.1) });
  }
  const step = 9;
  let windows = "";
  for (let x = x0 + 46; x < x1 - r * 3; x += step) windows += `M ${x} ${top + 4} h 4 v 4 h -4 Z `;
  parts.push({ ink: 0, d: windows });
  return parts;
}

function turboprop(): SilPart[] {
  const cy = 54;
  return [
    { ink: 1, d: `M 24 50 L 38 46 L 196 46 Q 214 46 218 54 Q 214 62 196 62 L 62 62 Q 40 61 24 50 Z` },
    { ink: 1, d: `M 32 47 L 22 12 L 34 12 L 60 47 Z` },
    { ink: 1, d: `M 16 14 L 46 14 L 44 18 L 20 18 Z` },
    { ink: 1, d: `M 96 46 L 146 42 L 150 46 Z` }, // high wing
    { ink: 1, d: rr(116, 36, 36, 12) }, // nacelle on the wing
    { ink: 1, d: `M 154 24 L 157 24 L 157 60 L 154 60 Z` }, // propeller disc edge
    { ink: 0, d: `M 202 49 L 212 49 L 215 53 L 202 53 Z` },
    {
      ink: 0,
      d: Array.from({ length: 13 }, (_, i) => `M ${66 + i * 10} ${cy - 5} h 4 v 4 h -4 Z`).join(" "),
    },
  ];
}

function piston(): SilPart[] {
  return [
    { ink: 1, d: `M 50 50 L 66 44 L 168 42 Q 186 42 190 52 Q 186 60 170 61 L 98 62 Q 70 60 50 50 Z` },
    { ink: 1, d: `M 56 47 L 46 20 L 58 20 L 84 46 Z` },
    { ink: 1, d: `M 40 50 L 74 49 L 72 53 L 44 53 Z` },
    { ink: 1, d: `M 110 60 L 156 58 L 158 63 L 112 66 Z` }, // low wing
    { ink: 1, d: `M 192 30 L 196 30 L 196 74 L 192 74 Z` }, // prop
    { ink: 1, d: `M 120 61 L 118 78 L 122 78 Z M 168 60 L 170 76 L 173 76 Z` }, // gear legs
    { ink: 1, d: rr(112, 76, 14, 7) + rr(164, 74, 12, 7) },
    { ink: 0, d: `M 132 45 L 160 44 L 164 51 L 134 52 Z` },
  ];
}

function helicopter(): SilPart[] {
  return [
    { ink: 1, d: `M 120 40 Q 172 32 188 52 Q 192 66 168 70 L 126 70 Q 108 68 106 56 Q 106 44 120 40 Z` },
    { ink: 1, d: `M 108 52 L 30 50 L 30 56 L 108 60 Z` }, // boom
    { ink: 1, d: `M 24 36 L 34 36 L 38 56 L 28 58 Z` }, // tail fin
    { ink: 1, d: `M 18 46 a 12 12 0 1 0 0.1 0 Z` }, // tail rotor
    { ink: 1, d: `M 144 34 L 150 34 L 150 26 L 144 26 Z` }, // mast
    { ink: 1, d: `M 60 24 L 236 24 L 236 28 L 60 28 Z` }, // main rotor
    { ink: 1, d: `M 116 70 L 112 80 L 116 80 L 120 70 Z M 168 70 L 172 80 L 176 80 L 172 70 Z` },
    { ink: 1, d: `M 98 80 L 188 80 Q 194 80 196 76 L 198 76 Q 196 84 188 84 L 98 84 Z` },
    { ink: 0, d: `M 160 42 Q 180 44 184 56 L 162 56 Z` },
  ];
}

function glider(): SilPart[] {
  return [
    { ink: 1, d: `M 30 50 L 150 46 Q 196 44 214 52 Q 196 58 150 58 L 36 54 Z` },
    { ink: 1, d: `M 32 51 L 24 20 L 34 20 L 52 50 Z` },
    { ink: 1, d: `M 14 20 L 46 20 L 44 23 L 16 23 Z` },
    { ink: 1, d: `M 40 47 L 236 44 L 236 47 L 40 50 Z` }, // long wing seen edge-on
    { ink: 0, d: `M 168 47 Q 186 45 196 51 L 170 51 Z` },
  ];
}

function balloon(): SilPart[] {
  return [
    { ink: 1, d: `M 120 8 C 160 8 168 44 150 62 L 134 78 L 106 78 L 90 62 C 72 44 80 8 120 8 Z` },
    { ink: 1, d: `M 108 78 L 110 86 L 112 86 L 110 78 Z M 130 78 L 128 86 L 130 86 L 132 78 Z` },
    { ink: 1, d: rr(106, 86, 28, 12) },
    { ink: 0, d: `M 118 12 C 112 30 112 56 118 76 L 122 76 C 128 56 128 30 122 12 Z` },
  ];
}

export function silhouette(kind: SilKind): SilPart[] {
  switch (kind) {
    case "widebody":
      return jet(11, 22, 222, "wing", false, 38);
    case "narrowbody":
      return jet(8.5, 26, 216, "wing", false, 30);
    case "regional":
      return jet(7, 34, 206, "wing", false, 24);
    case "bizjet":
      return jet(6.5, 46, 196, "tail", true, 26);
    case "turboprop":
      return turboprop();
    case "piston":
      return piston();
    case "helicopter":
      return helicopter();
    case "glider":
      return glider();
    case "balloon":
      return balloon();
  }
}

const WIDE = /^(A3[3-5]|A38|B74|B76|B77|B78|MD11|DC10|IL96|A30|A31[0])/;
const REGIONAL = /^(E1[3-9]|E[27]5|E290|E295|CRJ|CL6|E170|BCS1|A22)/;

/** Picks a silhouette from FAA registry facts, falling back to the ADS-B emitter category / ICAO type. */
export function silhouetteKind(reg: RegRecord | null, liveCategory?: string | null, icaoType?: string | null): SilKind {
  const t = (icaoType ?? "").toUpperCase();
  const cat = reg?.cat ?? "";
  const eng = reg?.eng_type ?? "";
  if (cat === "Balloon" || cat === "Blimp/Dirigible") return "balloon";
  if (cat === "Glider") return "glider";
  if (cat === "Rotorcraft" || cat === "Gyroplane" || liveCategory === "A7") return "helicopter";
  if (t && WIDE.test(t)) return "widebody";
  if (eng === "Turbofan" || eng === "Turbojet") {
    const seats = reg?.seats ?? 0;
    if (seats >= 240 || liveCategory === "A5") return "widebody";
    if (seats >= 120) return "narrowbody";
    if (seats >= 50 || REGIONAL.test(t)) return "regional";
    return "bizjet";
  }
  if (eng === "Turboprop" || eng === "Turboshaft") return "turboprop";
  if (eng) return "piston";
  switch (liveCategory) {
    case "A5":
      return "widebody";
    case "A3":
    case "A4":
      return REGIONAL.test(t) ? "regional" : "narrowbody";
    case "A2":
      return REGIONAL.test(t) ? "regional" : "bizjet";
    case "A1":
      return "piston";
    case "B1":
      return "glider";
    case "B2":
      return "balloon";
  }
  return "narrowbody";
}
