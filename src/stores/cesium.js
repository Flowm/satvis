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
})
