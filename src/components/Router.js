import { createRouter, createWebHistory } from "vue-router";
import Cesium from "./Cesium.vue";

export default createRouter({
  history: createWebHistory(document.location.pathname.match(".*/")[0]),
  routes: [
    { path: "/", component: Cesium },
    { path: "/move.html", component: Cesium },
    { path: "/ot.html", component: Cesium },
  ],
});
