import { defineStore } from "pinia";

export const useSatStore = defineStore("sat", {
  state: () => ({
    enabledComponents: ["Point", "Label"],
  }),
  urlsync: {
    enabled: true,
    config: [{
      name: "enabledComponents",
      url: "elements",
      serialize: (v) => v.join(",").replaceAll(" ", "-"),
      deserialize: (v) => v.replaceAll("-", " ").split(",").filter((e) => e),
      default: ["Point", "Label"],
    }],
  },
});
