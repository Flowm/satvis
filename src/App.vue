<template>
  <div class="wrapper">
    <div id="toolbarLeft">
      <div class="toolbarButtons">
        <button type="button" class="cesium-button cesium-toolbar-button" v-on:click="toggleMenu('cat')">
          <span class="icon fill-parent">
            <i class="svg-sat"></i>
          </span>
        </button>
        <button type="button" class="cesium-button cesium-toolbar-button" v-on:click="toggleMenu('sat')">
          <span class="icon fill-parent">
            <i class="fas fa-layer-group fa-2x"></i>
          </span>
        </button>
        <button type="button" class="cesium-button cesium-toolbar-button" v-on:click="toggleMenu('gs')">
          <span class="icon fill-parent">
            <i class="svg-groundstation"></i>
          </span>
        </button>
        <button type="button" class="cesium-button cesium-toolbar-button" v-on:click="toggleMenu('map')">
          <span class="icon fill-parent">
            <i class="fas fa-globe-africa fa-2x"></i>
          </span>
        </button>
        <button type="button" class="cesium-button cesium-toolbar-button" v-on:click="toggleMenu('ios')" v-if="isIOS">
          <span class="icon fill-parent">
            <i class="fas fa-mobile-alt fa-2x"></i>
          </span>
        </button>
        <button type="button" class="cesium-button cesium-toolbar-button" v-on:click="toggleMenu('dbg')">
          <span class="icon fill-parent">
            <i class="fas fa-hammer fa-fw mfa-button-width"></i>
          </span>
        </button>
      </div>
      <div class="toolbarSwitches" v-show="menu.cat">
        <div class="toolbarTitle">Tracked satellite</div>
        <div class="toolbarContent">
          <satellite-select />
        </div>
        <div class="toolbarTitle">Enabled satellites</div>
        <div class="toolbarContent">
          <satellite-multi-select />
        </div>
        <div class="toolbarTitle">Monitored satellites</div>
        <div class="toolbarContent">
          <satellite-notify-multi-select />
        </div>
      </div>
      <div class="toolbarSwitches" v-show="menu.sat">
        <div class="toolbarTitle">Satellite</div>
        <label class="toolbarSwitch" v-for="componentName in cc.sats.components">
          <input type="checkbox" :value="componentName" v-model="enabledComponents"/>
          <span class="slider"></span>
          {{ componentName }}
        </label>
        <label class="toolbarSwitch">
          <input type="button" v-on:click="cc.viewer.trackedEntity = undefined" />
          Untrack Entity
        </label>
      </div>
      <div class="toolbarSwitches" v-show="menu.gs">
        <div class="toolbarTitle">Ground station</div>
        <label class="toolbarSwitch">
          <input type="checkbox" v-model="groundStationPicker.enabled" />
          <span class="slider"></span>
          Pick on globe
        </label>
        <label class="toolbarSwitch">
          <input type="button" v-on:click="cc.setGroundStationFromGeolocation()" />
          Set from geolocation
        </label>
        <label class="toolbarSwitch">
          <input type="button" v-on:click="cc.sats.focusGroundStation()" />
          Focus
        </label>
      </div>
      <div class="toolbarSwitches" v-show="menu.map">
        <div class="toolbarTitle">View</div>
        <label class="toolbarSwitch" v-for="name in cc.sceneModes">
          <input type="radio" v-model="sceneMode" :value=name />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle">Imagery</div>
        <label class="toolbarSwitch" v-for="(name, key) in cc.imageryProviders">
          <input type="radio" v-model="imageryProvider" :value=key />
          <span class="slider"></span>
          {{ name }}
        </label>
      </div>
      <div class="toolbarSwitches" v-show="menu.ios">
        <div class="toolbarTitle">Mobile</div>
        <label class="toolbarSwitch">
          <input type="checkbox" v-model="cc.viewer.scene.useWebVR" />
          <span class="slider"></span>
          VR
        </label>
        <label class="toolbarSwitch">
          <input type="checkbox" v-model="cc.viewer.clock.shouldAnimate" />
          <span class="slider"></span>
          Play
        </label>
        <label class="toolbarSwitch">
          <input type="button" v-on:click="cc.viewer.clockViewModel.multiplier *= 2" />
          Increase simulation speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" v-on:click="cc.viewer.clockViewModel.multiplier /= 2" />
          Decrease simulation speed
        </label>
      </div>
      <div class="toolbarSwitches" v-show="menu.dbg">
        <div class="toolbarTitle">Debug</div>
        <label class="toolbarSwitch">
          <input type="checkbox" v-model="cc.viewer.scene.debugShowFramesPerSecond" />
          <span class="slider"></span>
          FPS
        </label>
        <label class="toolbarSwitch">
          <input type="checkbox" v-model="cc.viewer.scene.requestRenderMode" />
          <span class="slider"></span>
          RequestRender
        </label>
        <label class="toolbarSwitch">
          <input type="checkbox" v-model="cc.viewer.scene.fog.enabled" />
          <span class="slider"></span>
          Fog
        </label>
        <label class="toolbarSwitch">
          <input type="checkbox" v-model="cc.viewer.scene.globe.enableLighting" />
          <span class="slider"></span>
          Lighting
        </label>
        <label class="toolbarSwitch">
          <input type="checkbox" v-model="cc.viewer.scene.globe.showGroundAtmosphere" />
          <span class="slider"></span>
          Atmosphere
        </label>
      </div>
    </div>
    <div id="toolbarRight">
      <a class="cesium-button cesium-toolbar-button" href="https://github.com/Flowm/satvis/">
        <span class="icon fill-parent">
          <i class="fab fa-github fa-2x"></i>
        </span>
      </a>
    </div>
  </div>
</template>

<script>
import Vue from "vue";
import Buefy from "buefy";
import SatelliteSelect from "./components/SatelliteSelect.vue";
import SatelliteMultiSelect from "./components/SatelliteMultiSelect.vue";
import SatelliteNotifyMultiSelect from "./components/SatelliteNotifyMultiSelect.vue";
import VueCesiumController from "./components/VueCesiumController.js";
Vue.use(Buefy);
Vue.use(VueCesiumController); /* global cc */

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
  components: {
    "satellite-select": SatelliteSelect,
    "satellite-multi-select": SatelliteMultiSelect,
    "satellite-notify-multi-select": SatelliteNotifyMultiSelect,
  },
  data() {
    return {
      menu: {
        cat: false,
        sat: false,
        gs: false,
        map: false,
        ios: false,
        dbg: false,
      },
      imageryProvider: "offline",
      sceneMode: "3D",
      isIOS: cc.isIOS,
      groundStationPicker: cc.groundStationPicker,
      enabledComponents: cc.sats.enabledComponents,
    }},
  watch: {
    imageryProvider: function(newProvider) {
      cc.setImageryProvider = newProvider;
    },
    sceneMode: function(newMode) {
      cc.setSceneMode = newMode;
    },
    enabledComponents: function(newComponents, oldComponents) {
      let add = newComponents.filter(x => !oldComponents.includes(x));
      for (let component of add) {
        cc.sats.enableComponent(component);
      }
      let del = oldComponents.filter(x => !newComponents.includes(x));
      for (let component of del) {
        cc.sats.disableComponent(component);
      }
    },
  },
  methods: {
    toggleMenu: function(name) {
      const oldState = this.menu[name];
      Object.keys(this.menu).forEach(k => this.menu[k] = false);
      this.menu[name] = !oldState;
    },
  },
};
</script>
