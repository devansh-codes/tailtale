import { silhouette, type SilKind } from "./silhouette";

export interface CardData {
  reg: string;
  type: string;
  age: string;
  flights30: string;
  airports: string;
  siblings: string;
  siblingsLabel: string;
  kind: SilKind;
  url: string;
}

const SERIF = `"EB Garamond", Georgia, serif`;
const SANS = `Figtree, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

export const CARD_W = 1080;
export const CARD_H = 1350;

/**
 * "Plane Wrapped": 1080x1350, drawn on canvas. Uses our own silhouette, never the Planespotters photo
 * (their terms cover display with credit and link, not redistribution).
 */
export function drawCard(canvas: HTMLCanvasElement, d: CardData): void {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const c = canvas.getContext("2d");
  if (!c) return;
  const font = (w: number, px: number) => `${w} ${px}px ${SANS}`;
  const serif = (w: number, px: number, italic = false) => `${italic ? "italic " : ""}${w} ${px}px ${SERIF}`;

  c.fillStyle = "#034f46";
  c.fillRect(0, 0, CARD_W, CARD_H);

  // subtle contrail arcs
  c.strokeStyle = "rgba(255,255,235,0.07)";
  c.lineWidth = 3;
  for (let i = 0; i < 5; i++) {
    c.beginPath();
    c.arc(CARD_W * 0.9, CARD_H * 1.05, 520 + i * 90, Math.PI * 1.05, Math.PI * 1.5);
    c.stroke();
  }

  c.fillStyle = "#f0d7ff";
  c.font = font(600, 32);
  c.letterSpacing = "6px";
  c.fillText("TAILTALE · PLANE WRAPPED", 80, 120);
  c.letterSpacing = "0px";

  c.fillStyle = "#ffffeb";
  fitText(c, d.reg, 80, 285, CARD_W - 160, 168, serif(500, 168));
  c.fillStyle = "rgba(255,255,235,0.85)";
  fitText(c, d.type, 80, 365, CARD_W - 160, 60, serif(400, 60, true));

  // silhouette
  c.save();
  c.translate(110, 400);
  const s = (CARD_W - 220) / 240;
  c.scale(s, s);
  for (const p of silhouette(d.kind)) {
    c.fillStyle = p.ink ? "#ffffeb" : "#034f46";
    c.globalAlpha = p.ink ? 0.95 : 1;
    c.fill(new Path2D(p.d));
  }
  c.restore();
  c.globalAlpha = 1;

  const tiles: [string, string][] = [
    [d.age, "years old"],
    [d.flights30, "flights in the last 30 days"],
    [d.airports, "airports visited"],
    [d.siblings, d.siblingsLabel],
  ];
  const top = 820;
  const tw = (CARD_W - 160 - 40) / 2;
  const th = 190;
  tiles.forEach(([v, l], i) => {
    const x = 80 + (i % 2) * (tw + 40);
    const y = top + Math.floor(i / 2) * (th + 30);
    c.fillStyle = "rgba(255,255,235,0.08)";
    roundRect(c, x, y, tw, th, 28);
    c.fill();
    c.strokeStyle = "rgba(255,255,235,0.18)";
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = "#ffffeb";
    fitText(c, v, x + 32, y + 104, tw - 64, 92, serif(500, 92));
    c.fillStyle = "rgba(255,255,235,0.78)";
    c.font = font(500, 30);
    wrapText(c, l, x + 32, y + 148, tw - 64, 34);
  });

  c.fillStyle = "#f0d7ff";
  c.font = font(600, 30);
  c.fillText(d.url, 80, CARD_H - 70);
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** Shrinks the font size (keeping family/weight/style from `fontSpec`) until the text fits. */
function fitText(c: CanvasRenderingContext2D, t: string, x: number, y: number, max: number, px: number, fontSpec: string) {
  let size = px;
  const at = (n: number) => fontSpec.replace(`${px}px`, `${n}px`);
  c.font = at(size);
  while (c.measureText(t).width > max && size > 18) {
    size -= 4;
    c.font = at(size);
  }
  c.fillText(t, x, y);
}

function wrapText(c: CanvasRenderingContext2D, t: string, x: number, y: number, max: number, lh: number) {
  const words = t.split(" ");
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (c.measureText(test).width > max && line) {
      c.fillText(line, x, y);
      line = w;
      y += lh;
    } else line = test;
  }
  if (line) c.fillText(line, x, y);
}

export async function shareOrDownload(canvas: HTMLCanvasElement, filename: string, title: string, url: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("Could not render the image.");
  const file = new File([blob], filename, { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title, url });
      return "shared";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "cancelled";
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return "downloaded";
}
