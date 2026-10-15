# Progress

## Phase 1: Probe and fixtures (done 2026-10-15)
- Probed every source in spec section 2 with real requests; raw responses in `pipeline/tests/fixtures/upstream/`.
- 12 real trace files from the 2026-10-14 prod release in `pipeline/tests/fixtures/traces/` (`ownOp` redacted).
- 1,000-row MASTER slice plus matching ACFTREF/ENGINE rows in `pipeline/tests/fixtures/faa/`, with all
  individual names and every address replaced by synthetic tokens.
- `docs/upstream_notes.md` documents the observed fields. Surprises vs. the spec:
  - `routeset` returned empty 201 on every try; `GET /api/0/route/{callsign}` (302 → JSON) works and is used as the fallback instead.
  - trace files carry an `ownOp` owner name; the parser never copies it.
  - history tar is uncompressed and split mid-member into `.aa`/`.ab`; must be streamed as one byte stream.
  - airplanes.live now refuses keyless API use (403), so ADSB.lol is the only live provider (behind an interface).
  - `/v2/callsign` accepts comma-separated lists (one request for mainline + regional partner callsigns).

## Phase 2: FAA pipeline (done 2026-10-15)
- `pipeline/faa_registry.py`: full registry (317,604 rows) → 224 hex shards, 6,476 N shards, `models.json`, in ~5 s.
- FAA model strings are collapsed to family names (`737-890` → `Boeing 737-800`, `A321-253NX` → `Airbus A321neo`,
  `ERJ 170-200 LR` → `Embraer E175`) so "this model" percentiles group all customer variants.
- Known tail check: N557AS → A7197D, 2006 Boeing 737-800 (737-890), 2× CFM56-7B27, Alaska Airlines (test).
- Privacy: address and co-owner columns are dropped and names blanked for non-organizations right after parsing;
  tests scan every output file for the synthetic private tokens.
- `pytest`: 27 passed. `ruff`: clean.

## Phase 3: History ETL (done locally 2026-10-15; GitHub Actions run pending repo push)
- `pipeline/history_etl.py` streams the day's prod release (`.tar.aa` + `.tar.ab`, 3.95 GB) through one
  Range-resuming HTTP stream into `tarfile` (`r|*`), parses traces in a process pool with backpressure,
  segments flights, merges 30-day shards, writes `stats/daily.json`, `ref/airports.json`, `quality/run.json`.
- Real day 2026-10-14 end to end on a laptop (4 workers): **147 s**, 167 MB peak RSS, nothing written to disk but outputs.
  67,631 traces, 33,891 US, 28,669 flew, 3,431 LADD/PIA blocked, 51.7 M points, 2,034 outliers dropped,
  82,309 flights; both airports matched 43%, incomplete 51% (all US civil incl. GA; median coverage gap 89 min).
  3,567 history shards (19 MB).
- Safety: a missing/unreachable live manifest aborts instead of wiping history; >10% shard fetch failures abort.
- Spot check (`pipeline/spot_check.py`, 10 random airliners, 29 completed flights):
  leg continuity **100%** (every arrival = next departure), matches adsbdb **or** ADSB.lol published route **52%**,
  adsbdb strict **7%**. The published callsign→route tables are stale for many flights (e.g. adsbdb lists
  DAL1887 as JFK→St Maarten; we saw RSW→ATL and ADSB.lol agrees with us on other legs), and airlines reuse flight
  numbers across multi-leg routes. Reported as-is on the Data Quality page rather than tuned to one source.
- `pytest`: 58 passed; `history_etl.py` coverage 95% (CI gate 80%).

## Phase 4: Worker (done locally 2026-10-15; Cloudflare deploy pending credentials)
- `worker/`: `/api/resolve`, `/api/live/{hex}`, `/api/siblings`, `/api/siblings/{type}`, `/api/siblings/{type}/trend`,
  `/api/route/{callsign}`, `/api/aircraft/{hex|reg}` (adsbdb, owner names never returned), `/api/health`.
- Live upstream verified with `wrangler dev`: `UA1711` → N38257 (B738, matched by flight number);
  `DL5123` → SkyWest `SKW5123` CRJ200 (`flight_number_partner`, one upstream request for 4 callsigns);
  `G-EUPT` → 4008B4 via adsbdb; route cache MISS then HIT; cron wrote A319/A320/A321 rows to local D1.
- **Cache API caveat found in Cloudflare docs:** `caches.default` is a no-op on `*.workers.dev` and works on Pages
  Functions (`*.pages.dev`). The same handler is therefore also mounted as a Pages Function at `/api/*`; the site
  calls that same-origin path. The `workers.dev` Worker serves the identical API and runs the cron.
- Free-plan CPU: type counts never `JSON.parse` the 650 KB bodies (streamed substring count, exact vs. parse in tests);
  the 40 tracked types are split over four cron triggers a minute apart (10 ms CPU each).
- ADSB.lol rate limits are tight (≈1 request / 2 s from one IP): one retry after 1.2 s, then a 15 s cooldown;
  cron spaces calls 2.5 s apart and stops the run on a second 429.
