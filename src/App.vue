<template>
  <div class="app">
    <router-view />
  </div>
</template>

<script>
// Font awesome setup
import { library, dom } from "@fortawesome/fontawesome-svg-core";
import { faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faRedo, faBell } from "@fortawesome/free-solid-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";
library.add(faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faRedo, faBell, faGithub);
dom.watch();

import "buefy/dist/buefy.css";
import "cesium/Widgets/widgets.css";
import "./css/main.css";

export default {
};
</script>
