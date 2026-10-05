import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const emptyAssets = path.join(path.dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "empty-assets");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["GP_KV"],
        // Stands in for the REFRESH_TOKEN secret, which wrangler.jsonc does not carry.
        bindings: { REFRESH_TOKEN: "test-refresh-token" },
        // ../dist may hold local-only models over the Workers asset size limit.
        assets: { directory: emptyAssets },
      },
    }),
  ],
});
