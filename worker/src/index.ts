import { handleApi } from "./gp/api.ts";
import { refreshAll } from "./gp/refresh.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const apiResponse = await handleApi(request, env);
    if (apiResponse !== null) {
      return apiResponse;
    }
    // run_worker_first covers only /api/*, so the asset router already declined this path.
    return new Response("Not Found", { status: 404 });
  },

  /**
   * Not ctx.waitUntil(): it buys only ~30 s after the handler returns, and the
   * sequential refresh overruns that and is cancelled before it writes KV. An awaited
   * promise lives up to the 15-minute cron limit.
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await refreshAll(env);
  },
} satisfies ExportedHandler<Env>;
