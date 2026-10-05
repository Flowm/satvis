// Toasts for plain classes such as CesiumController, which have no `useToast`.

import type { useToast } from "@nuxt/ui/composables/useToast";

type ToastApi = ReturnType<typeof useToast>;
type ToastMessage = Parameters<ToastApi["add"]>[0];

let toast: ToastApi | null = null;

export const initToastProxy = (t: ToastApi): ToastApi => (toast = t);

// The fallback only warns: every toast follows a user action, long after App.vue mounts.
export const useToastProxy = (): ToastApi | { add: (message: ToastMessage) => void } => toast ?? { add: () => console.warn("Toast not initialized") };
