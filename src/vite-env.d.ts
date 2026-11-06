/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { CesiumController } from "@/modules/CesiumController";

declare global {
  const __BUILD_DATE__: string;
  const __BUILD_SHA__: string;
  /** Deepest base map level this build can serve: 2 or 5. Decided in vite.config.ts. */
  const __IMAGERY_MAX_LEVEL__: number;
  // eslint-disable-next-line no-var
  var cc: CesiumController;
}
