import { defineStore } from "pinia";

export const useSatStore = defineStore("sat", {
  state: () => ({
    enabledComponents: cc.sats.enabledComponents,
  }),
  actions: {
  },
});
