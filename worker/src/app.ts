import { lookupAircraft, lookupRoute } from "./enrich";
import { ApiError, cached, errorResponse, json, userAgent, withCors } from "./http";
import { AdsbLolProvider, type LiveProvider } from "./provider";
import { resolve } from "./resolve";
import { allSiblings, lastCron, normalizeType, runCron, siblings, trend } from "./siblings";
import type { Ctx, Env } from "./types";

export interface Deps {
  provider: LiveProvider;
  fetcher: typeof fetch;
}

export function defaultDeps(env: Env): Deps {
  return { provider: new AdsbLolProvider(userAgent(env)), fetcher: (...a) => fetch(...a) };
}

const HEX = /^[0-9A-Fa-f]{6}$/;
const CALLSIGN = /^[A-Za-z0-9]{2,8}$/;

async function staticText(env: Env, fetcher: typeof fetch, path: string): Promise<string | null> {
  let res: Response;
  if (env.ASSETS) {
    res = await env.ASSETS.fetch(new Request(`https://assets.local/data/${path}`));
  } else {
    if (!env.PAGES_ORIGIN) return null;
    res = await fetcher(`${env.PAGES_ORIGIN.replace(/\/$/, "")}/data/${path}`, { cf: { cacheTtl: 3600 } } as RequestInit);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(502, "static_unavailable", "Could not read the aircraft registry. Try again shortly.");
  const ct = res.headers.get("content-type") ?? "";
  // Pages serves index.html for unknown paths (SPA fallback); treat that as "not found".
  if (ct.includes("text/html")) return null;
  return res.text();
}

export async function route(req: Request, env: Env, ctx: Ctx, deps: Deps = defaultDeps(env)): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean); // ["api", ...]
  if (parts[0] !== "api") throw new ApiError(404, "no_route", "Unknown endpoint.");
  const ua = userAgent(env);
  const [, a, b, c] = parts;

  if (a === "resolve" && !b) {
    const q = (url.searchParams.get("q") ?? "").slice(0, 32);
    const key = `resolve/${encodeURIComponent(q.trim().toUpperCase().replace(/[\s-]+/g, ""))}`;
    return cached(ctx, key, 15, async () => {
      const r = await resolve(q, {
        provider: deps.provider,
        staticText: (p) => staticText(env, deps.fetcher, p),
        adsbdbHex: async (reg) => {
          const info = await lookupAircraft(reg, ua, deps.fetcher);
          return info?.hex ? { hex: info.hex, reg: info.reg, type: info.icaoType } : null;
        },
      });
      return json(r, 200, 15);
    });
  }

  if (a === "live" && b && !c) {
    if (!HEX.test(b)) throw new ApiError(400, "bad_hex", "A hex code is 6 characters, 0-9 and A-F.");
    const hex = b.toUpperCase();
    return cached(ctx, `live/${hex}`, 15, async () => {
      const live = await deps.provider.byHex(hex);
      return json({ hex, live: live && !live.blocked ? live : null, blocked: !!live?.blocked, seen: !!live }, 200, 15);
    });
  }

  if (a === "siblings" && !b) {
    return cached(ctx, "siblings/all", 60, async () => json(await allSiblings(env), 200, 60));
  }
  if (a === "siblings" && b && !c) {
    const type = normalizeType(b);
    return cached(ctx, `siblings/${type}`, 60, async () => json(await siblings(env, deps.provider, type), 200, 60));
  }
  if (a === "siblings" && b && c === "trend") {
    const type = normalizeType(b);
    return cached(ctx, `trend/${type}`, 600, async () => json(await trend(env, type), 200, 600));
  }

  if (a === "route" && b && !c) {
    if (!CALLSIGN.test(b)) throw new ApiError(400, "bad_callsign", "Callsigns are 2 to 8 letters or digits.");
    const cs = b.toUpperCase();
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    const pos = url.searchParams.has("lat") && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    return cached(ctx, `route/${cs}`, 86400, async () => {
      const r = await lookupRoute(cs, ua, pos, deps.fetcher);
      if (!r) throw new ApiError(404, "no_route", `No published route for ${cs}.`);
      return json(r, 200, 86400);
    });
  }

  if (a === "aircraft" && b && !c) {
    const q = b.toUpperCase();
    if (!/^[A-Z0-9-]{2,10}$/.test(q)) throw new ApiError(400, "bad_query", "Use a hex code or a registration.");
    return cached(ctx, `aircraft/${q}`, 7 * 86400, async () => {
      const info = await lookupAircraft(q, ua, deps.fetcher);
      if (!info) throw new ApiError(404, "not_found", "adsbdb has no record of that aircraft.");
      return json(info, 200, 7 * 86400);
    });
  }

  if (a === "health" && !b) {
    const t0 = Date.now();
    const probe = async (u: string) => {
      try {
        const r = await deps.fetcher(u, { headers: { "user-agent": ua }, signal: AbortSignal.timeout(5000) });
        return { ok: r.status < 500, status: r.status, ms: Date.now() - t0 };
      } catch {
        return { ok: false, status: 0, ms: Date.now() - t0 };
      }
    };
    const [adsblol, adsbdb, cron] = await Promise.all([
      probe("https://api.adsb.lol/v2/hex/000000"),
      probe("https://api.adsbdb.com/v0/callsign/UAL1"),
      lastCron(env).catch(() => null),
    ]);
    return json({ ok: adsblol.ok && adsbdb.ok, upstreams: { "adsb.lol": adsblol, adsbdb }, lastCron: cron, provider: deps.provider.name });
  }

  throw new ApiError(404, "no_route", "Unknown endpoint.");
}

export async function handleRequest(req: Request, env: Env, ctx: Ctx, deps?: Deps): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), env, origin);
  if (req.method !== "GET") {
    return withCors(errorResponse(new ApiError(405, "method_not_allowed", "Only GET is supported.")), env, origin);
  }
  let res: Response;
  try {
    res = await route(req, env, ctx, deps);
  } catch (e) {
    res =
      e instanceof ApiError
        ? errorResponse(e)
        : errorResponse(new ApiError(500, "internal", "Something went wrong on our side. Please try again."));
    if (!(e instanceof ApiError)) console.error(e);
  }
  return withCors(res, env, origin);
}

export async function handleScheduled(
  cron: string,
  env: Env,
  deps?: Deps,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  // The cron is not latency-sensitive: wait longer before its single retry on a 429.
  const d = deps ?? { provider: new AdsbLolProvider(userAgent(env), undefined, undefined, 1, 5000), fetcher: fetch };
  await runCron(env, d.provider, cron, opts);
}
