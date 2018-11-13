<template>
  <div class="cesium">
    <div id="toolbarLeft">
      <div class="toolbarButtons">
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('cat')">
          <span class="icon fill-parent">
            <i class="svg-sat" />
          </span>
        </button>
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('sat')">
          <span class="icon fill-parent">
            <i class="fas fa-layer-group fa-2x" />
          </span>
        </button>
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('gs')">
          <span class="icon fill-parent">
            <i class="svg-groundstation" />
          </span>
        </button>
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('map')">
          <span class="icon fill-parent">
            <i class="fas fa-globe-africa fa-2x" />
          </span>
        </button>
        <button v-if="cc.isIOS" type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('ios')">
          <span class="icon fill-parent">
            <i class="fas fa-mobile-alt fa-2x" />
          </span>
        </button>
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('dbg')">
          <span class="icon fill-parent">
            <i class="fas fa-hammer fa-fw mfa-button-width" />
          </span>
        </button>
      </div>
      <div v-show="menu.cat" class="toolbarSwitches">
        <div class="toolbarTitle">Tracked satellite</div>
        <div class="toolbarContent">
          <satellite-select ref="SatelliteSelect" />
        </div>
        <div class="toolbarTitle">Enabled satellites</div>
        <div class="toolbarContent">
          <satellite-multi-select ref="SatelliteMultiSelect" />
        </div>
        <div class="toolbarTitle">Monitored satellites</div>
        <div class="toolbarContent">
          <satellite-notify-multi-select ref="SatelliteNotifyMultiSelect" />
        </div>
      </div>
      <div v-show="menu.sat" class="toolbarSwitches">
        <div class="toolbarTitle">Satellite</div>
        <label v-for="componentName in cc.sats.components" :key="componentName" class="toolbarSwitch">
          <input v-model="enabledComponents" type="checkbox" :value="componentName">
          <span class="slider" />
          {{ componentName }}
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.trackedEntity = undefined">
          Untrack Entity
        </label>
      </div>
      <div v-show="menu.gs" class="toolbarSwitches">
        <div class="toolbarTitle">Ground station</div>
        <label class="toolbarSwitch">
          <input v-model="cc.groundStationPicker.enabled" type="checkbox">
          <span class="slider" />
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
        <div class="toolbarTitle">View</div>
        <label v-for="name in cc.sceneModes" :key="name" class="toolbarSwitch">
          <input v-model="sceneMode" type="radio" :value="name">
          <span class="slider" />
          {{ name }}
        </label>
        <div class="toolbarTitle">Imagery</div>
        <label v-for="(name, key) in cc.imageryProviders" :key="name" class="toolbarSwitch">
          <input v-model="imageryProvider" type="radio" :value="key">
          <span class="slider" />
          {{ name }}
        </label>
      </div>
      <div v-show="menu.ios" class="toolbarSwitches">
        <div class="toolbarTitle">Mobile</div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.useWebVR" type="checkbox">
          <span class="slider" />
          VR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.clock.shouldAnimate" type="checkbox">
          <span class="slider" />
          Play
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier *= 2">
          Increase simulation speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier /= 2">
          Decrease simulation speed
        </label>
      </div>
      <div v-show="menu.dbg" class="toolbarSwitches">
        <div class="toolbarTitle">Debug</div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.debugShowFramesPerSecond" type="checkbox">
          <span class="slider" />
          FPS
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.requestRenderMode" type="checkbox">
          <span class="slider" />
          RequestRender
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.fog.enabled" type="checkbox">
          <span class="slider" />
          Fog
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.enableLighting" type="checkbox">
          <span class="slider" />
          Lighting
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.showGroundAtmosphere" type="checkbox">
          <span class="slider" />
          Atmosphere
        </label>
      </div>
    </div>
    <div id="toolbarRight">
      <a class="cesium-button cesium-toolbar-button" href="https://github.com/Flowm/satvis/">
        <span class="icon fill-parent">
          <i class="fab fa-github fa-2x" />
        </span>
      </a>
    </div>
  </div>
</template>

<script>
import Vue from "vue";
import Buefy from "buefy";
import SatelliteSelect from "./SatelliteSelect.vue";
import SatelliteMultiSelect from "./SatelliteMultiSelect.vue";
import SatelliteNotifyMultiSelect from "./SatelliteNotifyMultiSelect.vue";
import VueCesiumController from "./VueCesiumController.js";
Vue.use(Buefy);
Vue.use(VueCesiumController); /* global cc */

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
      enabledComponents: cc.sats.enabledComponents,
    };
  },
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
  mounted() {
    if (this.$route.query.sat) {
      cc.sats.trackedSatellite = this.$route.query.sat;
    }
    this.$root.$on("updateCat", this.updateCat);
  },
  beforeDestroy () {
    this.$root.$off("updateCat", this.updateCat);
  },
  methods: {
    toggleMenu: function(name) {
      const oldState = this.menu[name];
      Object.keys(this.menu).forEach(k => this.menu[k] = false);
      this.menu[name] = !oldState;

      if (this.menu.cat) {
        // Update multiselect data when it is displayed
        this.updateCat();
      }
    },
    updateCat: function() {
      this.$refs.SatelliteSelect.update();
      this.$refs.SatelliteMultiSelect.update();
      this.$refs.SatelliteNotifyMultiSelect.update();
    },
  },
};
</script>