- D1 budget: ≈ 40 inserts + ≈ 40 deletes per 10 min, ×2–3 with indexes ≈ 30k rows written/day (cap 100k).
- `vitest`: 49 passed, including the regional-carrier not_found and partner-callsign cases. `tsc`: clean.

## Phase 5: Frontend (done locally 2026-10-15; live pages.dev check pending deploy)
- `web/`: Vite + React 19 + TypeScript. Pages: Home, Plane `/p/{hex}`, About & Data, Data Quality, 404.
  Plane page sections in spec order: hero (Planespotters photo called from the browser with visible credit + link,
  else an original silhouette), vital stats, age percentile, right now (+ lazy MapLibre/OpenFreeMap map),
  siblings + 7-day line, last 30 days (bar chart, stats, airports list + map, coverage note), share card.
- Every number shows its source on the card itself. Each chart has a hover/tap tooltip and a "Show as table" view.
  Light and dark themes (OS + toggle), skeleton states for every section, and the safety footer on every page.
- The age percentile is precomputed per record in the pipeline (`pct`, `model_n`), so the 2.3 MB `models.json`
  is never downloaded by the plane page.
- Bundle: initial JS **86.9 KB gzipped** (budget 200 KB). MapLibre (279 KB gz) is a separate chunk loaded only when
  a map scrolls into view, as the spec requires. MapLibre's worker is bundled explicitly (`?worker&url` + `setWorkerUrl`).
- Lighthouse mobile (local `vite preview`, real data): home **99** perf / 96 a11y; plane page **95** perf / 96 a11y,
  CLS 0.002. The one a11y miss (button contrast 4.41:1) was fixed afterwards (#256abf, ≈5.3:1).
- Verified at 360 px in light and dark (Playwright screenshots); no horizontal scroll (asserted in e2e).
- Tests: vitest 7 passed; Playwright smoke 4 passed (mocked, CI-safe), covering a full plane page,
  the share PNG downloading at exactly 1080×1350, the regional not_found hint, and a LADD aircraft showing type only.
- `wrangler pages dev`: the Pages Function `/api/*` resolves N47345 through the static N shard via `ASSETS`.

## Phase 6: Automation and deploy (built and tested locally; live run pending credentials)
- `.github/workflows/ci.yml` (ruff, pytest with history_etl coverage gate ≥ 80%, tsc, vitest, build, Playwright),
  `daily.yml` (cron 09:00 UTC + manual dispatch with `day`, `backfill`, `skip_etl`, `simulate_failure`; also
  redeploys on pushes touching web/ or worker/src/), `worker.yml` (D1 migrations + Worker deploy). actionlint: clean.
- "Keep yesterday's data": each run starts from the last deployed data (Actions cache, else `deploy_data.py mirror`
  of the live site per its manifest). ETL steps are `continue-on-error`; the site is always redeployed; the job is
  marked failed afterwards so failures are visible. The deploy refuses to publish without the registry.
- Local outage simulation (bad FAA URL + nonexistent history day): the FAA size guard rejected the 109 KB HTML
  response, all 224 registry shards and all history shards stayed byte-identical (10,275 files before and after),
  and `quality/latest.json` reported `missing` with `history_last_ok` = previous day.
- Pages limits check on a full build: 10,282 files, largest 2.4 MB.
- `scripts/setup-cloudflare.sh` creates the D1 database, the Pages project and the workers.dev subdomain, writes
  the IDs into both `wrangler.toml` files, applies migrations, deploys the Worker, and sets the GitHub secrets/vars.
- **Pending (needs credentials):** create the GitHub repo and push, run setup, the first `daily.yml` run on a GitHub
  runner (Phase 3 runner timing), and the phone check of the live URL.

## Phase 7: Polish and launch kit
- `notebooks/coverage_and_gaps.ipynb`, `notebooks/fleet_insights.ipynb` executed on real data (history 2026-10-14,
  FAA 2026-10-15); regenerate with `notebooks/build_notebooks.py`. Headlines feed the Data Quality page
  (`web/src/headlines.json`).
  - Airliners: 62% both airports matched, 38% partly observed (all US aircraft: 43% / 51%); 20% of partly observed
    flights are just midnight splits.
  - Route spot check, 25 airliners / 93 flights: continuity 100% over 68 legs; published tables agree with our
    departure 68% and arrival 72% of the time.
  - 757-200 is the oldest common type (median 32 years); 21% of airliners are registered to banks, trusts or lessors;
    Southwest 8.4 airborne h per aircraft per flying day; business jets opt out of tracking at 27% (piston 7%).
  - Corrected during review: an early draft said opt-outs were "overwhelmingly" business jets. By count, piston
    aircraft lead (1,262 vs 1,070); business jets lead by **rate**.
- README with screenshots + architecture diagram (`docs/architecture.svg`), ATTRIBUTION.md, MIT LICENSE (code),
  launch post drafts (`docs/launch_posts.md`).
- Privacy pass on committed fixtures: live positions/callsigns of LADD-flagged aircraft and the LADD trace were removed.
