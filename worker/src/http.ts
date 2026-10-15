import type { Ctx, Env } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function userAgent(env: Env): string {
  return `TailTale/1.0 (+${env.REPO_URL ?? "https://github.com/devansh-codes/tailtale"})`;
}

export function json(body: unknown, status = 200, maxAge = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

export function errorResponse(e: ApiError): Response {
  return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status, e.status === 404 ? 60 : 0);
}

export function allowedOrigin(env: Env, origin: string | null): string | null {
  if (!origin) return null;
  const pages = env.PAGES_ORIGIN?.replace(/\/$/, "");
  if (pages && origin === pages) return origin;
  // Preview deployments: https://<hash>.<project>.pages.dev
  if (pages) {
    const host = new URL(pages).host;
    if (origin.startsWith("https://") && origin.endsWith("." + host)) return origin;
  }
  const extra = (env.EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin) ? origin : null;
}

export function withCors(res: Response, env: Env, origin: string | null): Response {
  const allowed = allowedOrigin(env, origin);
  if (!allowed) return res;
  const r = new Response(res.body, res);
  r.headers.set("access-control-allow-origin", allowed);
  r.headers.set("access-control-allow-methods", "GET, OPTIONS");
  r.headers.set("access-control-max-age", "86400");
  r.headers.append("vary", "Origin");
  return r;
}

/**
 * Cache a JSON-producing computation in caches.default under a synthetic key.
 * Only successful (2xx) and 404 responses are stored, so upstream failures are retried.
 * On *.workers.dev the Cache API is a no-op; on *.pages.dev (Pages Functions) it works.
 */
export async function cached(ctx: Ctx, key: string, ttl: number, compute: () => Promise<Response>): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const req = new Request(`https://cache.tailtale.internal/${key}`);
  if (cache) {
    const hit = await cache.match(req);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("x-cache", "HIT");
      return r;
    }
  }
  let res: Response;
  try {
    res = await compute();
  } catch (e) {
    // Remember "not found" briefly so repeated misses don't hit the upstream; rethrow real failures.
    if (e instanceof ApiError && e.status === 404) res = errorResponse(e);
    else throw e;
  }
  if (cache && (res.ok || res.status === 404)) {
    const store = new Response(res.clone().body, res);
    store.headers.set("cache-control", `public, max-age=${res.ok ? ttl : Math.min(ttl, 3600)}`);
    ctx.waitUntil(cache.put(req, store));
  }
  const out = new Response(res.body, res);
  out.headers.set("x-cache", "MISS");
  return out;
}
