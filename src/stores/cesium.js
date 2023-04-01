import { defineStore } from "pinia";

export const useCesiumStore = defineStore("cesium", {
  state: () => ({
    layers: ["OfflineHighres"],
    terrainProvider: "None",
    sceneMode: "3D",
    cameraMode: "Fixed",
    qualityPreset: "low",
    background: true,
    showFps: false,
    pickMode: false,
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
      url: "scene",
      default: "3D",
    }, {
      name: "cameraMode",
      url: "camera",
      default: "Fixed",
    }, {
      name: "qualityPreset",
      url: "quality",
      default: "low",
    }, {
      name: "showFps",
      url: "fps",
      default: "false",
    }, {
      name: "background",
      url: "bg",
      serialize: (v) => `${v}`,
      deserialize: (v) => v === "true",
      default: "true",
    }],
  },
});
