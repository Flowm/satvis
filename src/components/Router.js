import Vue from "vue";
import Router from "vue-router";
import Cesium from "./Cesium.vue";

Vue.use(Router);

export default new Router({
  routes: [
    {
      path: "/",
      component: Cesium,
    },
  ]
});
