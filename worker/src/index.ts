import { handleApi } from "./gp/api.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const apiResponse = await handleApi(request, env);
    if (apiResponse !== null) {
      return apiResponse;
    }
    // run_worker_first covers only /api/*, so the asset router already declined this path.
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
