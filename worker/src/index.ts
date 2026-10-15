import { handleRequest, handleScheduled } from "./app";
import type { Env } from "./types";

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(req, env, ctx);
  },
  // Await the work directly: a cron handler may run for minutes, but work left to ctx.waitUntil()
  // is cut off 30 s after the handler returns, which a polite, rate-limited pass over 10 types can exceed.
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await handleScheduled(event.cron, env);
  },
} satisfies ExportedHandler<Env>;
