import { defineStore } from "pinia";

export const useCesiumStore = defineStore("cesium", {
  state: () => ({
    layers: ["OfflineHighres"],
    terrainProvider: "None",
    sceneMode: "3D",
    cameraMode: "Fixed",
  }),
  urlsync: {
    enabled: true,
    config: [{
      name: "layers",
      url: "layers",
      serialize: (v) => v.join(","),
      deserialize: (v) => v.split(",").filter((e) => e),
      default: ["OfflineHighres"],
    }, {
      name: "terrainProvider",
      url: "terrain",
      default: "None",
    }, {
      name: "sceneMode",
      url: "mode",
      default: "3D",
    }],
  },
});
