import { defineStore } from "pinia";

export const useSatStore = defineStore("sat", {
  state: () => ({
    enabledComponents: ["Point", "Label"],
    availableSatellitesByTag: [],
    availableTags: [],
    enabledSatellites: [],
    enabledTags: [],
  }),
  urlsync: {
    enabled: true,
    config: [{
      name: "enabledComponents",
      url: "elements",
      serialize: (v) => v.join(",").replaceAll(" ", "-"),
      deserialize: (v) => v.replaceAll("-", " ").split(",").filter((e) => e),
      default: ["Point", "Label"],
    }, {
      name: "enabledSatellites",
      url: "sats",
      serialize: (v) => v.join(",").replaceAll(" ", "~"),
      deserialize: (v) => v.replaceAll("~", " ").split(",").filter((e) => e),
      default: [],
    }, {
      name: "enabledTags",
      url: "tags",
      serialize: (v) => v.join(",").replaceAll(" ", "-"),
      deserialize: (v) => v.replaceAll("-", " ").split(",").filter((e) => e),
      default: [],
    }],
  },
});
