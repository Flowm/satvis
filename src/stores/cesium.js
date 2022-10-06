import { defineStore } from "pinia";

export const useCesiumStore = defineStore("cesium", {
  state: () => ({
    layers: ["OfflineHighres"],
    terrainProvider: "None",
    sceneMode: "3D",
    cameraMode: "Fixed",
    pickMode: false,
    background: true,
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
    }, {
      name: "background",
      url: "bg",
      serialize: (v) => `${v}`,
      deserialize: (v) => v === "true",
      default: "true",
    }],
  },
});
