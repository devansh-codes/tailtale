// Same API as the standalone Worker (worker/src/app.ts), served same-origin from Pages.
// On *.pages.dev the Cache API works (it is a no-op on *.workers.dev), and no CORS is needed.
import { handleRequest } from "../../../worker/src/app";
import type { Env } from "../../../worker/src/types";

export const onRequest: PagesFunction<Env> = (ctx) => handleRequest(ctx.request, ctx.env, ctx);
