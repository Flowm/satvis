import { defineStore } from "pinia";

export const useCesiumStore = defineStore("cesium", {
  state: () => ({
    layers: ["OfflineHighres"],
    terrainProvider: "None",
    sceneMode: "3D",
    cameraMode: "Fixed",
  }),
  actions: {
  },
  urlsync: {
    enabled: true,
    config: [{
      name: "layers",
      url: "layers",
      serialize: (v) => v.join(","),
      deserialize: (v) => v.split(",").filter((e) => e),
      default: ["OfflineHighres"],
    }],
  },
});
