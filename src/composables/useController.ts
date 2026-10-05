// `window.cc` is a console handle only; nothing in the app reads it.

import { inject, type InjectionKey } from "vue";

import type { CesiumController } from "../modules/CesiumController";

export const controllerKey: InjectionKey<CesiumController> = Symbol("cesiumController");

/** Throws, because a component outside the provide is a wiring mistake. */
export function useController(): CesiumController {
  const cc = inject(controllerKey);
  if (!cc) {
    throw new Error("No CesiumController provided — app.ts must provide(controllerKey, cc) before mounting.");
  }
  return cc;
}
