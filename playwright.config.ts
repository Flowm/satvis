import { defineConfig } from "@playwright/test";

/** Away from Vite's default 5173, so a running `pnpm dev` is never reused by accident. */
const PORT = 5199;

export default defineConfig({
  testDir: "e2e",
  // One Cesium scene saturates a core under SwiftShader; parallel workers only slow each other.
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // A GitHub runner draws 1000×800 at about a frame a second and 640×400 twice as fast.
    // Specs that measure layout set their own.
    viewport: { width: 640, height: 400 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      // What a GPU-less CI runner gets. Chrome only falls back to SwiftShader with this flag.
      name: "swiftshader",
      use: { launchOptions: { args: ["--enable-unsafe-swiftshader"] } },
    },
    {
      // Full Chromium in new headless mode on the local GPU.
      name: "gpu",
      use: { channel: "chromium", launchOptions: { args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] } },
    },
  ],
  webServer: {
    command: "pnpm exec vite --strictPort",
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
