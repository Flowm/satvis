import { defineStore } from "pinia";

export const useSatStore = defineStore("sat", {
  state: () => ({
    enabledComponents: ["Point", "Label"],
    availableTags: [],
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
      name: "enabledTags",
      url: "tags",
      serialize: (v) => v.join(",").replaceAll(" ", "-"),
      deserialize: (v) => v.replaceAll("-", " ").split(",").filter((e) => e),
      default: [],
    }],
  },
});
