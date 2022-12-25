<template>
  <div class="app">
    <router-view />
  </div>
</template>

<script>
// Font awesome setup
import { library, dom } from "@fortawesome/fontawesome-svg-core";
import { faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faEye, faRedo, faInfo, faBell } from "@fortawesome/free-solid-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";

import "@cesium/widgets/Source/widgets.css";
import "./css/main.css";

library.add(faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faEye, faRedo, faInfo, faBell, faGithub);
dom.watch();

export default {
};
</script>
