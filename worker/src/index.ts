import { handleRequest, handleScheduled } from "./app";
import type { Env } from "./types";

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(req, env, ctx);
  },
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(handleScheduled(event.cron, env));
  },
} satisfies ExportedHandler<Env>;
