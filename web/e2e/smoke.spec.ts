import { expect, type Page, test } from "@playwright/test";

// Fully mocked: no upstream or CDN is touched, so this runs in CI. Values are real (N47345, 2026-10-14).
const HEX = "A5CF41";
const REG = {
  hex: HEX, n: "N47345", serial: "67619", mfr: "Boeing", model: "737 MAX 8", fmodel: "737-8", year: 2024, cat: "Fixed wing multi engine",
  eng_type: "Turbofan", engines: 2, seats: 175, engine_mfr: "CFM INTL", engine_model: "LEAP-1B28 SER", owner_kind: "corporation",
  owner_org: "UNITED AIRLINES INC", cert_issued: "2024-07-09", airworthy_since: "2024-07-02", status: "V", pct: 26, model_n: 582,
};
const HIST = {
  t: "B38M", last_seen: "2026-10-14",
  days: [{ d: "2026-10-14", airborne_mins: 723, max_alt: 40025, flights: [
    { dep: "KDEN", arr: "KLAS", t_off: 1791941340, t_on: 1791947100, mins: 96, incomplete: false, cs: "UAL655" },
    { dep: "KLAS", arr: "KEWR", t_off: 1791950580, t_on: 1791964560, mins: 233, incomplete: false, cs: "UAL1681" },
    { dep: "KBNA", arr: null, t_off: 1792014180, t_on: 1792018740, mins: 77, incomplete: true, cs: "UAL2201" },
  ] }],
};
const AIRPORTS = {
  KDEN: ["DEN", "Denver International Airport", "Denver", "US", 39.86, -104.67],
  KLAS: ["LAS", "Harry Reid International Airport", "Las Vegas", "US", 36.08, -115.15],
  KEWR: ["EWR", "Newark Liberty International Airport", "Newark", "US", 40.69, -74.17],
  KBNA: ["BNA", "Nashville International Airport", "Nashville", "US", 36.12, -86.68],
};
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mock(page: Page, opts: { blocked?: boolean } = {}) {
  await page.route("https://api.planespotters.net/**", (r) => r.fulfill(json({ photos: [] })));
  await page.route("https://tiles.openfreemap.org/**", (r) => r.abort());
  await page.route("**/data/**", (r) => {
    const u = new URL(r.request().url()).pathname;
    if (u === `/data/reg/hex/${HEX.slice(0, 3)}.json`) return r.fulfill(json({ [HEX]: REG }));
    if (u === `/data/hist/${HEX.slice(0, 4)}.json`) return r.fulfill(json({ [HEX]: opts.blocked ? { blocked: "2026-10-14" } : HIST }));
    if (u === "/data/ref/airports.json") return r.fulfill(json(AIRPORTS));
    return r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" }); // SPA fallback, like Pages
  });
  await page.route("**/api/**", (r) => {
    const u = new URL(r.request().url());
    const p = u.pathname;
    if (p === "/api/resolve") {
      const q = u.searchParams.get("q")!.toUpperCase();
      if (q === "N47345") return r.fulfill(json({ hex: HEX, reg: "N47345", callsign: null, type: null, matchedBy: "n_number", live: null, blocked: !!opts.blocked }));
      return r.fulfill(json({ error: { code: "not_found", message: "No aircraft is broadcasting DAL5123 right now. Delta flights can be operated by a regional or codeshare partner.", reason: "flight_not_live", hint: "Can't find it yet? Enter the tail number. It's painted on the plane's tail and usually on the engine cowling, and visible from the gate." } }, 404));
    }
    if (p === `/api/live/${HEX}`) return r.fulfill(json({ hex: HEX, live: null, blocked: !!opts.blocked, seen: false }));
    if (p === "/api/siblings") return r.fulfill(json({ ts: 1, types: { B738: 900, A320: 700 } }));
    if (p === "/api/siblings/B38M") return r.fulfill(json({ type: "B38M", airborne: 642, total: 700, ts: 1, source: "cron" }));
    if (p === "/api/siblings/B38M/trend") return r.fulfill(json({ type: "B38M", points: [[1, 600], [601, 620], [1201, 642]] }));
    return r.fulfill(json({ error: { code: "not_found", message: "nope" } }, 404));
  });
}

test("tail number lookup renders every section and the share card downloads", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.getByLabel("Flight number, tail number, or hex").fill("n47345");
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${HEX}$`));
  await expect(page.getByRole("heading", { name: "N47345" })).toBeVisible();
  await expect(page.getByText("Boeing 737 MAX 8").first()).toBeVisible();
  await expect(page.getByText("United Airlines Inc")).toBeVisible();
  await expect(page.getByText("Older than 26% of the 582 US-registered Boeing 737 MAX 8s.")).toBeVisible();
  await expect(page.getByText("Not transmitting right now.")).toBeVisible();
  await expect(page.getByText("642 Boeing 737 MAX 8s are flying right now.")).toBeVisible();
  await expect(page.getByText("Airports visited (4)")).toBeVisible();
  await expect(page.getByText("1 of 3 flights were only partly observed")).toBeVisible();
  await expect(page.getByText("For curiosity only.")).toBeVisible();
  // No horizontal scrolling at 360 px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Share card" }).click()]);
  expect(dl.suggestedFilename()).toBe("tailtale-N47345.png");
  const path = await dl.path();
  const fs = await import("node:fs");
  const buf = fs.readFileSync(path!);
  expect(buf.subarray(1, 4).toString()).toBe("PNG");
  expect(buf.readUInt32BE(16)).toBe(1080); // IHDR width
  expect(buf.readUInt32BE(20)).toBe(1350); // IHDR height
});

test("a flight that isn't broadcasting explains why and asks for the tail number", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.getByLabel("Flight number, tail number, or hex").fill("DL5123");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("regional or codeshare partner");
  await expect(page.getByRole("alert")).toContainText("painted on the plane's tail");
});

test("LADD/PIA aircraft show type-level information only", async ({ page }) => {
  await mock(page, { blocked: true });
  await page.goto(`/p/${HEX}`);
  await expect(page.getByText("opted out of public tracking")).toBeVisible();
  await expect(page.getByText("Vital stats")).toHaveCount(0);
  await expect(page.getByText("Its last 30 days")).toHaveCount(0);
  await expect(page.getByText("United Airlines Inc")).toHaveCount(0);
});

test("about and data quality pages load with the disclaimer", async ({ page }) => {
  await mock(page);
  await page.goto("/about");
  await expect(page.getByRole("heading", { name: "About TailTale" })).toBeVisible();
  await expect(page.getByText("ODbL 1.0").first()).toBeVisible();
  await page.goto("/quality");
  await expect(page.getByRole("heading", { name: "Data quality" })).toBeVisible();
  await expect(page.getByText("For curiosity only.")).toBeVisible();
});
