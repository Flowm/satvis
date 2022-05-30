<template>
  <div class="cesium">
    <div v-if="showUI" id="toolbarLeft">
      <div class="toolbarButtons">
        <o-tooltip label="Satellite selection" :triggers="tooltipTriggers" position="right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('cat')">
            <span class="icon-container">
              <i class="svg-sat"></i>
            </span>
          </button>
        </o-tooltip>
        <o-tooltip label="Satellite elements" :triggers="tooltipTriggers" position="right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('sat')">
            <span class="icon-container">
              <i class="fas fa-layer-group fa-fw"></i>
            </span>
          </button>
        </o-tooltip>
        <o-tooltip label="Ground station" :triggers="tooltipTriggers" position="right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('gs')">
            <span class="icon-container">
              <i class="svg-groundstation"></i>
            </span>
          </button>
        </o-tooltip>
        <o-tooltip label="Map" :triggers="tooltipTriggers" position="right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('map')">
            <span class="icon-container">
              <i class="fas fa-globe-africa fa-fw"></i>
            </span>
          </button>
        </o-tooltip>
        <o-tooltip v-if="cc.minimalUI" label="Mobile" :triggers="tooltipTriggers" position="right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('ios')">
            <span class="icon-container">
              <i class="fas fa-mobile-alt fa-fw"></i>
            </span>
          </button>
        </o-tooltip>
        <o-tooltip label="Debug" :triggers="tooltipTriggers" position="right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('dbg')">
            <span class="icon-container">
              <i class="fas fa-hammer fa-fw"></i>
            </span>
          </button>
        </o-tooltip>
      </div>
      <div v-show="menu.cat" class="toolbarSwitches">
        <div class="toolbarTitle">
          Tracked satellite
        </div>
        <div class="toolbarContent">
          <satellite-select ref="SatelliteSelect" />
        </div>
        <div class="toolbarTitle">
          Enabled satellites
        </div>
        <div class="toolbarContent">
          <satellite-multi-select ref="SatelliteMultiSelect" />
        </div>
        <div class="toolbarTitle">
          Monitored satellites
        </div>
        <div class="toolbarContent">
          <satellite-notify-multi-select ref="SatelliteNotifyMultiSelect" />
        </div>
      </div>
      <div v-show="menu.sat" class="toolbarSwitches">
        <div class="toolbarTitle">
          Satellite elements
        </div>
        <label v-for="componentName in cc.sats.components" :key="componentName" class="toolbarSwitch">
          <input v-model="enabledComponents" type="checkbox" :value="componentName">
          <span class="slider"></span>
          {{ componentName }}
        </label>
        <!--
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.trackedEntity = undefined">
          Untrack Entity
        </label>
        -->
      </div>
      <div v-show="menu.gs" class="toolbarSwitches">
        <div class="toolbarTitle">
          Ground station
        </div>
        <label class="toolbarSwitch">
          <input v-model="groundStationPicker.enabled" type="checkbox">
          <span class="slider"></span>
          Pick on globe
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.setGroundStationFromGeolocation()">
          Set from geolocation
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.sats.focusGroundStation()">
          Focus
        </label>
      </div>
      <div v-show="menu.map" class="toolbarSwitches">
        <div class="toolbarTitle">
          Layers
        </div>
        <label v-for="name in cc.imageryProviderNames" :key="name" class="toolbarSwitch">
          <input v-model="layers" type="checkbox" :value="name">
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle">
          Terrain
        </div>
        <label v-for="name in cc.terrainProviders" :key="name" class="toolbarSwitch">
          <input v-model="terrainProvider" type="radio" :value="name">
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle">
          View
        </div>
        <label v-for="name in cc.sceneModes" :key="name" class="toolbarSwitch">
          <input v-model="sceneMode" type="radio" :value="name">
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle">
          Camera
        </div>
        <label v-for="name in cc.cameraModes" :key="name" class="toolbarSwitch">
          <input v-model="cameraMode" type="radio" :value="name">
          <span class="slider"></span>
          {{ name }}
        </label>
      </div>
      <div v-show="menu.ios" class="toolbarSwitches">
        <div class="toolbarTitle">
          Mobile
        </div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.useWebVR" type="checkbox">
          <span class="slider"></span>
          VR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.clock.shouldAnimate" type="checkbox">
          <span class="slider"></span>
          Play
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier *= 2">
          Increase play speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier /= 2">
          Decrease play speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="$router.go({path: '', force: true})">
          Reload
        </label>
      </div>
      <div v-show="menu.dbg" class="toolbarSwitches">
        <div class="toolbarTitle">
          Debug
        </div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.debugShowFramesPerSecond" type="checkbox">
          <span class="slider"></span>
          FPS
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.requestRenderMode" type="checkbox">
          <span class="slider"></span>
          RequestRender
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.fog.enabled" type="checkbox">
          <span class="slider"></span>
          Fog
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.enableLighting" type="checkbox">
          <span class="slider"></span>
          Lighting
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.highDynamicRange" type="checkbox">
          <span class="slider"></span>
          HDR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.showGroundAtmosphere" type="checkbox">
          <span class="slider"></span>
          Atmosphere
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.jumpTo('Everest')">
          Jump to Everest
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.jumpTo('HalfDome')">
          Jump to HalfDome
        </label>
      </div>
    </div>
    <div id="toolbarRight">
      <o-tooltip v-if="showUI" label="Github" :triggers="tooltipTriggers" position="left">
        <a class="cesium-button cesium-toolbar-button" href="https://github.com/Flowm/satvis/" target="_blank" rel="noopener">
          <span class="icon-container">
            <i class="fab fa-github fa-fw"></i>
          </span>
        </a>
      </o-tooltip>
      <o-tooltip label="Toggle UI" :triggers="tooltipTriggers" position="left">
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleUI">
          <span class="icon-container">
            <i class="fas fa-eye fa-fw"></i>
          </span>
        </button>
      </o-tooltip>
    </div>
  </div>
</template>

<script>
import Vue from "vue";
import { Tooltip } from "@oruga-ui/oruga-next";
import { mapWritableState } from "pinia";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";

import SatelliteSelect from "./SatelliteSelect.vue";
import SatelliteMultiSelect from "./SatelliteMultiSelect.vue";
import SatelliteNotifyMultiSelect from "./SatelliteNotifyMultiSelect.vue";
import { DeviceDetect } from "../modules/util/DeviceDetect";

Vue.use(Tooltip);

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
      showUI: true,
      groundStationPicker: cc.groundStationPicker,
      tooltipTriggers: DeviceDetect.canHover() ? ["hover"] : ["contextmenu"],
    };
  },
  computed: {
    ...mapWritableState(useCesiumStore, [
      "layers",
      "terrainProvider",
      "sceneMode",
      "cameraMode",
    ]),
    ...mapWritableState(useSatStore, [
      "enabledComponents",
    ]),
  },
  watch: {
    layers(newLayers, oldLayers) {
      // Ensure only a single base layer is active
      const newBaseLayers = newLayers.filter((layer) => cc.baseLayers.includes(layer));
      if (newBaseLayers.length > 1) {
        const oldBaseLayers = oldLayers.filter((layer) => cc.baseLayers.includes(layer));
        this.layers = newBaseLayers.filter((layer) => !oldBaseLayers.includes(layer));
        return;
      }
      cc.imageryLayers = newLayers;
    },
    terrainProvider(newProvider) {
      cc.terrainProvider = newProvider;
      if (this.$route.query.terrain !== newProvider) {
        this.$router.push({ query: { ...this.$route.query, terrain: newProvider } });
      }
    },
    sceneMode(newMode) {
      cc.sceneMode = newMode;
    },
    cameraMode(newMode) {
      cc.cameraMode = newMode;
    },
    enabledComponents(newComponents) {
      cc.sats.enabledComponents = newComponents;
    },
  },
  mounted() {
    if (this.$route.query.bg) {
      cc.enableTransparency();
    }
    if (this.$route.query.gs) {
      cc.setGroundStationFromLatLon(this.$route.query.gs);
    }
    if (this.$route.query.terrain) {
      this.terrainProvider = this.$route.query.terrain;
    }
    if (this.$route.query.tags) {
      const tags = this.$route.query.tags.split(",");
      cc.sats.enableTag(tags);
    }
    if (this.$route.query.elements) {
      const elements = this.$route.query.elements.replace(/-/g, " ").split(",");
      this.enabledComponents = elements;
    }
    if (this.$route.query.time) {
      cc.setTime(this.$route.query.time);
    }
    this.showUI = !cc.minimalUIAtStartup;
    this.$root.$on("updateCat", this.updateCat);
  },
  beforeUnmount() {
    this.$root.$off("updateCat", this.updateCat);
  },
  methods: {
    toggleMenu(name) {
      const oldState = this.menu[name];
      Object.keys(this.menu).forEach((k) => {
        this.menu[k] = false;
      });
      this.menu[name] = !oldState;

      if (this.menu.cat) {
        // Update multiselect data when it is displayed
        this.updateCat();
      }
    },
    toggleUI() {
      this.showUI = !this.showUI;
      if (!cc.minimalUI) {
        cc.showUI = this.showUI;
      }
    },
    updateCat() {
      this.$refs.SatelliteSelect.update();
      this.$refs.SatelliteMultiSelect.update();
      this.$refs.SatelliteNotifyMultiSelect.update();
    },
  },
};
</script>
